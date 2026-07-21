import { request, CookieJar, sleep } from './http.js';

const BASE_URL = 'https://mail.chatgpt.org.uk';
const FALLBACK_DOMAIN = 'ppoo.ccwu.cc';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const DOMAIN_TTL = 30 * 60 * 1000;
let domainCache = null;
let domainCacheAt = 0;

const randomPrefix = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const length = 8 + Math.floor(Math.random() * 4);
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const mailRequest = (path, options = {}) => request({
  url: `${BASE_URL}${path}`,
  headers: { 'User-Agent': USER_AGENT, ...options.headers },
  ...options,
});

export const getValidDomains = async () => {
  if (domainCache && Date.now() - domainCacheAt < DOMAIN_TTL) return domainCache;
  const response = await mailRequest('/api/domains/status', {
    headers: { Accept: 'application/json' },
  });
  const domains = (response.data?.data?.domains ?? [])
    .filter((domain) => domain.mx_valid && domain.is_active)
    .map((domain) => domain.domain_name);
  domainCache = domains.length ? domains : [FALLBACK_DOMAIN];
  domainCacheAt = Date.now();
  return domainCache;
};

export const createMailbox = async () => {
  const domains = await getValidDomains();
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const email = `${randomPrefix()}@${domain}`;
  const jar = new CookieJar();
  const referer = `${BASE_URL}/zh/${email}`;

  await mailRequest(`/zh/${encodeURIComponent(email)}`, {
    jar,
    headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  const tokenResponse = await mailRequest('/api/inbox-token', {
    method: 'POST',
    jar,
    headers: { 'Content-Type': 'application/json', Referer: referer },
    body: { email },
  });
  const token = tokenResponse.data?.auth?.token;
  if (!tokenResponse.data?.success || !token) {
    throw new Error(`GPTMail session rejected: ${tokenResponse.text.slice(0, 300)}`);
  }
  return { email, token, jar, referer };
};

export const listEmails = async (mailbox) => {
  const response = await mailRequest(`/api/emails?email=${encodeURIComponent(mailbox.email)}`, {
    jar: mailbox.jar,
    headers: {
      Accept: 'application/json',
      Referer: mailbox.referer,
      'X-Inbox-Token': mailbox.token,
    },
  });
  if (!response.data?.success) return [];
  return response.data?.data?.emails ?? [];
};

export const getEmailDetail = async (mailbox, id) => {
  const response = await mailRequest(`/api/email/${encodeURIComponent(id)}`, {
    jar: mailbox.jar,
    headers: {
      Accept: 'application/json',
      Referer: mailbox.referer,
      'X-Inbox-Token': mailbox.token,
    },
  });
  if (!response.data?.success) return null;
  return response.data?.data?.email ?? response.data?.data ?? null;
};

const QUERY_EQUALS = '__OREATEAI_QUERY_EQUALS__';

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

const asVerificationUrl = (candidate, hostPattern) => {
  try {
    const url = new URL(candidate);
    if (!hostPattern.test(url.hostname)) return null;
    const email = lastNonEmptyParam(url, 'email');
    const tokenID = lastNonEmptyParam(url, 'tokenID');
    if (!email || !tokenID) return null;
    url.searchParams.set('email', email);
    url.searchParams.set('tokenID', tokenID);
    const isUuidToken = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tokenID);
    return { url: url.href, score: isUuidToken ? 3 : 2 };
  } catch {
    return null;
  }
};

export const waitForVerificationLink = async (mailbox, {
  timeout = 120_000,
  interval = 1_500,
  hostPattern = /oreateai\.com$/i,
} = {}) => {
  const deadline = Date.now() + timeout;
  const visited = new Set();
  let emailsSeen = 0;
  const linkSummaries = new Set();
  while (Date.now() < deadline) {
    let emails = [];
    try {
      emails = await listEmails(mailbox);
    } catch {
      await sleep(interval);
      continue;
    }
    emailsSeen = Math.max(emailsSeen, emails.length);
    for (const email of emails) {
      const id = email.id ?? email.email_id ?? email.uuid;
      let detail = null;
      if (id && !visited.has(id)) {
        try {
          detail = await getEmailDetail(mailbox, id);
          if (detail) visited.add(id);
        } catch {
          continue;
        }
      }
      const source = collectStringValues({ email, detail }).join('\n');
      const links = extractLinks(source);
      for (const link of links) {
        try {
          const url = new URL(link);
          linkSummaries.add(`${url.hostname}${url.pathname}?[${[...url.searchParams.keys()].join(',')}]`);
        } catch {}
      }
      const candidates = links
        .map((candidate) => asVerificationUrl(candidate, hostPattern))
        .filter((candidate) => candidate?.score > 0)
        .sort((left, right) => right.score - left.score);
      if (candidates[0]) return candidates[0].url;
    }
    await sleep(interval);
  }
  const diagnostics = [...linkSummaries].slice(0, 8).join(' | ') || 'no links';
  throw new Error(`GPTMail verification email timeout after ${timeout}ms; emails=${emailsSeen}; links=${diagnostics}`);
};