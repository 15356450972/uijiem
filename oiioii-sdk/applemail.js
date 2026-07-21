const https = require('https');

const DEFAULT_API_URL = 'https://apple.882263.xyz/api/mail-new';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function createMailbox(credentials = {}) {
  const apiUrl = new URL(
    credentials.api_url
      || credentials.apiUrl
      || process.env.OIIOII_MAIL_API_URL
      || DEFAULT_API_URL
  );
  if (apiUrl.protocol !== 'https:') throw new Error('小苹果邮件 API 必须使用 HTTPS');
  return {
    email: required(credentials.email, 'email'),
    client_id: required(credentials.client_id || credentials.clientId, 'client_id'),
    refresh_token: required(credentials.refresh_token || credentials.refreshToken, 'refresh_token'),
    api_url: apiUrl.href,
    api_password: String(credentials.api_password || process.env.OIIOII_MAIL_API_PASSWORD || '').trim(),
    created_at: Date.now()
  };
}

function postJson(url, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      timeout,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(String(data?.error || `HTTP ${res.statusCode || 0}`).slice(0, 300)));
          return;
        }
        if (data?.error) {
          reject(new Error(String(data.error).slice(0, 300)));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function listLatestEmails(mailbox) {
  const results = await Promise.allSettled(['INBOX', 'Junk'].map(async folder => {
    const payload = await postJson(mailbox.api_url, {
      refresh_token: mailbox.refresh_token,
      client_id: mailbox.client_id,
      email: mailbox.email,
      mailbox: folder,
      response_type: 'json',
      ...(mailbox.api_password ? { password: mailbox.api_password } : {})
    });
    const values = Array.isArray(payload) ? payload : payload ? [payload] : [];
    return values.map(item => ({ ...item, mailbox: folder }));
  }));
  const successful = results.filter(result => result.status === 'fulfilled');
  if (successful.length === 0) {
    throw new Error(results.map(result => result.reason?.message).filter(Boolean).join('；') || '取件失败');
  }
  return successful.flatMap(result => result.value);
}

function collectStrings(value, depth = 0, seen = new Set()) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap(item => collectStrings(item, depth + 1, seen));
}

function extractVerification(message) {
  const content = collectStrings(message).join('\n').replaceAll('&amp;', '&');
  const hrefs = [...content.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
  const plain = content.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const links = [...new Set([...hrefs, ...plain])];
  const link = links.find(candidate => {
    try {
      const url = new URL(candidate);
      return /(^|\.)oiioii\.ai$/i.test(url.hostname)
        && /verify|confirm|token/i.test(`${url.pathname}${url.search}`);
    } catch {
      return false;
    }
  });
  if (link) return { link, mail: message };
  const code = (content.match(/\b(\d{4,8})\b/) || [])[1];
  return code ? { code, mail: message } : null;
}

async function waitForVerificationEmail(mailbox, maxWait = 90000) {
  const deadline = Date.now() + maxWait;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const messages = await listLatestEmails(mailbox);
      for (const message of messages) {
        const receivedAt = Date.parse(message.date || message.receivedDateTime || '');
        if (Number.isFinite(receivedAt) && receivedAt < mailbox.created_at - 120000) continue;
        const verification = extractVerification(message);
        if (verification) return verification;
      }
    } catch (error) {
      lastError = error.message || String(error);
    }
    await sleep(3000);
  }
  throw new Error(`小苹果取件超时（${Math.round(maxWait / 1000)}s${lastError ? `，${lastError}` : ''}）`);
}

module.exports = {
  DEFAULT_API_URL,
  createMailbox,
  listLatestEmails,
  extractVerification,
  waitForVerificationEmail
};
