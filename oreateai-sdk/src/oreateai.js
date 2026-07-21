import { CookieJar, request, assertSuccess } from './http.js';

const BASE_URL = 'https://www.oreateai.com';
const HOME_PATH = '/home/vertical/aiVideo/zh';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

export const createOreateClient = ({ locale = 'zh-CN', timeout = 20_000 } = {}) => {
  const jar = new CookieJar();
  const referer = `${BASE_URL}${HOME_PATH}`;
  const commonHeaders = {
    Accept: 'application/json, text/plain, */*',
    'Cache-Control': 'no-cache, no-store',
    'Client-Type': 'pc',
    Locale: locale,
    Pragma: 'no-cache',
    Referer: referer,
    'User-Agent': USER_AGENT,
  };

  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await request({
      url: `${BASE_URL}${path}`,
      method,
      body,
      jar,
      timeout,
      headers: {
        ...commonHeaders,
        ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: BASE_URL } : {}),
        ...headers,
      },
    });
    return assertSuccess(response, path);
  };

  return {
    jar,
    importBrowserCookies(cookies) {
      jar.importBrowserCookies(cookies);
    },
    exportBrowserCookies() {
      return jar.browserSnapshot();
    },
    async bootstrap() {
      const response = await request({
        url: referer,
        jar,
        timeout,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': `${locale},zh;q=0.9,en;q=0.8` },
      });
      if (response.status < 200 || response.status >= 400) {
        throw new Error(`OreateAI bootstrap HTTP ${response.status}`);
      }
      return jar.snapshot();
    },
    async getTicket() {
      const result = await call('/passport/api/getticket');
      if (!result.data?.ticketID || !result.data?.pk) throw new Error('getticket returned incomplete data');
      return result.data;
    },
    async emailSignup({ email, ticketID, encryptedPassword, jt, requestHeaders = {} }) {
      const result = await call('/passport/api/emailsignupin', {
        method: 'POST',
        headers: requestHeaders,
        body: { fr: 'main', email, ticketID, password: encryptedPassword, jt },
      });
      return result.data ?? {};
    },
    async checkEmailVerified({ email, ticketID, encryptedPassword }) {
      const result = await call('/passport/api/checkemailverified', {
        method: 'POST',
        body: { email, ticketID, password: encryptedPassword, fr: '' },
      });
      return result.data ?? {};
    },
    async resendConfirmation({ email, ticketID, encryptedPassword }) {
      const result = await call('/passport/api/resendconfirmemail', {
        method: 'POST',
        body: { email, ticketID, password: encryptedPassword, fr: '' },
      });
      return result.data ?? {};
    },
    async visitVerificationLink(url, maxRedirects = 5) {
      let current = new URL(url);
      for (let count = 0; count <= maxRedirects; count += 1) {
        const response = await request({
          url: current.href,
          jar,
          timeout,
          headers: { 'User-Agent': USER_AGENT, Referer: referer },
        });
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          current = new URL(response.headers.location, current);
          continue;
        }
        if (response.status < 200 || response.status >= 400) {
          throw new Error(`verification link HTTP ${response.status}`);
        }
        return { status: response.status, url: current.href };
      }
      throw new Error('verification link exceeded redirect limit');
    },
  };
};