const fs = require('fs');
const path = require('path');

const OREATEAI_URL = 'https://www.oreateai.com/home/vertical/aiVideo/zh';
const MAX_BODY_LENGTH = 200_000;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|credential)/i;
const LARGE_DATA_KEY = /(base64|dataurl|data_url|image_data|file_data)/i;

const ensureCaptureDirectory = (app) => {
  const directory = path.join(app.getPath('userData'), 'oreateai-captures');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

const redactObject = (value, key = '') => {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (LARGE_DATA_KEY.test(key)) return '[LARGE_DATA_REMOVED]';
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactObject(childValue, childKey)]),
    );
  }
  if (typeof value === 'string' && value.startsWith('data:') && value.length > 500) {
    return `[DATA_URL_REMOVED:${value.length}]`;
  }
  return value;
};

const redactHeaders = (headers = {}) => Object.fromEntries(
  Object.entries(headers).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : value]),
);

const sanitizeBody = (body) => {
  if (typeof body !== 'string' || !body) return '';
  const truncated = body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) : body;
  try {
    const parsed = JSON.parse(truncated);
    return JSON.stringify(redactObject(parsed));
  } catch {
    if (/^data:/i.test(truncated)) return `[DATA_URL_REMOVED:${body.length}]`;
    return body.length > MAX_BODY_LENGTH
      ? `${truncated}\n[TRUNCATED:${body.length - MAX_BODY_LENGTH}]`
      : truncated;
  }
};

const isRecordedRequest = ({ url = '', type = '' } = {}) => {
  try {
    const hostname = new URL(url).hostname;
    return (hostname === 'oreateai.com' || hostname.endsWith('.oreateai.com'))
      && ['Fetch', 'XHR'].includes(type);
  } catch {
    return false;
  }
};

const publicUrl = (url = '') => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
};

const emitStep = (onStep, step, data = {}) => {
  try { onStep(step, data); } catch {}
};

const cookieUrl = (cookie) => {
  const hostname = String(cookie.domain || 'www.oreateai.com').replace(/^\./, '');
  const cookiePath = String(cookie.path || '/');
  return `https://${hostname}${cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`}`;
};

const injectCookies = async (browserSession, cookies) => {
  const results = await Promise.allSettled(cookies.map((cookie) => browserSession.cookies.set({
    url: cookieUrl(cookie),
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    domain: cookie.domain || undefined,
    path: cookie.path || '/',
    secure: cookie.secure !== false,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite || 'unspecified',
    expirationDate: Number.isFinite(cookie.expirationDate) ? cookie.expirationDate : undefined,
  })));
  const rejected = results.filter((result) => result.status === 'rejected');
  if (rejected.length === results.length) throw new Error('OreateAI Cookie 全部注入失败');
  return { injected: results.length - rejected.length, rejected: rejected.length };
};

async function openOreateaiCaptureBrowser({ app, BrowserWindow, account, onStep = () => {} }) {
  const cookies = Array.isArray(account?.cookies) ? account.cookies : [];
  if (!account?.id || !cookies.length) throw new Error('渠道八账号没有可注入的 Cookie');

  const startedAt = new Date();
  const captureId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-account-${account.id}`;
  const captureDirectory = ensureCaptureDirectory(app);
  const networkPath = path.join(captureDirectory, `${captureId}-network.jsonl`);
  const metadataPath = path.join(captureDirectory, `${captureId}-metadata.json`);
  const stream = fs.createWriteStream(networkPath, { flags: 'wx' });
  const pending = new Map();
  let sequence = 0;
  let requestCount = 0;
  let closed = false;

  const writeRecord = (record) => {
    if (closed || stream.destroyed) return;
    stream.write(`${JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), ...record })}\n`);
  };

  const partition = `oreateai-capture-${account.id}-${Date.now()}`;
  const browser = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    title: `OreateAI 操作记录 - ${account.email || account.id}`,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.setMenuBarVisibility(false);
  const userAgent = typeof account.user_agent === 'string' ? account.user_agent.trim() : '';
  if (userAgent) browser.webContents.setUserAgent(userAgent);

  browser.webContents.on('did-start-loading', () => {
    emitStep(onStep, 'page_loading');
  });
  browser.webContents.on('dom-ready', () => {
    emitStep(onStep, 'page_dom_ready', { url: publicUrl(browser.webContents.getURL()) });
  });
  browser.webContents.on('did-finish-load', () => {
    emitStep(onStep, 'page_loaded', { url: publicUrl(browser.webContents.getURL()) });
  });
  browser.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    emitStep(onStep, 'page_load_failed', {
      errorCode,
      errorDescription,
      url: publicUrl(validatedURL),
      isMainFrame: Boolean(isMainFrame),
    });
  });

  const injected = await injectCookies(browser.webContents.session, cookies);
  onStep('cookies_injected', injected);

  const debug = browser.webContents.debugger;
  let captureEnabled = false;

  const enableNetworkCapture = async () => {
    try {
      if (!debug.isAttached()) debug.attach('1.3');
      await Promise.race([
        debug.sendCommand('Network.enable', {
          maxTotalBufferSize: 20_000_000,
          maxResourceBufferSize: 5_000_000,
          maxPostDataSize: MAX_BODY_LENGTH,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Network.enable timeout')), 5000);
        }),
      ]);
      captureEnabled = true;
      emitStep(onStep, 'network_capture_ready');
      return true;
    } catch (error) {
      try {
        if (debug.isAttached()) debug.detach();
      } catch {}
      emitStep(onStep, 'network_capture_unavailable', {
        error: String(error?.message || error || 'unknown').slice(0, 200),
      });
      return false;
    }
  };

  debug.on('message', async (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      if (!isRecordedRequest({ url: request.url, type: params.type })) return;
      requestCount += 1;
      pending.set(params.requestId, {
        url: request.url,
        method: request.method,
        type: params.type,
        mimeType: '',
      });
      writeRecord({
        event: 'request',
        requestId: params.requestId,
        resourceType: params.type,
        method: request.method,
        url: request.url,
        headers: redactHeaders(request.headers),
        body: sanitizeBody(request.postData),
      });
      onStep('request_recorded', { requestCount, method: request.method, url: request.url });
      return;
    }

    if (method === 'Network.responseReceived') {
      const current = pending.get(params.requestId);
      if (!current) return;
      current.mimeType = params.response?.mimeType || '';
      current.status = params.response?.status;
      current.headers = redactHeaders(params.response?.headers || {});
      pending.set(params.requestId, current);
      return;
    }

    if (method !== 'Network.loadingFinished') return;
    const current = pending.get(params.requestId);
    if (!current) return;
    pending.delete(params.requestId);
    let body = '';
    if (/json|text|javascript/i.test(current.mimeType || '')) {
      try {
        const responseBody = await debug.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        body = responseBody?.base64Encoded
          ? `[BASE64_RESPONSE_REMOVED:${responseBody.body?.length || 0}]`
          : sanitizeBody(responseBody?.body || '');
      } catch (error) {
        body = `[RESPONSE_BODY_UNAVAILABLE:${error.message || String(error)}]`;
      }
    }
    writeRecord({
      event: 'response',
      requestId: params.requestId,
      method: current.method,
      url: current.url,
      status: current.status,
      mimeType: current.mimeType,
      headers: current.headers,
      body,
      encodedDataLength: params.encodedDataLength,
    });
  });

  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      if (debug.isAttached()) debug.detach();
    } catch {}
    stream.end();
    const metadata = {
      captureId,
      accountId: account.id,
      email: account.email || '',
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      requestCount,
      captureEnabled,
      networkPath,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    onStep('capture_finished', { captureId, requestCount, networkPath, metadataPath });
  };

  browser.on('closed', finish);
  browser.webContents.on('render-process-gone', finish);

  try {
    await browser.loadURL(OREATEAI_URL);
    await enableNetworkCapture();
    onStep('capture_ready', {
      captureId,
      captureEnabled,
      networkPath,
      metadataPath,
    });
  } catch (error) {
    finish();
    if (!browser.isDestroyed()) browser.close();
    throw error;
  }

  return { captureId, captureEnabled, networkPath, metadataPath, injected };
}

module.exports = { openOreateaiCaptureBrowser };