const path = require('path');
const { pathToFileURL } = require('url');

const OREATEAI_URL = 'https://www.oreateai.com/home/vertical/aiVideo/zh';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const emit = (onStep, step, data = {}) => {
  try { onStep(step, data); } catch {}
};

const sdkFile = (app, file) => path.join(
  app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
  'oreateai-sdk',
  'src',
  file,
);

const importSdk = (app, file) => import(pathToFileURL(sdkFile(app, file)).href);

const waitForRuntime = async (webContents, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (webContents.isDestroyed()) throw new Error('OreateAI 浏览器窗口已关闭');
    try {
      const state = await webContents.executeJavaScript(`({
        ready: document.readyState === 'complete',
        hasRuntime: Boolean(globalThis.paris_2146?.sendBantiReport)
      })`, true);
      if (state?.ready && state?.hasRuntime) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`OreateAI 风控运行时在 ${timeoutMs}ms 内未就绪`);
};

const browserJsonRequest = async (webContents, requestPath, { method = 'GET', body } = {}) => {
  const result = await webContents.executeJavaScript(`fetch(${JSON.stringify(requestPath)}, {
    method: ${JSON.stringify(method)},
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Cache-Control': 'no-cache, no-store',
      'Client-Type': 'pc',
      Locale: 'zh-CN',
      Pragma: 'no-cache',
      ...(${JSON.stringify(method === 'POST')} ? { 'Content-Type': 'application/json' } : {})
    },
    ...(${JSON.stringify(method === 'POST')} ? { body: JSON.stringify(${JSON.stringify(body || {})}) } : {})
  }).then(async (response) => {
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    return { httpStatus: response.status, payload, text: text.slice(0, 500) };
  })`, true);

  const code = result?.payload?.status?.code;
  const succeeded = result
    && result.httpStatus >= 200
    && result.httpStatus < 300
    && (code === undefined || Number(code) === 0);
  if (!succeeded) {
    const status = result?.payload?.status || {};
    const message = status.message || status.msg || status.errMsg || result?.payload?.message || '';
    const detail = message || result?.text || `HTTP ${result?.httpStatus || 'unknown'}`;
    console.error(`[browserJsonRequest] ${requestPath} FAILED`, JSON.stringify({
      httpStatus: result?.httpStatus,
      code,
      fullPayload: result?.payload,
      text: result?.text,
      requestBody: body,
    }));
    throw new Error(`${requestPath} 请求失败（code=${code ?? 'unknown'}）：${detail}`);
  }
  return result.payload?.data || {};
};

const requestJt = (webContents, timeoutMs = 15000) => webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const runtime = globalThis.paris_2146;
  if (!runtime?.sendBantiReport) return reject(new Error('Banti runtime is unavailable'));
  const timer = setTimeout(() => reject(new Error('Banti callback timeout')), ${timeoutMs});
  runtime.sendBantiReport({ subid: '' }, (first, second) => {
    clearTimeout(timer);
    const jt = (second ?? first)?.htj?.jt;
    if (typeof jt !== 'string' || !jt.startsWith('31$')) return reject(new Error('Banti returned invalid jt'));
    resolve(jt);
  });
})`, true);

const cookieHeader = (cookies) => cookies
  .filter((cookie) => cookie?.name && typeof cookie.value === 'string')
  .map((cookie) => `${cookie.name}=${cookie.value}`)
  .join('; ');

const publicCookie = (cookie) => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  path: cookie.path,
  expirationDate: cookie.expirationDate,
  httpOnly: cookie.httpOnly,
  secure: cookie.secure,
  sameSite: cookie.sameSite,
});

async function registerOreateaiWithBrowser({
  app,
  BrowserWindow,
  mailbox: mailboxCredentials,
  onStep = () => {},
  visible = true,
  keepOpen = false,
  mailTimeout = 180000,
} = {}) {
  const [{ createAppleMailbox, waitForAppleVerificationLink }, { encryptPassword }, { createPassword, isValidPassword }] = await Promise.all([
    importSdk(app, 'apple-mail.js'),
    importSdk(app, 'crypto.js'),
    importSdk(app, 'register.js'),
  ]);

  const password = createPassword();
  if (!isValidPassword(password)) throw new Error('生成的密码不符合 OreateAI 的 8–16 位复杂度规则');

  emit(onStep, 'mailbox_connecting', { email: mailboxCredentials?.email });
  const mailbox = createAppleMailbox(mailboxCredentials);
  const partition = `oreateai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const browser = new BrowserWindow({
    width: 1280,
    height: 900,
    show: visible,
    title: 'OreateAI 注册登录（真实 Chromium）',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.setMenuBarVisibility(false);

  try {
    emit(onStep, 'browser_opening', { email: mailbox.email });
    await browser.loadURL(OREATEAI_URL);
    await waitForRuntime(browser.webContents);

    emit(onStep, 'ticket_request');
    const ticket = await browserJsonRequest(browser.webContents, '/passport/api/getticket');
    if (!ticket.ticketID || !ticket.pk) throw new Error('OreateAI getticket 返回不完整');
    const encryptedPassword = encryptPassword(password, ticket.pk);

    emit(onStep, 'risk_request');
    const jt = await requestJt(browser.webContents);
    emit(onStep, 'signup_submit');
    const verificationRequestedAt = Date.now();
    const signup = await browserJsonRequest(browser.webContents, '/passport/api/emailsignupin', {
      method: 'POST',
      body: { fr: 'main', email: mailbox.email, ticketID: ticket.ticketID, password: encryptedPassword, jt },
    });
    if (signup.isRegister !== true && signup.sendEmailCount === undefined) {
      throw new Error('OreateAI 未进入邮箱验证状态');
    }

    emit(onStep, 'email_wait');
    const verificationUrl = await waitForAppleVerificationLink(mailbox, {
      timeout: mailTimeout,
      after: verificationRequestedAt - 120_000,
    });
    const verification = new URL(verificationUrl);
    const verificationEmail = verification.searchParams.get('email');
    const tokenID = verification.searchParams.get('tokenID');
    if (!verificationEmail || !tokenID) throw new Error('OreateAI 验证链接缺少 email 或 tokenID');

    emit(onStep, 'email_verify');
    await waitForRuntime(browser.webContents);
    const confirmJt = await requestJt(browser.webContents);
    await browserJsonRequest(browser.webContents, '/passport/api/emailregisterconfirm', {
      method: 'POST',
      body: {
        email: verificationEmail,
        tokenID,
        plat: 'pc',
        fr: verification.searchParams.get('fr') || 'main',
        fissionCode: verification.searchParams.get('fissionCode') || '',
        inviteCode: verification.searchParams.get('inviteCode') || '',
        jt: confirmJt,
      },
    });

    emit(onStep, 'login_check');
    let loginState = null;
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      loginState = await browserJsonRequest(browser.webContents, '/passport/api/checkemailverified', {
        method: 'POST',
        body: { email: mailbox.email, ticketID: ticket.ticketID, password: encryptedPassword, fr: '' },
      });
      if (loginState.isLogin === true) break;
      if (loginState.isNeedRetry === false) throw new Error('OreateAI 邮箱验证被终止');
      await sleep(1500);
    }
    if (loginState?.isLogin !== true) throw new Error('OreateAI 登录确认超时');

    await sleep(1000);
    const cookies = (await browser.webContents.session.cookies.get({ domain: 'oreateai.com' }))
      .map(publicCookie);
    if (!cookies.length) throw new Error('登录成功但未提取到 OreateAI Cookie');
    const userAgent = await browser.webContents.executeJavaScript('navigator.userAgent', true);
    const state = {
      email: mailbox.email,
      password,
      cookie: cookieHeader(cookies),
      cookies,
      user_agent: userAgent,
      location: browser.webContents.getURL(),
    };
    emit(onStep, 'complete', { email: mailbox.email, cookieCount: cookies.length });
    return state;
  } finally {
    if (!keepOpen && !browser.isDestroyed()) browser.close();
  }
}

async function createOreateaiRuntimeCredential({ app, BrowserWindow, account, visible = false } = {}) {
  if (!account || !Array.isArray(account.cookies) || account.cookies.length === 0) {
    throw new Error('OreateAI 账号缺少有效浏览器 Cookie');
  }
  const partition = `oreateai-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const browser = new BrowserWindow({
    width: 1280,
    height: 900,
    show: visible,
    title: 'OreateAI 视频生成运行时',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.setMenuBarVisibility(false);
  if (account.user_agent) browser.webContents.setUserAgent(account.user_agent);

  const dispose = async () => {
    if (!browser.isDestroyed()) browser.close();
  };

  try {
    for (const cookie of account.cookies) {
      if (!cookie?.name || typeof cookie.value !== 'string') continue;
      const cookiePath = cookie.path?.startsWith('/') ? cookie.path : '/';
      const host = String(cookie.domain || 'oreateai.com').replace(/^\./, '');
      const details = {
        url: `${cookie.secure === false ? 'http' : 'https'}://${host}${cookiePath}`,
        name: cookie.name,
        value: cookie.value,
        path: cookiePath,
        secure: cookie.secure !== false,
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (cookie.domain) details.domain = cookie.domain;
      if (Number.isFinite(cookie.expirationDate)) details.expirationDate = cookie.expirationDate;
      if (['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)) details.sameSite = cookie.sameSite;
      await browser.webContents.session.cookies.set(details);
    }

    await browser.loadURL(OREATEAI_URL);
    await waitForRuntime(browser.webContents);
    const jt = await requestJt(browser.webContents);
    const [cookies, userInfo, runtimeState] = await Promise.all([
      browser.webContents.session.cookies.get({ domain: 'oreateai.com' }),
      browserJsonRequest(browser.webContents, '/oreate/user/getuserinfo').catch(() => ({})),
      browser.webContents.executeJavaScript(`({
        ua: navigator.userAgent,
        deviceID: localStorage.getItem('OUID') || '',
        bid: document.cookie.split('; ').find((item) => item.startsWith('__bid_n='))?.slice(8) || ''
      })`, true),
    ]);
    // getuserinfo returns account identity under data.basicInfo. These values
    // must match the signed-in account exactly or the SSE endpoint rejects the
    // request with "params error".
    const info = userInfo.basicInfo || userInfo.userInfo || userInfo.user || userInfo;
    const vip = userInfo.vipInfo || info.vipInfo || {};
    const createTime = Number(info.createTime ?? account.created_at);
    return {
      jt,
      cookies: cookies.map(publicCookie),
      requestHeaders: { 'User-Agent': runtimeState.ua || account.user_agent || '' },
      runtimeFields: {
        ua: runtimeState.ua || account.user_agent || '',
        js_env: 'h5',
        extra: {
          email: String(info.email || account.email || ''),
          vip: String(vip.vipType ?? info.vipType ?? ''),
          reg_ts: Number.isFinite(createTime) ? Math.trunc(createTime) : '',
          deviceID: runtimeState.deviceID || '',
          bid: runtimeState.bid || '',
        },
      },
      dispose,
      ttl: 30_000,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

module.exports = { registerOreateaiWithBrowser, createOreateaiRuntimeCredential };