import { request, sleep } from './http.js';

export const DEFAULT_APPLE_MAIL_API_URL = 'https://apple.882263.xyz/api/mail-new';
const MAILBOXES = ['INBOX', 'Junk'];
const QUERY_EQUALS = '__OREATEAI_QUERY_EQUALS__';

const requiredString = (value, label) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
};

const normalizeApiUrl = (value) => {
  const url = new URL(String(value || DEFAULT_APPLE_MAIL_API_URL).trim());
  if (url.protocol !== 'https:') throw new Error('小苹果邮件 API 必须使用 HTTPS');
  return url.href;
};

export const createAppleMailbox = (credentials = {}, { requestFn = request } = {}) => ({
  email: requiredString(credentials.email, 'email'),
  clientId: requiredString(credentials.clientId ?? credentials.client_id, 'client_id'),
  refreshToken: requiredString(credentials.refreshToken ?? credentials.refresh_token, 'refresh_token'),
  apiUrl: normalizeApiUrl(
    credentials.apiUrl
      ?? credentials.api_url
      ?? process.env.OREATEAI_MAIL_API_URL
      ?? DEFAULT_APPLE_MAIL_API_URL,
  ),
  apiPassword: String(
    credentials.apiPassword
      ?? credentials.api_password
      ?? process.env.OREATEAI_MAIL_API_PASSWORD
      ?? '',
  ).trim(),
  requestFn,
});

const normalizeMessages = (payload, sourceMailbox) => {
  if (!payload) return [];
  const values = Array.isArray(payload) ? payload : [payload];
  return values
    .filter((item) => item && typeof item === 'object' && !item.error)
    .map((item) => ({ ...item, mailbox: sourceMailbox }));
};

const fetchLatestFromFolder = async (mailbox, sourceMailbox) => {
  const response = await mailbox.requestFn({
    url: mailbox.apiUrl,
    method: 'POST',
    timeout: 30_000,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      refresh_token: mailbox.refreshToken,
      client_id: mailbox.clientId,
      email: mailbox.email,
      mailbox: sourceMailbox,
      response_type: 'json',
      ...(mailbox.apiPassword ? { password: mailbox.apiPassword } : {}),
    },
  });
  if (response.status < 200 || response.status >= 300) {
    const detail = response.data?.error || `HTTP ${response.status}`;
    throw new Error(`${sourceMailbox} 取件失败：${String(detail).slice(0, 300)}`);
  }
  if (response.data?.error) {
    throw new Error(`${sourceMailbox} 取件失败：${String(response.data.error).slice(0, 300)}`);
  }
  return normalizeMessages(response.data, sourceMailbox);
};

export const listAppleEmails = async (mailbox) => {
  const results = await Promise.allSettled(
    MAILBOXES.map((sourceMailbox) => fetchLatestFromFolder(mailbox, sourceMailbox)),
  );
  const successful = results.filter((result) => result.status === 'fulfilled');
  if (successful.length === 0) {
    const errors = results
      .map((result) => result.reason?.message)
      .filter(Boolean)
      .join('；');
    throw new Error(`小苹果邮件 API 请求失败：${errors || 'unknown error'}`);
  }
  return successful.flatMap((result) => result.value);
};

const decodeQuotedPrintable = (value) => String(value ?? '')
  .replaceAll('&amp;', '&')
  .replace(/([?&][A-Za-z][A-Za-z0-9_-]*)=3D/gi, `$1${QUERY_EQUALS}`)
  .replace(/([?&][A-Za-z][A-Za-z0-9_-]*)=\r?\n[ \t]*/g, `$1${QUERY_EQUALS}`)
  .replace(/([?&][A-Za-z][A-Za-z0-9_-]*)=/g, `$1${QUERY_EQUALS}`)
  .replace(/=\r?\n/g, '')
  .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  .replaceAll(QUERY_EQUALS, '=');

const extractLinks = (value) => {
  const text = decodeQuotedPrintable(value);
  const hrefLinks = [...text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1].replace(/\s+/g, ''));
  const plainLinks = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const encodedLinks = text.match(/https?%3A%2F%2F[^\s"'<>]+/gi) ?? [];
  const decodedLinks = [...hrefLinks, ...encodedLinks].map((link) => {
    try { return decodeURIComponent(link); } catch { return link; }
  });
  return [...new Set([...plainLinks, ...decodedLinks]
    .map((link) => link.replace(/[),.;]+$/, '')))];
};

const collectStringValues = (value, depth = 0, seen = new Set()) => {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((item) => collectStringValues(item, depth + 1, seen));
};

const lastNonEmptyParam = (url, name) => url.searchParams.getAll(name)
  .map((value) => value.trim())
  .findLast(Boolean) || '';

const asVerificationUrl = (candidate, { hostPattern, expectedEmail }) => {
  try {
    const url = new URL(candidate);
    if (!hostPattern.test(url.hostname)) return null;
    const email = lastNonEmptyParam(url, 'email');
    const tokenID = lastNonEmptyParam(url, 'tokenID');
    if (!email || !tokenID) return null;
    if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()) return null;
    url.searchParams.set('email', email);
    url.searchParams.set('tokenID', tokenID);
    const isUuidToken = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tokenID);
    return { url: url.href, score: isUuidToken ? 3 : 2 };
  } catch {
    return null;
  }
};

export const extractAppleVerificationLink = (message, {
  expectedEmail = '',
  hostPattern = /(^|\.)oreateai\.com$/i,
} = {}) => {
  const source = collectStringValues(message).join('\n');
  const candidates = extractLinks(source)
    .map((candidate) => asVerificationUrl(candidate, { hostPattern, expectedEmail }))
    .filter((candidate) => candidate?.score > 0)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.url || '';
};

export const waitForAppleVerificationLink = async (mailbox, {
  timeout = 120_000,
  interval = 3_000,
  after = 0,
  hostPattern = /(^|\.)oreateai\.com$/i,
} = {}) => {
  const deadline = Date.now() + timeout;
  let emailsSeen = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const emails = await listAppleEmails(mailbox);
      emailsSeen = Math.max(emailsSeen, emails.length);
      for (const message of emails) {
        const receivedAt = Date.parse(message.date || message.receivedDateTime || '');
        if (after > 0 && Number.isFinite(receivedAt) && receivedAt < after) continue;
        const verificationUrl = extractAppleVerificationLink(message, {
          expectedEmail: mailbox.email,
          hostPattern,
        });
        if (verificationUrl) return verificationUrl;
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(interval);
  }
  throw new Error(
    `小苹果邮件验证超时（${timeout}ms，读取邮件 ${emailsSeen} 封${lastError ? `，最后错误：${lastError}` : ''}）`,
  );
};
