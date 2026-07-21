import https from 'node:https';

const splitSetCookie = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(/,(?=\s*[^;,]+=)/g);
};

const defaultPath = (pathname) => {
  if (!pathname || pathname === '/' || !pathname.includes('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
};

const normalizeDomain = (domain) => String(domain || '').trim().replace(/^\./, '').toLowerCase();
const cookieKey = ({ name, domain, path, hostOnly }) => `${hostOnly ? 'H' : 'D'}\t${domain}\t${path}\t${name}`;
const domainMatches = (hostname, cookie) => cookie.hostOnly
  ? hostname === cookie.domain
  : hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
const pathMatches = (pathname, cookiePath) => pathname === cookiePath
  || pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);

const parseSetCookie = (value, sourceUrl, now) => {
  const parts = String(value).split(';').map((part) => part.trim());
  const separator = parts[0].indexOf('=');
  if (separator <= 0) return null;

  const source = new URL(sourceUrl);
  const cookie = {
    name: parts[0].slice(0, separator).trim(),
    value: parts[0].slice(separator + 1).trim(),
    domain: source.hostname.toLowerCase(),
    path: defaultPath(source.pathname),
    hostOnly: true,
    secure: false,
    httpOnly: false,
    sameSite: undefined,
    expires: undefined,
  };

  for (const attribute of parts.slice(1)) {
    const index = attribute.indexOf('=');
    const name = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const attributeValue = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (name === 'domain' && attributeValue) {
      const domain = normalizeDomain(attributeValue);
      if (source.hostname === domain || source.hostname.endsWith(`.${domain}`)) {
        cookie.domain = domain;
        cookie.hostOnly = false;
      }
    } else if (name === 'path' && attributeValue.startsWith('/')) {
      cookie.path = attributeValue;
    } else if (name === 'secure') {
      cookie.secure = true;
    } else if (name === 'httponly') {
      cookie.httpOnly = true;
    } else if (name === 'samesite') {
      cookie.sameSite = attributeValue;
    } else if (name === 'max-age' && /^-?\d+$/.test(attributeValue)) {
      cookie.expires = now + (Number(attributeValue) * 1000);
    } else if (name === 'expires') {
      const expires = Date.parse(attributeValue);
      if (Number.isFinite(expires)) cookie.expires = expires;
    }
  }
  return cookie;
};

const normalizeBrowserCookie = (cookie) => {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return null;
  const domain = normalizeDomain(cookie.domain);
  if (!domain) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: cookie.path?.startsWith('/') ? cookie.path : '/',
    hostOnly: cookie.hostOnly ?? !String(cookie.domain).startsWith('.'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite,
    expires: Number.isFinite(cookie.expires) && cookie.expires > 0 ? cookie.expires * 1000 : undefined,
  };
};

export class CookieJar {
  #cookies = new Map();

  #store(cookie, now = Date.now()) {
    const key = cookieKey(cookie);
    if (cookie.expires !== undefined && cookie.expires <= now) {
      this.#cookies.delete(key);
      return;
    }
    this.#cookies.set(key, cookie);
  }

  absorb(headers, sourceUrl, now = Date.now()) {
    if (!sourceUrl) throw new Error('sourceUrl is required when absorbing Set-Cookie headers');
    for (const item of splitSetCookie(headers['set-cookie'])) {
      const cookie = parseSetCookie(item, sourceUrl, now);
      if (cookie) this.#store(cookie, now);
    }
  }

  importBrowserCookies(cookies, now = Date.now()) {
    if (!Array.isArray(cookies)) throw new Error('browser cookie snapshot must be an array');
    for (const item of cookies) {
      const cookie = normalizeBrowserCookie(item);
      if (cookie) this.#store(cookie, now);
    }
  }

  header(url, now = Date.now()) {
    const target = new URL(url);
    const hostname = target.hostname.toLowerCase();
    const matches = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        this.#cookies.delete(key);
        continue;
      }
      if (cookie.secure && target.protocol !== 'https:') continue;
      if (!domainMatches(hostname, cookie) || !pathMatches(target.pathname || '/', cookie.path)) continue;
      matches.push(cookie);
    }
    return matches
      .sort((left, right) => right.path.length - left.path.length)
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  }

  snapshot(now = Date.now()) {
    return [...this.#cookies.values()]
      .filter((cookie) => cookie.expires === undefined || cookie.expires > now)
      .map((cookie) => ({ ...cookie }));
  }

  browserSnapshot(now = Date.now()) {
    return this.snapshot(now).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly
        ? { url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}` }
        : { domain: `.${cookie.domain}`, path: cookie.path }),
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.expires !== undefined ? { expires: cookie.expires / 1000 } : {}),
    }));
  }
}

export const request = ({ url, method = 'GET', headers = {}, body, jar, timeout = 20_000 }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined
      ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const cookieHeader = jar?.header(target.href);
    const requestHeaders = {
      ...headers,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(payload ? { 'Content-Length': String(payload.length) } : {}),
    };

    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      timeout,
    }, (res) => {
      jar?.absorb(res.headers, target.href);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, data, text });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

export class HttpResponseError extends Error {
  constructor(message, { label, httpStatus = null, siteCode = null, siteMessage = null } = {}) {
    super(message);
    this.name = 'HttpResponseError';
    this.label = label;
    this.httpStatus = httpStatus;
    this.siteCode = siteCode;
    this.siteMessage = siteMessage;
  }
}

export const assertSuccess = (response, label) => {
  if (response.status < 200 || response.status >= 300) {
    throw new HttpResponseError(`${label} HTTP ${response.status}`, {
      label,
      httpStatus: response.status,
    });
  }
  const code = response.data?.status?.code;
  if (code !== undefined && code !== 0) {
    const message = response.data?.status?.errMsg || response.data?.status?.msg || 'unknown error';
    throw new HttpResponseError(`${label} rejected (${code})`, {
      label,
      httpStatus: response.status,
      siteCode: code,
      siteMessage: String(message).slice(0, 300),
    });
  }
  return response.data;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));