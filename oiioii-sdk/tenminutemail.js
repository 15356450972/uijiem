const https = require('https');
const crypto = require('crypto');

const SITE_HOST = '10minutemail.one';
const API_HOST = 'web.10minutemail.one';
const EMAIL_DOMAINS = ['xghff.com', 'oqqaj.com', 'psovv.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const sessionCache = new Map();
let tokenCache = { token: '', expiresAt: 0 };

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function requestUrl(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      timeout: options.timeout || 15000,
      headers: {
        'User-Agent': UA,
        ...options.headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', async () => {
        const data = Buffer.concat(chunks).toString('utf8');
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location && redirectCount < 3) {
          try {
            const nextUrl = new URL(location, url).toString();
            const redirected = await requestUrl(nextUrl, options, redirectCount + 1);
            resolve(redirected);
          } catch (error) {
            reject(error);
          }
          return;
        }
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, data, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`10MinuteMail request timeout after ${options.timeout || 15000}ms`)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function randomLocalPart() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = 10;
  let value = '';
  for (let i = 0; i < length; i++) value += chars[Math.floor(Math.random() * chars.length)];
  return value;
}

function randomEmail() {
  const domain = EMAIL_DOMAINS[Math.floor(Math.random() * EMAIL_DOMAINS.length)];
  return `${randomLocalPart()}@${domain}`;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function getToken(force = false) {
  const now = Date.now();
  if (!force && tokenCache.token && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const res = await requestUrl(`https://${SITE_HOST}/zh`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': `https://${SITE_HOST}/`
    },
    timeout: 20000
  });
  if (res.status !== 200) throw new Error(`10MinuteMail 首页访问失败: HTTP ${res.status}`);

  const match = res.data.match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  if (!match) throw new Error('10MinuteMail 未找到 JWT token');

  const token = match[0];
  const payload = decodeJwtPayload(token);
  tokenCache = {
    token,
    expiresAt: payload?.exp ? Number(payload.exp) * 1000 : now + 60 * 60 * 1000
  };
  return token;
}

function apiHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Request-ID': crypto.randomBytes(16).toString('hex'),
    'X-Timestamp': String(Math.floor(Date.now() / 1000)),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': `https://${SITE_HOST}`,
    'Referer': `https://${SITE_HOST}/`
  };
}

async function apiRequest(path, token, options = {}) {
  return requestUrl(`https://${API_HOST}${path}`, {
    method: options.method || 'GET',
    headers: apiHeaders(token),
    timeout: options.timeout || 15000,
    body: options.body
  });
}

async function createMailbox(options = {}) {
  const maxRetries = options.maxRetries || 3;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const token = await getToken(attempt > 0);
      const email = options.email || randomEmail();
      const encodedEmail = encodeURIComponent(email);
      const res = await apiRequest(`/api/v1/mailbox/${encodedEmail}`, token, { timeout: 12000 });
      if (res.status === 200 && Array.isArray(res.json)) {
        const session = { provider: '10minutemail', email, token, createdAt: Date.now() };
        sessionCache.set(email, session);
        console.log(`  [10minutemail] Email: ${email}`);
        return session;
      }
      lastError = new Error(`10MinuteMail 邮箱验证失败: HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
      await sleep(1000 + attempt * 1000);
    }
  }

  throw lastError || new Error('10MinuteMail 创建邮箱失败');
}

async function ensureSession(email) {
  const cached = sessionCache.get(email);
  if (cached?.token) return cached;
  return createMailbox({ email });
}

async function generateEmail() {
  console.log('[1/5] Generating 10MinuteMail email...');
  const session = await createMailbox();
  return session.email;
}

async function getMessages(email, session = null) {
  const active = session || await ensureSession(email);
  let res = await apiRequest(`/api/v1/mailbox/${encodeURIComponent(email)}`, active.token, { timeout: 12000 });
  if (res.status === 401 || res.status === 403) {
    active.token = await getToken(true);
    sessionCache.set(email, active);
    res = await apiRequest(`/api/v1/mailbox/${encodeURIComponent(email)}`, active.token, { timeout: 12000 });
  }
  if (res.status !== 200) throw new Error(`10MinuteMail 获取邮件失败: HTTP ${res.status}`);
  return Array.isArray(res.json) ? res.json : [];
}

async function getMessage(email, messageId, session = null) {
  const active = session || await ensureSession(email);
  const res = await apiRequest(`/api/v1/mailbox/${encodeURIComponent(email)}/messages/${encodeURIComponent(messageId)}`, active.token, { timeout: 12000 });
  if (res.status !== 200) return null;
  return res.json || null;
}

function normalizeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractVerification(message) {
  const subject = message?.subject || '';
  const body = message?.html || message?.body || message?.text || message?.content || message?.html_content || '';
  const content = normalizeHtml(`${subject}\n${body}`);
  const link = (
    content.match(/href=["'](https?:\/\/[^"']*(?:verify|confirm)[^"']*)["']/i) ||
    content.match(/href=["'](https?:\/\/[^"']*token=[^"']*)["']/i) ||
    content.match(/(https?:\/\/\S*(?:verify|confirm)\S*)/i) ||
    content.match(/(https?:\/\/\S*token=\S*)/i) ||
    []
  )[1];
  if (link) return { link: link.replace(/[)>.,;]+$/g, ''), mail: message, content };

  const code = (
    content.match(/verification code(?: is|:)\s*([A-Z0-9]{4,8})/i) ||
    content.match(/\b([A-Z0-9]{6})\b/) ||
    content.match(/\b(\d{4,6})\b/) ||
    []
  )[1];
  if (code) return { code, mail: message, content };
  return null;
}

async function waitForVerificationEmail(email, maxWait = 90000) {
  console.log('\n[4/5] Waiting for verification email via 10MinuteMail...');
  const session = await ensureSession(email);
  const start = Date.now();
  const seen = new Set();

  while (Date.now() - start < maxWait) {
    const messages = await getMessages(email, session);
    for (const message of messages) {
      const id = message.id || message.message_id || message.uid || `${message.from || ''}:${message.subject || ''}:${message.date || ''}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const detail = id && message.id ? await getMessage(email, message.id, session).catch(() => null) : null;
      const fullMessage = { ...message, ...(detail || {}) };
      console.log(`\n  Got email from: ${fullMessage.from || fullMessage.from_address || 'unknown'}`);
      console.log(`  Subject: ${fullMessage.subject || ''}`);

      const verification = extractVerification(fullMessage);
      if (verification) return verification;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`  Polling 10MinuteMail... (${elapsed}s)\r`);
    await sleep(2000);
  }

  throw new Error(`10MinuteMail 验证邮件超时（${maxWait / 1000}s）`);
}

async function cleanup(email) {
  const session = sessionCache.get(email);
  if (!session?.token) return { ok: false, skipped: true };
  const res = await apiRequest(`/api/v1/mailbox/${encodeURIComponent(email)}`, session.token, { method: 'DELETE', timeout: 10000 });
  sessionCache.delete(email);
  return { ok: res.status === 200 || res.status === 204, status: res.status };
}

module.exports = {
  EMAIL_DOMAINS,
  createMailbox,
  generateEmail,
  getMessages,
  getMessage,
  waitForVerificationEmail,
  extractVerification,
  cleanup,
  sleep
};