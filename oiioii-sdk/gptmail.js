const https = require('https');
const { createProxyAgent } = require('./rotating_proxy');

const GPTMAIL_HOST = 'mail.chatgpt.org.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- 底层 HTTPS 请求 ---

function gptmailRequest(path, options = {}, agent = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GPTMAIL_HOST,
      path,
      method: options.method || 'GET',
      agent: agent || undefined,
      timeout: options.timeout || 15000,
      headers: {
        'User-Agent': UA,
        ...options.headers
      }
    }, (res) => {
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, data: text, json, cookies });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`GPTMail request timeout after ${options.timeout || 15000}ms`)); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// --- 随机前缀 ---

function randomPrefix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8 + Math.floor(Math.random() * 4); i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

// --- 域名池（带 30 分钟缓存） ---

const FALLBACK_DOMAIN = 'ppoo.ccwu.cc';
const DOMAIN_TTL = 30 * 60 * 1000;
let _domainCache = null;
let _domainCacheAt = 0;

async function getValidDomains() {
  const now = Date.now();
  if (_domainCache && now - _domainCacheAt < DOMAIN_TTL) return _domainCache;

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await gptmailRequest('/api/domains/status', {
        headers: { 'Accept': 'application/json' },
        timeout: 20000
      });
      const list = (res.json?.data?.domains || [])
        .filter(d => d.mx_valid && d.is_active)
        .map(d => d.domain_name);
      if (list.length > 0) {
        _domainCache = list;
        _domainCacheAt = now;
        console.log(`  [domains] refreshed pool: ${list.length} valid domains`);
        return _domainCache;
      }
      throw new Error('empty domain list');
    } catch (e) {
      if (attempt < maxRetries - 1) {
        await sleep(1000 + attempt * 1000);
        continue;
      }
      console.log(`  [warn] fetch domains failed: ${e.message}, using cached/fallback`);
    }
  }
  return _domainCache || [FALLBACK_DOMAIN];
}

// --- 生成随机临时邮箱 ---

async function generateEmail() {
  console.log('[1/5] Generating random email...');
  const prefix = randomPrefix();
  const domains = await getValidDomains();
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const email = `${prefix}@${domain}`;
  console.log(`  Email: ${email}  (domain pool: ${domains.length})`);
  return email;
}

// --- 建立 GPTMail session ---

async function getFullBrowserCookies(email, agent = null) {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const pageRes = await gptmailRequest(`/zh/${email}`, {
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
      }, agent);

      const cookies = pageRes.cookies || [];
      const cookieStr = cookies.join('; ');
      const payload = JSON.stringify({ email });

      const tokenRes = await gptmailRequest('/api/inbox-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Cookie': cookieStr,
          'Referer': `https://${GPTMAIL_HOST}/zh/${email}`
        },
        body: payload
      }, agent);

      const json = tokenRes.json;
      if (json?.success && json?.auth?.token) {
        const result = cookies;
        result._inboxToken = json.auth.token;
        return result;
      }

      if (tokenRes.data && tokenRes.data.includes('Too many requests')) {
        if (attempt < maxRetries - 1) {
          await sleep(2000 + attempt * 2000);
          continue;
        }
      }
      throw new Error(`inbox-token failed: ${JSON.stringify(json || tokenRes.data).substring(0, 100)}`);
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
      await sleep(2000 + attempt * 2000);
    }
  }
  throw new Error('inbox-token failed after retries');
}

// --- 查询收件箱 ---

async function getEmailsWithCookies(email, allCookies, agent = null) {
  const cookieStr = allCookies.filter(c => c.startsWith('gm_sid')).join('; ');
  const res = await gptmailRequest(`/api/emails?email=${encodeURIComponent(email)}`, {
    headers: {
      'Cookie': cookieStr,
      'X-Inbox-Token': allCookies._inboxToken || '',
      'Accept': 'application/json',
      'Referer': `https://${GPTMAIL_HOST}/zh/${email}`
    }
  }, agent);
  return res.json || { success: false, error: (res.data || '').substring(0, 100) };
}

// --- 轮询收件箱并提取验证码 ---

async function waitForCode(email, maxWait = 90000, agent = null, preCookies = null) {
  console.log('\n[4/5] Waiting for verification code...');

  let allCookies = preCookies || await getFullBrowserCookies(email, agent);
  console.log(`  Got ${allCookies.length} cookies${preCookies ? ' (prebuilt)' : ''}`);

  const startTime = Date.now();
  let emptyCount = 0;
  const REBUILD_THRESHOLD = 10;

  while (Date.now() - startTime < maxWait) {
    const result = await getEmailsWithCookies(email, allCookies, agent);

    if (result?.success && result.data?.emails?.length > 0) {
      const mail = result.data.emails[0];
      console.log(`\n  Got email from: ${mail.from_address}`);
      console.log(`  Subject: ${mail.subject}`);

      const content = mail.content || mail.subject || '';
      const codeMatch = content.match(/\b(\d{4,6})\b/);
      if (codeMatch) {
        console.log(`  Verification code: ${codeMatch[1]}`);
        return codeMatch[1];
      }

      const subjMatch = (mail.subject || '').match(/(\d{4,6})/);
      if (subjMatch) {
        console.log(`  Verification code: ${subjMatch[1]}`);
        return subjMatch[1];
      }

      throw new Error('Could not extract verification code from email');
    }

    emptyCount++;

    if (emptyCount === REBUILD_THRESHOLD) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`\n  [session rebuild] ${emptyCount} empty polls in ${elapsed}s, rebuilding with fresh agent...`);
      try {
        if (agent) agent.destroy();
        agent = createProxyAgent();
        allCookies = await getFullBrowserCookies(email, agent);
        console.log(`  [session rebuild] OK, got ${allCookies.length} cookies (new IP)`);
        emptyCount = 0;
      } catch (e) {
        console.log(`  [session rebuild] failed: ${e.message}, continuing with old session`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`  Polling... (${elapsed}s)\r`);
    await sleep(1500);
  }

  throw new Error(`Timeout: no email received within ${maxWait / 1000}s`);
}

// --- 简化版直连接口（无代理） ---

function httpsRequestDirect(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GPTMAIL_HOST,
      port: 443,
      path,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...options.headers
      }
    }, (res) => {
      const cookies = res.headers['set-cookie'];
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, data: text, json, headers: res.headers, cookies });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getGptMailSession(email) {
  const pageRes = await httpsRequestDirect(`/zh/${email}`, {
    headers: { 'Accept': 'text/html' }
  });

  if (!pageRes.cookies || pageRes.cookies.length === 0) {
    throw new Error('GPTMail: no session cookie returned');
  }

  const cookie = pageRes.cookies[0].split(';')[0];

  const payload = JSON.stringify({ email });
  const tokenRes = await httpsRequestDirect('/api/inbox-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'Cookie': cookie
    },
    body: payload
  });

  if (!tokenRes.json?.success || !tokenRes.json?.auth?.token) {
    throw new Error(`GPTMail token failed: ${tokenRes.data.substring(0, 200)}`);
  }

  return {
    cookie,
    token: tokenRes.json.auth.token,
    email
  };
}

async function getEmails(session) {
  const res = await httpsRequestDirect(`/api/emails?email=${encodeURIComponent(session.email)}`, {
    headers: { 'Cookie': session.cookie }
  });
  return res.json;
}

async function getEmailDetail(session, emailId) {
  const res = await httpsRequestDirect(`/api/email/${emailId}`, {
    headers: { 'Cookie': session.cookie }
  });
  return res.json;
}

module.exports = {
  generateEmail,
  getValidDomains,
  getFullBrowserCookies,
  getEmailsWithCookies,
  waitForCode,
  getGptMailSession,
  getEmails,
  getEmailDetail,
  gptmailRequest,
  sleep
};
