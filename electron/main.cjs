const { app, BrowserWindow, ipcMain, dialog, session, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const { registerOreateaiWithBrowser, createOreateaiRuntimeCredential } = require('./oreateai-browser.cjs');
const { openOreateaiCaptureBrowser } = require('./oreateai-capture.cjs');

if (!app.isPackaged) {
  const devUserDataDir = path.join(__dirname, '..', '.electron-dev-user-data');
  app.setPath('userData', devUserDataDir);
}
const shouldDisableGpuAcceleration = process.env.UIJIEM_DISABLE_GPU === '1';
if (shouldDisableGpuAcceleration) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  app.commandLine.appendSwitch('enable-features', [
    'PlatformHEVCDecoderSupport',
    'UseVideoToolboxForVideoDecoding',
  ].join(','));
}
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});

const WIZSTAR_PORT = 18765;
const WIZSTAR_BASE_URL = `http://127.0.0.1:${WIZSTAR_PORT}`;
const WIZSTAR_INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');

let oreateaiSdkPromise = null;
const importOreateaiSdk = () => {
  if (!oreateaiSdkPromise) {
    const sdkPath = path.join(
      app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
      'oreateai-sdk',
      'src',
      'index.js',
    );
    oreateaiSdkPromise = import(pathToFileURL(sdkPath).href);
  }
  return oreateaiSdkPromise;
};

const getOreateaiAccount = async (accountId = 0) => {
  let selectedId = Number(accountId) || 0;
  if (!selectedId) {
    const response = await fetch(`${WIZSTAR_BASE_URL}/oreateai/accounts`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || '读取渠道八账号池失败');
    const account = (Array.isArray(payload.data) ? payload.data : [])
      .find((item) => item?.configured && String(item.status || 'active') === 'active');
    selectedId = Number(account?.id) || 0;
  }
  if (!selectedId) throw new Error('没有可用的 OreateAI 渠道八账号');
  const response = await fetch(`${WIZSTAR_BASE_URL}/internal/oreateai/accounts/${selectedId}/session`, {
    headers: { 'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || '读取渠道八登录态失败');
  if (!Array.isArray(payload.data?.cookies) || payload.data.cookies.length === 0) {
    throw new Error('OreateAI 渠道八账号登录态为空');
  }
  return payload.data;
};

const getOreateaiRegistrationMailboxes = async ({ mailboxIds = [], count = 1 } = {}) => {
  const selectedIds = [...new Set(
    (Array.isArray(mailboxIds) ? mailboxIds : [])
      .map((value) => Number(value) || 0)
      .filter((value) => value > 0),
  )].slice(0, 50);
  const response = await fetch(`${WIZSTAR_BASE_URL}/internal/mailboxes/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      channel: 'oreateai',
      count: Math.max(1, Math.min(Number.parseInt(count, 10) || 1, 50)),
      mailbox_ids: selectedIds,
      credential_type: 'oauth',
      provider: 'microsoft',
      lease_seconds: 21600,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || '从全局邮箱库领取渠道八邮箱失败');
  return Array.isArray(payload.data) ? payload.data : [];
};

const updateMailboxChannelUsage = async (mailboxId, channel, status, {
  accountEmail = '',
  error = '',
} = {}) => {
  if (!mailboxId) return;
  const response = await fetch(`${WIZSTAR_BASE_URL}/internal/mailboxes/${Number(mailboxId)}/usage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      channel,
      status,
      account_email: accountEmail,
      error,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || `更新 ${channel} 邮箱使用状态失败`);
  }
};

const claimPasswordRegistrationAccounts = async (channel, {
  count = 1,
  mailboxIds = [],
} = {}) => {
  const selectedIds = [...new Set(
    (Array.isArray(mailboxIds) ? mailboxIds : [])
      .map((value) => Number(value) || 0)
      .filter((value) => value > 0),
  )].slice(0, 100);
  const response = await fetch(`${WIZSTAR_BASE_URL}/internal/mailboxes/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      channel,
      count: Math.max(1, Math.min(Number.parseInt(count, 10) || 1, 100)),
      mailbox_ids: selectedIds,
      credential_type: 'password',
      provider: 'google',
      lease_seconds: 21600,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `从全局邮箱库领取 ${channel} 登录账号失败`);
  return (Array.isArray(payload.data) ? payload.data : []).map((mailbox) => ({
    mailboxId: Number(mailbox.id) || 0,
    email: String(mailbox.email || '').trim(),
    password: String(mailbox.password || mailbox.google_password || ''),
  }));
};

const publicOreateaiCapabilities = (capabilities) => ({
  models: capabilities.models,
  scenes: capabilities.scenes,
  capabilities: capabilities.capabilities.map((item) => ({
    ...item,
    combinations: item.combinations.map(({ aiType, ...combination }) => combination),
  })),
});

const OREATEAI_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const OREATEAI_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);

const safeOreateaiError = (error) => String(error?.message || error || 'OreateAI 请求失败')
  .replace(/31\$[^\s"']+/g, '[redacted]')
  .replace(/(cookie|authorization|sessionkey|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  .slice(0, 500);

const probeOreateaiVideoDuration = async (filePath) => {
  const probe = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await probe.loadURL(pathToFileURL(filePath).href);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const duration = await probe.webContents.executeJavaScript(`(() => {
        const media = document.querySelector('video, audio');
        return Number.isFinite(media?.duration) ? media.duration : 0;
      })()`, true).catch(() => 0);
      if (Number.isFinite(duration) && duration > 0) return duration;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`无法读取参考视频时长：${path.basename(filePath)}`);
  } finally {
    if (!probe.isDestroyed()) probe.close();
  }
};

const inspectOreateaiAssetPaths = async (assetPaths = []) => {
  if (!Array.isArray(assetPaths)) throw new Error('OreateAI 素材列表格式无效');
  const assets = [];
  for (const value of assetPaths) {
    const filePath = String(typeof value === 'string' ? value : value?.path || '').trim();
    if (!filePath || !path.isAbsolute(filePath)) throw new Error('OreateAI 素材必须是绝对本地路径');
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) throw new Error(`素材不可读或为空：${path.basename(filePath)}`);
    const extension = path.extname(filePath).toLowerCase();
    const kind = OREATEAI_IMAGE_EXTENSIONS.has(extension)
      ? 'image'
      : OREATEAI_VIDEO_EXTENSIONS.has(extension) ? 'video' : '';
    if (!kind) throw new Error(`不支持的素材格式：${extension || 'unknown'}`);
    assets.push({
      path: filePath,
      name: path.basename(filePath),
      kind,
      size: stat.size,
      ...(kind === 'video' ? { durationSec: await probeOreateaiVideoDuration(filePath) } : {}),
    });
  }
  return assets;
};

const createOreateaiVideoClient = async (accountId = 0) => {
  const [sdk, account] = await Promise.all([
    importOreateaiSdk(),
    getOreateaiAccount(accountId),
  ]);
  const jtProvider = sdk.createCallbackJtProvider(() => createOreateaiRuntimeCredential({
    app,
    BrowserWindow,
    account,
    visible: false,
  }));
  return sdk.createOreateVideoClient({
    cookies: account.cookies,
    userAgent: account.user_agent,
    jtProvider,
  });
};

const normalizeOreateaiProgress = (progress = {}) => ({
  stage: String(progress.stage || ''),
  ...(progress.event ? { event: String(progress.event) } : {}),
  ...(Number.isFinite(progress.index) ? { index: progress.index } : {}),
  ...(Number.isFinite(progress.totalAssets) ? { totalAssets: progress.totalAssets } : {}),
  ...(Number.isFinite(progress.loaded) ? { loaded: progress.loaded } : {}),
  ...(Number.isFinite(progress.total) ? { total: progress.total } : {}),
});

// Download a remote URL to a local file path, following redirects.
function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        const next = new URL(res.headers.location, url).toString();
        resolve(downloadToFile(next, destPath, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
      file.on('error', (err) => { fs.unlink(destPath, () => reject(err)); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

async function fetchJson(url, options = {}) {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, { headers: options.headers || {} }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            const detail = parsed.detail || parsed.message || `HTTP ${res.statusCode}`;
            reject(new Error(detail));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
  });
}

async function probeWizstarServer() {
  try {
    const health = await fetchJson(`${WIZSTAR_BASE_URL}/health`);
    try {
      await Promise.all([
        fetchJson(`${WIZSTAR_BASE_URL}/pixmax/config`),
        fetchJson(`${WIZSTAR_BASE_URL}/dola/config`),
        fetchJson(`${WIZSTAR_BASE_URL}/tensorart/models`),
        fetchJson(`${WIZSTAR_BASE_URL}/internal/health`, {
          headers: { 'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN },
        }),
      ]);
      return { running: true, compatible: true, health };
    } catch (e) {
      return { running: true, compatible: false, health, error: e.message || String(e) };
    }
  } catch (e) {
    return { running: false, compatible: false, error: e.message || String(e) };
  }
}

async function killProcessOnPort(port, signal = 'TERM') {
  if (process.platform !== 'win32') {
    return await new Promise((resolve) => {
      execFile('lsof', ['-ti', `tcp:${port}`], (listError, stdout) => {
        if (listError || !stdout.trim()) {
          resolve(false);
          return;
        }
        const pids = stdout.split(/\s+/).map((pid) => Number(pid)).filter(Boolean).filter((pid) => pid !== process.pid);
        if (pids.length === 0) {
          resolve(false);
          return;
        }
        let remaining = pids.length;
        let killed = false;
        pids.forEach((pid) => {
          execFile('kill', [`-${signal}`, String(pid)], (killError) => {
            if (!killError) killed = true;
            remaining -= 1;
            if (remaining === 0) resolve(killed);
          });
        });
      });
    });
  }

  return await new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$owners = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($owner in $owners) { if ($owner -and $owner -ne $PID) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue } }`,
    ], { windowsHide: true }, (error) => {
      if (error) {
        console.error(`[wizstar] failed to clear port ${port}: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isTcpPortOpen = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const socket = net.createConnection({ host, port });
  const settle = (open) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(open);
  };
  socket.setTimeout(500);
  socket.once('connect', () => settle(true));
  socket.once('timeout', () => settle(false));
  socket.once('error', () => settle(false));
});

const waitForTcpPortRelease = async (port, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTcpPortOpen(port))) return true;
    await sleep(200);
  }
  return !(await isTcpPortOpen(port));
};

async function setWizstarCookie(targetSession, name, value) {
  if (!value) return;
  await targetSession.cookies.set({
    url: 'https://wizstar.com',
    name,
    value: String(value),
    domain: '.wizstar.com',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  });
}

async function openWizstarAccountWindow(accountId) {
  const result = await fetchJson(`${WIZSTAR_BASE_URL}/internal/accounts/${accountId}/session`, {
    headers: { 'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN },
  });
  const account = result.data;
  if (!account) throw new Error('account not found');

  const existingWin = wizstarAccountWindows.get(String(accountId));
  if (existingWin && !existingWin.isDestroyed()) {
    if (existingWin.isMinimized()) existingWin.restore();
    existingWin.show();
    existingWin.focus();
    return { ok: true, reused: true };
  }

  const partition = `persist:wizstar-account-${accountId}`;
  const accountSession = session.fromPartition(partition);

  await setWizstarCookie(accountSession, 'osduss', account.osduss);
  await setWizstarCookie(accountSession, 'passOsRefreshTk', account.pass_os_refresh_tk);
  await setWizstarCookie(accountSession, 'uid', account.uid);
  let storedCookies = {};
  try {
    storedCookies = JSON.parse(account.cookies_json || '{}');
  } catch {}
  await Promise.all(Object.entries(storedCookies).map(([name, value]) =>
    setWizstarCookie(accountSession, name, value)
  ));

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: `Wizstar - ${account.email}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition,
    },
    backgroundColor: '#111113',
  });

  wizstarAccountWindows.set(String(accountId), win);
  win.on('closed', () => {
    if (wizstarAccountWindows.get(String(accountId)) === win) {
      wizstarAccountWindows.delete(String(accountId));
    }
  });

  await win.loadURL('https://wizstar.com/tools/generate_video');
  if (account.auth_token) {
    const authToken = JSON.stringify(String(account.auth_token));
    await win.webContents.executeJavaScript(
      `localStorage.setItem('wizstar-token', ${authToken}); window.location.reload();`,
      true,
    );
  }
  return { ok: true };
}

async function openWizstarGoogleLoginWindow(mailbox, options = {}) {
  const { onStep = () => {} } = options;
  const emitStep = (step, data = {}) => {
    try { onStep(step, data); } catch {}
  };
  const partition = `persist:wizstar-google-login-${mailbox.id}`;
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    title: 'Wizstar Google 登录',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition,
    },
    backgroundColor: '#111113',
  });

  let googleWindow = null;
  let completed = false;
  let checking = false;
  let timer = null;
  let timeout = null;
  let resolveLogin = null;
  let authPhase = 'register';
  let loginFlowStarted = false;
  let postRegisterLoginScheduled = false;
  let registerOAuthCompleted = false;
  let registerConsentClicked = false;
  let loginGoogleOpened = false;
  let loginOAuthCompleted = false;
  let loginConsentClicked = false;
  const loginResult = new Promise((resolve) => {
    resolveLogin = resolve;
  });

  const finish = (result) => {
    if (completed) return result;
    completed = true;
    if (timer) clearInterval(timer);
    if (timeout) clearTimeout(timeout);
    resolveLogin(result);
    if (googleWindow && !googleWindow.isDestroyed()) googleWindow.close();
    if (!win.isDestroyed()) win.close();
    return result;
  };

  const scheduleLoginAfterRegister = () => {
    if (completed || loginFlowStarted || postRegisterLoginScheduled || win.isDestroyed()) return;
    postRegisterLoginScheduled = true;
    emitStep('wizstar_register_complete');
    setTimeout(() => {
      if (completed || loginFlowStarted || win.isDestroyed()) return;
      authPhase = 'login';
      loginFlowStarted = true;
      loginGoogleOpened = false;
      loginOAuthCompleted = false;
      loginConsentClicked = false;
      if (googleWindow && !googleWindow.isDestroyed()) googleWindow.close();
      googleWindow = null;
      void clickWizstarGoogleEntry('login').catch((error) => {
        finish({ ok: false, error: error.message || '无法进入 Wizstar 登录' });
      });
    }, 1500);
  };

  const collectSession = async () => {
    if (checking || completed || win.isDestroyed()) return { ok: false, pending: true };
    checking = true;
    try {
      const state = await win.webContents.executeJavaScript(`(async () => {
        const tokenFields = new Set([
          'wizstartoken',
          'usertoken',
          'accesstoken',
          'authtoken',
        ]);
        const normalizeField = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const findToken = (value) => {
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = findToken(item);
              if (found) return found;
            }
            return '';
          }
          if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
              if (tokenFields.has(normalizeField(key)) && (typeof item === 'string' || typeof item === 'number')) {
                const token = String(item).trim().replace(/^"|"$/g, '');
                if (token) return token;
              }
              const found = findToken(item);
              if (found) return found;
            }
            return '';
          }
          if (typeof value === 'string') {
            const text = value.trim();
            if (text.startsWith('{') || text.startsWith('[')) {
              try { return findToken(JSON.parse(text)); } catch {}
            }
          }
          return '';
        };
        const storageState = {
          localStorage: Object.fromEntries(Object.entries(localStorage)),
          sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
        };
        const token = findToken(storageState);
        let userInfo = {};
        try {
          const response = await fetch('/wizstar/user/info', { credentials: 'include' });
          userInfo = await response.json();
        } catch {}
        return { token, userInfo };
      })()`, true).catch(() => null);
      if (!state) return { ok: false, pending: true };

      const allCookies = await win.webContents.session.cookies.get({});
      const wizstarCookies = allCookies.filter((cookie) => {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        return domain === 'wizstar.com' || domain.endsWith('.wizstar.com');
      });
      const cookieMap = Object.fromEntries(wizstarCookies.map((cookie) => [cookie.name, cookie.value]));
      const user = state?.userInfo?.data || {};
      const hasValidatedUser = state?.userInfo?.errno === 0 && Boolean(user.email);
      const hasSessionMaterial = Boolean(state.token) || Object.keys(cookieMap).length > 0;
      if (!hasValidatedUser || !hasSessionMaterial) {
        return { ok: false, pending: true };
      }
      if (authPhase !== 'login') {
        if (registerOAuthCompleted || registerConsentClicked) {
          scheduleLoginAfterRegister();
        }
        return { ok: false, pending: true, registered: registerOAuthCompleted || registerConsentClicked };
      }
      if (!loginOAuthCompleted) {
        return { ok: false, pending: true, waitingForLoginOAuth: true };
      }

      emitStep('extracting_state');
      const response = await fetch(`${WIZSTAR_BASE_URL}/accounts/google-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox_id: mailbox.id,
          email: user.email,
          auth_token: state.token,
          cookies: cookieMap,
          user_info: user,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Google 登录保存失败');
      emitStep('login_complete');
      return finish({ ok: true, account: result.data });
    } finally {
      checking = false;
    }
  };

  const inspectGooglePage = async (targetWindow) => targetWindow.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const inputs = [...document.querySelectorAll('input')];
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      url: location.href,
      hasEmailInput: inputs.some((input) => visible(input) && (
        input.id === 'identifierId' || input.name === 'identifier' || input.type === 'email'
      )),
      hasPasswordInput: inputs.some((input) => visible(input) && (
        input.type === 'password' || input.name === 'Passwd' || input.autocomplete === 'current-password'
      )),
      accountChooser: /accountchooser/.test(location.href) || /use another account|使用其他账号|使用另一个账号|选择帐号|选择账号/i.test(text),
      wrongPassword: /密码错误|wrong password|couldn.t verify|无法验证|try again/i.test(text),
      manualVerification: /captcha|验证码|verify.*human|确认.*不是机器人|请输入您看到或听到的字符/i.test(text)
        || [...document.querySelectorAll('iframe')].some((frame) => /recaptcha|captcha|challenge/i.test(frame.src || '')),
    };
  })()`, true);

  const fillGoogleInput = async (targetWindow, selector, value) => targetWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input || input.offsetWidth === 0 || input.offsetHeight === 0) return { found: false, verified: false };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return { found: true, verified: false };
    setter.call(input, '');
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, verified: input.value === ${JSON.stringify(value)} };
  })()`, true);

  const clickGoogleNext = async (targetWindow, selector) => targetWindow.webContents.executeJavaScript(`(() => {
    const container = document.querySelector(${JSON.stringify(selector)});
    const button = container?.matches?.('button,[role="button"]')
      ? container
      : container?.querySelector?.('button,[role="button"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`, true);

  const handleAccountChooser = async (targetWindow) => {
    const target = await targetWindow.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (element) => String(element?.innerText || element?.textContent || '').replace(/\\s+/g, ' ').trim();
      const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
      const expectedEmail = normalizeEmail(${JSON.stringify(mailbox.email)});
      const blockedText = /use another account|使用其他账号|使用另一个账号|添加账号/i;
      const toTarget = (element, kind) => {
        if (!element) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const clickable = element.closest?.('[data-identifier], [data-email], [role="link"], [role="button"], li, button, a') || element;
        const rect = clickable.getBoundingClientRect();
        if (!visible(clickable) || clickable.disabled) return null;
        return {
          kind,
          x: Math.max(1, Math.floor(rect.left + Math.min(rect.width * 0.5, Math.max(24, rect.width - 24)))),
          y: Math.max(1, Math.floor(rect.top + rect.height / 2)),
          text: textOf(clickable),
        };
      };

      const accountSelectors = [
        '[data-identifier]',
        '[data-email]',
        '[role="link"]',
        '[role="button"]',
        'li',
        'div'
      ];
      const candidates = [...document.querySelectorAll(accountSelectors.join(','))]
        .filter(visible)
        .filter((element) => {
          const text = textOf(element);
          const identifier = String(element.getAttribute?.('data-identifier') || element.getAttribute?.('data-email') || '').trim();
          if (blockedText.test(text)) return false;
          return /@/.test(text) || /@/.test(identifier);
        });

      const matched = candidates.find((element) => {
        const text = normalizeEmail(textOf(element));
        const identifier = normalizeEmail(element.getAttribute?.('data-identifier') || element.getAttribute?.('data-email') || '');
        return expectedEmail && (text.includes(expectedEmail) || identifier.includes(expectedEmail));
      });
      const matchedTarget = toTarget(matched, 'matched');
      if (matchedTarget) return matchedTarget;

      const firstAccount = candidates
        .map((element) => toTarget(element, 'first'))
        .find(Boolean);
      if (firstAccount) return firstAccount;

      const another = [...document.querySelectorAll('a, button, [role="link"], [role="button"]')].find((element) => {
        const text = textOf(element).toLowerCase();
        return visible(element) && /use another account|使用其他账号|使用另一个账号|添加账号/.test(text);
      });
      return toTarget(another, 'another') || { kind: '', x: 0, y: 0 };
    })()`, true).catch(() => null);

    if (!target || !target.x || !target.y) return '';
    const x = Math.round(target.x);
    const y = Math.round(target.y);
    targetWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(80);
    targetWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
    targetWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return target.kind || 'clicked';
  };

  const clickGoogleContinuation = async (targetWindow) => targetWindow.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.disabled;
    };
    window.scrollTo(0, document.body?.scrollHeight || 0);
    const accepted = ['继续', 'continue', '允许', 'allow', '同意', 'agree', '我了解', 'i understand'];
    const button = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')].find((element) => {
      const text = (element.innerText || element.textContent || element.value || '').trim().toLowerCase();
      return visible(element) && accepted.some((candidate) => text === candidate || text.includes(candidate));
    });
    if (!button) return false;
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button.click();
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`, true);

  const driveGoogleWindow = async (targetWindow) => {
    let emailSubmitted = false;
    let passwordSubmitted = false;
    let manualVerificationReported = false;
    const deadline = Date.now() + 14 * 60 * 1000;

    while (!completed && !targetWindow.isDestroyed() && Date.now() < deadline) {
      let signal;
      try {
        signal = await inspectGooglePage(targetWindow);
      } catch (error) {
        if (/destroyed|navigation|closed|Script failed to execute/i.test(error.message || '')) {
          await sleep(500);
          continue;
        }
        throw error;
      }

      if (!/accounts\.google\.com/i.test(signal?.url || '')) {
        if (/wizstar\.com/i.test(signal?.url || '')) {
          if (authPhase === 'register') {
            registerOAuthCompleted = true;
            scheduleLoginAfterRegister();
            return;
          }
          if (authPhase === 'login' && loginGoogleOpened) {
            loginOAuthCompleted = true;
          }
          await collectSession();
        }
        await sleep(800);
        continue;
      }
      if (signal.wrongPassword) throw new Error('Google 密码错误');
      if (signal.manualVerification) {
        if (!manualVerificationReported) {
          manualVerificationReported = true;
          emitStep('manual_verification_required');
        }
        await sleep(1200);
        continue;
      }
      if (signal.accountChooser) {
        emitStep('handling_account_chooser');
        const chooserResult = await handleAccountChooser(targetWindow);
        if (authPhase === 'login' && chooserResult) {
          loginGoogleOpened = true;
        }
        await sleep(1500);
        continue;
      }
      if (signal.hasEmailInput && !emailSubmitted) {
        emitStep('inputting_email');
        const input = await fillGoogleInput(
          targetWindow,
          '#identifierId, input[type="email"], input[name="identifier"]',
          mailbox.email,
        );
        if (!input.found) throw new Error('未找到 Google 邮箱输入框');
        if (!input.verified) throw new Error('Google 邮箱写入后校验失败');
        emitStep('email_input_verified');
        const clicked = await clickGoogleNext(targetWindow, '#identifierNext');
        if (!clicked) throw new Error('未找到 Google 邮箱下一步按钮');
        emailSubmitted = true;
        emitStep('email_next');
        await sleep(2500);
        continue;
      }
      if (signal.hasPasswordInput && !passwordSubmitted) {
        emitStep('inputting_password');
        const input = await fillGoogleInput(
          targetWindow,
          'input[type="password"], input[name="Passwd"], input[autocomplete="current-password"]',
          mailbox.google_password,
        );
        if (!input.found) throw new Error('未找到 Google 密码输入框');
        if (!input.verified) throw new Error('Google 密码写入后校验失败');
        const clicked = await clickGoogleNext(targetWindow, '#passwordNext');
        if (!clicked) throw new Error('未找到 Google 密码下一步按钮');
        passwordSubmitted = true;
        emitStep('password_next');
        await sleep(3000);
        continue;
      }
      const continued = await clickGoogleContinuation(targetWindow);
      if (continued) {
        if (authPhase === 'register') {
          registerConsentClicked = true;
        } else if (authPhase === 'login') {
          loginGoogleOpened = true;
          loginConsentClicked = true;
        }
        emitStep('google_continue_clicked');
        await sleep(2000);
        continue;
      }
      await sleep(800);
    }
  };

  const clickWizstarGoogleEntry = async (mode = 'register') => {
    authPhase = mode === 'login' ? 'login' : 'register';
    const deadline = Date.now() + 60_000;
    let tabClicked = false;
    while (!completed && !win.isDestroyed() && !googleWindow && Date.now() < deadline) {
      const result = await win.webContents.executeJavaScript(`(() => {
        const tabKey = ${JSON.stringify(mode === 'login' ? 'login' : 'register')};
        const visible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const clickElement = (element) => {
          if (!visible(element) || element.disabled) return false;
          element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          element.click();
          element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return true;
        };
        if (!${tabClicked}) {
          const tab = document.querySelector(\`.login-sdk-tab-btn[data-key="\${tabKey}"]\`);
          if (clickElement(tab)) return 'tab';
          return '';
        }
        const google = document.querySelector('button.login-sdk-form-item[data-type="1"]');
        if (clickElement(google)) return 'google';
        return '';
      })()`, true).catch(() => '');
      if (result === 'tab') {
        tabClicked = true;
        emitStep(mode === 'login' ? 'wizstar_login_tab_clicked' : 'wizstar_register_clicked');
        await sleep(1500);
      } else if (result === 'google') {
        emitStep(mode === 'login' ? 'wizstar_login_google_clicked' : 'wizstar_register_google_clicked');
        await sleep(1500);
      } else {
        await sleep(500);
      }
      if (/accounts\.google\.com/i.test(win.webContents.getURL())) {
        if (authPhase === 'login') {
          loginGoogleOpened = true;
        }
        emitStep('google_oauth_opened');
        await driveGoogleWindow(win);
        return;
      }
    }
    if (!googleWindow && !completed) throw new Error('未检测到 Google 登录新窗口');
  };

  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 520,
      height: 720,
      parent: win,
      modal: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition },
    },
  }));
  win.webContents.on('did-create-window', (childWindow) => {
    googleWindow = childWindow;
    if (authPhase === 'login') {
      loginGoogleOpened = true;
    }
    emitStep('google_oauth_opened');
    childWindow.on('closed', () => {
      if (googleWindow === childWindow) googleWindow = null;
      if (completed) return;
      if (authPhase === 'register') {
        if (registerOAuthCompleted || registerConsentClicked) scheduleLoginAfterRegister();
      } else if (authPhase === 'login' && loginGoogleOpened && loginConsentClicked) {
        loginOAuthCompleted = true;
        void collectSession().catch((error) => {
          finish({ ok: false, error: error.message || '渠道一登录态读取失败' });
        });
      }
    });
    void driveGoogleWindow(childWindow).catch((error) => {
      finish({ ok: false, error: error.message || 'Google 登录失败' });
    });
  });
  win.webContents.on('did-finish-load', () => {
    void collectSession().catch((error) => {
      finish({ ok: false, error: error.message || '渠道一登录态读取失败' });
    });
  });

  timeout = setTimeout(() => {
    finish({ ok: false, error: 'Google 登录超时' });
  }, 15 * 60 * 1000);
  win.on('closed', () => {
    if (timer) clearInterval(timer);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      completed = true;
      resolveLogin({ ok: false, canceled: true, error: 'Google 登录窗口已关闭' });
    }
  });

  emitStep('opening_wizstar');
  try {
    await win.loadURL('https://wizstar.com/login');
  } catch (error) {
    return finish({ ok: false, error: error.message || 'Wizstar 登录页打开失败' });
  }
  timer = setInterval(() => {
    void collectSession().catch((error) => {
      finish({ ok: false, error: error.message || '渠道一登录态读取失败' });
    });
  }, 1500);
  void clickWizstarGoogleEntry().catch((error) => {
    finish({ ok: false, error: error.message || '无法进入 Google 登录' });
  });

  return await loginResult;
}

let mainWindow;
let pythonProcess = null;
let pythonServerStarting = false;
let backendWatchdogTimer = null;
let appIsQuitting = false;
const wizstarAccountWindows = new Map();

async function startPythonServer(options = {}) {
  if (pythonServerStarting) return;
  pythonServerStarting = true;
  const forceOwnProcess = !!options.forceOwnProcess;
  const serverProbe = await probeWizstarServer();

  if (serverProbe.compatible && !forceOwnProcess) {
    console.log(`[wizstar] compatible server already running on port ${WIZSTAR_PORT}, skipping spawn`);
    pythonServerStarting = false;
    return;
  }

  if (serverProbe.running) {
    const reason = forceOwnProcess ? 'watchdog takeover' : (serverProbe.error || 'missing required API');
    console.warn(`[wizstar] ${serverProbe.compatible ? 'external' : 'incompatible'} server found on port ${WIZSTAR_PORT} (${reason}), replacing it`);
    await killProcessOnPort(WIZSTAR_PORT, 'TERM');
    let released = await waitForTcpPortRelease(WIZSTAR_PORT, 5000);
    if (!released) {
      console.warn(`[wizstar] port ${WIZSTAR_PORT} still busy after TERM, forcing release`);
      await killProcessOnPort(WIZSTAR_PORT, 'KILL');
      released = await waitForTcpPortRelease(WIZSTAR_PORT, 3000);
    }
    if (!released) {
      pythonServerStarting = false;
      throw new Error(`无法接管 Wizstar 后端端口 ${WIZSTAR_PORT}，旧服务仍在监听`);
    }
  }

  // Production: launch the bundled, self-contained backend exe (no system Python needed).
  // Dev: fall back to `python -m wizstar.wizstar serve` from the repo.
  const getOiiOiiEnv = () => {
    const sdkDir = app.isPackaged
      ? path.join(process.resourcesPath, 'oiioii-sdk')
      : path.join(__dirname, '..', 'oiioii-sdk');
    const dolaDir = app.isPackaged
      ? path.join(process.resourcesPath, 'dola-video-standalone')
      : path.join(__dirname, '..', 'dola-video-standalone');

    const framiaDir = app.isPackaged
      ? path.join(process.resourcesPath, 'framia-google-login')
      : path.join(__dirname, '..', 'framia-google-login');

    const env = {
      ...process.env,
      WIZSTAR_PORT: String(WIZSTAR_PORT),
      WIZSTAR_INTERNAL_TOKEN,
      OIIOII_SDK_DIR: sdkDir,
      DOLA_STANDALONE_DIR: dolaDir,
      FRAMIA_LOGIN_MODULE_DIR: framiaDir,
    };

    if (app.isPackaged) {
      env.OIIOII_NODE_BIN = process.execPath;
      env.DOLA_NODE_BIN = process.execPath;
      env.FRAMIA_NODE_BIN = process.execPath;
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    return env;
  };

  if (app.isPackaged) {
    const exePath = path.join(process.resourcesPath, 'backend', 'wizstar-server', 'wizstar-server.exe');
    if (!fs.existsSync(exePath)) {
      console.error(`[wizstar] bundled backend not found at ${exePath}`);
      pythonServerStarting = false;
      return;
    }
    pythonProcess = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      env: getOiiOiiEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } else {
    const pythonBin = process.env.PYTHON || 'python3';
    pythonProcess = spawn(pythonBin, ['-m', 'wizstar.wizstar', 'serve', '--port', String(WIZSTAR_PORT)], {
      cwd: path.join(__dirname, '..'),
      env: getOiiOiiEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  }

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[wizstar] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[wizstar] ${data.toString().trim()}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`[wizstar] process exited with code ${code}`);
    pythonProcess = null;
    pythonServerStarting = false;
  });

  pythonProcess.on('error', (err) => {
    console.error(`[wizstar] failed to start: ${err.message}`);
    pythonProcess = null;
    pythonServerStarting = false;
  });

  pythonProcess.once('spawn', () => {
    pythonServerStarting = false;
  });
}

function startBackendWatchdog() {
  if (backendWatchdogTimer) return;
  backendWatchdogTimer = setInterval(async () => {
    if (appIsQuitting || pythonServerStarting) return;
    const probe = await probeWizstarServer();
    if (probe.compatible) return;
    console.warn(`[wizstar] backend unavailable (${probe.error || 'not running'}), restarting local server`);
    try {
      await startPythonServer({ forceOwnProcess: true });
    } catch (error) {
      console.error(`[wizstar] backend restart failed: ${error?.message || error}`);
    }
  }, 5000);
}

function stopBackendWatchdog() {
  if (!backendWatchdogTimer) return;
  clearInterval(backendWatchdogTimer);
  backendWatchdogTimer = null;
}

async function waitForWizstarServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const probe = await probeWizstarServer();
    if (probe.compatible) return true;
    lastError = probe.error || 'server not compatible yet';
    await sleep(500);
  }
  console.warn(`[wizstar] backend not ready after ${timeoutMs}ms: ${lastError}`);
  return false;
}

function stopPythonServer() {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
}

function createApplicationMenu() {
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  };

  const template = process.platform === 'darwin'
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        editMenu,
      ]
    : [editMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false,
      backgroundThrottling: false,
    },
    backgroundColor: '#111113',
  });

  createApplicationMenu();

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]);
    menu.popup({ window: mainWindow });
  });

  const revealMainWindow = () => {
    if (!mainWindow) return;
    app.focus({ steal: true });
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (!mainWindow) return;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.focus();
    }, 300);
  };

  mainWindow.once('ready-to-show', revealMainWindow);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[window] did-fail-load:', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] render-process-gone:', details);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[window] did-finish-load:', mainWindow?.webContents.getURL());
  });

  // In development, load from Vite server. In production, load the built index.html.
  const isDev = !app.isPackaged;
  if (isDev) {
    const devPort = Number.parseInt(process.env.VITE_PORT || '5174', 10);
    const devHost = process.env.VITE_HOST || '127.0.0.1';
    const devUrl = `http://${devHost}:${Number.isNaN(devPort) ? 5174 : devPort}`;
    mainWindow.loadURL(devUrl).then(revealMainWindow).catch((e) => console.error('[window] failed to load dev URL:', e));
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).then(revealMainWindow).catch((e) => console.error('[window] failed to load file:', e));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startPythonServer();
  await waitForWizstarServer();
  startBackendWatchdog();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  appIsQuitting = true;
  stopBackendWatchdog();
  stopPythonServer();
});

// IPC handlers for UI interactions
const PERSISTED_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif',
]);

function persistLocalImageFile(value = '') {
  const sourcePath = filePathFromMaybeFileUrl(value);
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`参考图不存在：${value}`);
  }
  const extension = path.extname(sourcePath).toLowerCase();
  if (!PERSISTED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的参考图格式：${extension || '未知格式'}`);
  }
  const stat = fs.statSync(sourcePath);
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 24);
  const targetDir = path.join(app.getPath('userData'), 'reference-images');
  const targetPath = path.join(targetDir, `${cacheKey}${extension}`);
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(targetPath)) fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function persistSelectedImageIfNeeded(filePath = '') {
  if (!PERSISTED_IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase())) {
    return filePath;
  }
  try {
    return persistLocalImageFile(filePath);
  } catch (error) {
    console.warn(`[persist-local-image] fallback to original path: ${error.message}`);
    return filePath;
  }
}

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('select-file', async (event, filters) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || []
  });
  if (result.canceled) {
    return null;
  } else {
    return persistSelectedImageIfNeeded(result.filePaths[0]);
  }
});

ipcMain.handle('select-files', async (event, filters) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: filters || [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }]
  });
  if (result.canceled) {
    return [];
  } else {
    return result.filePaths.map(persistSelectedImageIfNeeded);
  }
});

ipcMain.handle('persist-local-image', async (_event, filePath) => {
  try {
    return { ok: true, path: persistLocalImageFile(filePath) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

function collectImageFilesFromDirectory(dirPath) {
  const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
  const collected = [];

  const walk = (currentDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
        collected.push(fullPath);
      }
    }
  };

  walk(dirPath);
  return collected.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
}

ipcMain.handle('select-image-directory', async () => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, filePaths: [] };
  const targetDir = result.filePaths[0];
  return { canceled: false, targetDir, filePaths: collectImageFilesFromDirectory(targetDir) };
});

function safeExportName(value, fallback) {
  const base = String(value || '').trim() || String(fallback || '').trim() || '未命名';
  return base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || '未命名';
}

function extFromImageSource(source = '') {
  const clean = String(source || '').split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase().replace(/^\./, '');
  return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext) ? ext : 'png';
}

function safeDecodeFilePath(value = '') {
  const text = String(value || '');
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function filePathFromMaybeFileUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      try {
        return decodeURIComponent(new URL(raw).pathname);
      } catch {
        return raw.replace(/^file:\/\/+/, '/');
      }
    }
  }
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/local/')) {
    try {
      const parsed = new URL(raw, WIZSTAR_BASE_URL);
      const isLocalMediaRoute = parsed.pathname === '/local/video' || parsed.pathname === '/local/image';
      if (isLocalMediaRoute) {
        const encodedPath = parsed.searchParams.get('path')
          || parsed.searchParams.get('file')
          || parsed.searchParams.get('filePath')
          || parsed.searchParams.get('localPath')
          || '';
        return encodedPath ? safeDecodeFilePath(encodedPath) : raw;
      }
    } catch {}
  }
  return raw;
}

const preparedDragFiles = new Map();

function dragPayloadKey(payload = {}) {
  return [payload.localPath || '', payload.fallbackLocalPath || '', payload.src || payload.url || '', payload.name || ''].join('|');
}

async function prepareImageDragFile(payload = {}) {
  const src = String(payload.src || payload.url || '').trim();
  const localPath = filePathFromMaybeFileUrl(payload.localPath || src);
  if (localPath && !/^https?:\/\//i.test(localPath) && !/^data:image\//i.test(localPath) && fs.existsSync(localPath)) {
    return localPath;
  }

  const safeName = safeExportName(payload.name, 'image');
  const tempDir = path.join(app.getPath('temp'), 'uijiem-drag-images');
  fs.mkdirSync(tempDir, { recursive: true });

  if (/^data:image\//i.test(src)) {
    const match = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (!match) throw new Error('图片 data-url 格式无效');
    const extMap = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = extMap[match[1].toLowerCase()] || 'png';
    const filePath = path.join(tempDir, `${safeName}-${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
    return filePath;
  }

  if (/^https?:\/\//i.test(src)) {
    const ext = extFromImageSource(src);
    const filePath = path.join(tempDir, `${safeName}-${Date.now()}.${ext}`);
    await downloadToFile(src, filePath);
    return filePath;
  }

  throw new Error('没有可拖出的图片文件');
}

function extFromVideoSource(source = '') {
  const clean = String(source || '').split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase().replace(/^\./, '');
  return ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'flv'].includes(ext) ? ext : 'mp4';
}

async function prepareVideoDragFile(payload = {}) {
  const src = String(payload.src || payload.url || '').trim();
  const localPathCandidates = [payload.localPath, payload.fallbackLocalPath, src]
    .map((value) => filePathFromMaybeFileUrl(value || ''))
    .filter(Boolean);
  const existingLocalPath = localPathCandidates.find((candidate) => (
    !/^https?:\/\//i.test(candidate)
    && !/^data:/i.test(candidate)
    && fs.existsSync(candidate)
  ));
  if (existingLocalPath) return existingLocalPath;

  const safeName = safeExportName(payload.name, 'video');
  const tempDir = path.join(app.getPath('temp'), 'uijiem-drag-videos');
  fs.mkdirSync(tempDir, { recursive: true });

  if (/^data:video\//i.test(src)) {
    const match = src.match(/^data:(video\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (!match) throw new Error('视频 data-url 格式无效');
    const extMap = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
    const ext = extMap[match[1].toLowerCase()] || 'mp4';
    const filePath = path.join(tempDir, `${safeName}-${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
    return filePath;
  }

  if (/^https?:\/\//i.test(src)) {
    const ext = extFromVideoSource(src);
    const filePath = path.join(tempDir, `${safeName}-${Date.now()}.${ext}`);
    await downloadToFile(src, filePath);
    return filePath;
  }

  throw new Error('没有可拖出的视频文件');
}

// Prepare remote/data-url images before dragstart; native dragging needs a real local file immediately.
ipcMain.handle('prepare-image-drag', async (_event, payload) => {
  try {
    const key = dragPayloadKey(payload || {});
    if (preparedDragFiles.has(key)) {
      const cached = preparedDragFiles.get(key);
      if (cached && fs.existsSync(cached)) return { ok: true, file: cached };
      preparedDragFiles.delete(key);
    }
    const file = await prepareImageDragFile(payload || {});
    preparedDragFiles.set(key, file);
    return { ok: true, file };
  } catch (e) {
    console.error('[prepare-image-drag] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

// Start native OS file drag for images so materials can be dragged into other apps.
ipcMain.on('start-image-drag', (event, payload) => {
  try {
    const key = dragPayloadKey(payload || {});
    const candidate = payload?.preparedFile || preparedDragFiles.get(key) || payload?.localPath || payload?.src || payload?.url || '';
    const file = filePathFromMaybeFileUrl(candidate);
    if (!file || /^https?:\/\//i.test(file) || /^data:image\//i.test(file) || !fs.existsSync(file)) {
      throw new Error('图片还没有准备好，请按住图片稍等一下再拖出');
    }
    const icon = nativeImage.createFromPath(file).resize({ width: 64, height: 64 });
    event.sender.startDrag({
      file,
      icon: icon.isEmpty() ? nativeImage.createEmpty() : icon,
    });
  } catch (e) {
    console.error('[drag-image] failed:', e);
    event.sender.send('image-drag-error', e.message || String(e));
  }
});

// Prepare video file for drag (download remote video to temp if needed).
ipcMain.handle('prepare-video-drag', async (_event, payload) => {
  try {
    const key = dragPayloadKey(payload || {});
    if (preparedDragFiles.has(key)) {
      const cached = preparedDragFiles.get(key);
      if (cached && fs.existsSync(cached)) return { ok: true, file: cached };
      preparedDragFiles.delete(key);
    }
    const file = await prepareVideoDragFile(payload || {});
    preparedDragFiles.set(key, file);
    return { ok: true, file };
  } catch (e) {
    console.error('[prepare-video-drag] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

function createVideoDragIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#111827"/>
      <rect x="12" y="16" width="40" height="32" rx="6" fill="#10b981"/>
      <path d="M28 24v16l13-8-13-8z" fill="#06120d"/>
      <rect x="17" y="20" width="4" height="4" rx="1" fill="#06120d" opacity="0.5"/>
      <rect x="17" y="30" width="4" height="4" rx="1" fill="#06120d" opacity="0.5"/>
      <rect x="17" y="40" width="4" height="4" rx="1" fill="#06120d" opacity="0.5"/>
      <rect x="43" y="20" width="4" height="4" rx="1" fill="#06120d" opacity="0.5"/>
      <rect x="43" y="30" width="4" height="4" rx="1" fill="#06120d" opacity="0.5"/>
      <rect x="43" y="40" width="4" height="4" rx="1" fill="#06120d" opacity="0.5"/>
    </svg>
  `.trim();
  const svgIcon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  if (!svgIcon.isEmpty()) return svgIcon.resize({ width: 64, height: 64 });
  const appIcon = process.platform === 'darwin'
    ? nativeImage.createFromNamedImage('NSApplicationIcon')
    : nativeImage.createEmpty();
  return appIcon.isEmpty() ? nativeImage.createEmpty() : appIcon.resize({ width: 64, height: 64 });
}

// Start native OS file drag for videos so materials can be dragged into other apps (e.g. 剪映).
ipcMain.on('start-video-drag', (event, payload) => {
  try {
    const key = dragPayloadKey(payload || {});
    const candidates = [
      payload?.preparedFile,
      preparedDragFiles.get(key),
      payload?.localPath,
      payload?.fallbackLocalPath,
      payload?.src,
      payload?.url,
    ];
    const file = candidates
      .map((candidate) => filePathFromMaybeFileUrl(candidate || ''))
      .find((candidate) => (
        candidate
        && !/^https?:\/\//i.test(candidate)
        && !/^data:/i.test(candidate)
        && fs.existsSync(candidate)
      ));
    if (!file) {
      throw new Error('视频还没有准备好，请按住稍等一下再拖出');
    }
    const icon = createVideoDragIcon();
    event.sender.startDrag({
      file,
      icon,
    });
  } catch (e) {
    console.error('[drag-video] failed:', e);
    event.sender.send('video-drag-error', e.message || String(e));
  }
});

// Export a list of remote materials into a chosen folder, named by sequence index.
// items: [{ url, index, ext }]; when targetDir omitted, prompts for a folder.
ipcMain.handle('export-videos', async (event, payload) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const { items = [], targetDir: presetDir } = payload || {};
  if (!items.length) return { ok: false, error: 'no items' };

  let targetDir = presetDir;
  if (!targetDir) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    targetDir = result.filePaths[0];
  }

  const results = [];
  const usedFileNames = new Set();
  for (const item of items) {
    const ext = (item.ext || 'mp4').replace(/^\./, '');
    const rawBaseName = safeExportName(item.name, item.index);
    let fileName = `${rawBaseName}.${ext}`;
    let suffix = 2;
    while (usedFileNames.has(fileName.toLowerCase()) || fs.existsSync(path.join(targetDir, fileName))) {
      fileName = `${rawBaseName}-${suffix++}.${ext}`;
    }
    usedFileNames.add(fileName.toLowerCase());
    const destPath = path.join(targetDir, fileName);
    try {
      const localPath = filePathFromMaybeFileUrl(item.localPath || '');
      if (localPath && fs.existsSync(localPath)) {
        fs.copyFileSync(localPath, destPath);
      } else if (item.url) {
        await downloadToFile(item.url, destPath);
      } else {
        throw new Error('没有可导出的本地文件或远程地址');
      }
      results.push({ index: item.index, name: rawBaseName, ok: true, path: destPath });
    } catch (e) {
      results.push({ index: item.index, name: rawBaseName, ok: false, error: e.message || String(e) });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount > 0, targetDir, total: items.length, okCount, results };
});

ipcMain.handle('download-generated-media', async (_event, payload = {}) => {
  try {
    const { url, defaultName = 'generated', ext, channel = '', projectId = '', segmentId = '' } = payload || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: '没有可下载的远程地址' };
    const urlPath = (() => {
      try { return new URL(url).pathname || ''; } catch { return ''; }
    })();
    const inferredExt = String(ext || path.extname(urlPath).replace(/^\./, '') || (url.includes('image') ? 'png' : 'mp4')).toLowerCase();
    const safeExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'm4v'].includes(inferredExt) ? inferredExt : 'png';
    const dirParts = ['generated-media'];
    const safeChannel = safeExportName(channel, '').replace(/\s+/g, '-');
    const safeProjectId = safeExportName(projectId, '').replace(/\s+/g, '-');
    const safeSegmentId = safeExportName(segmentId, '').replace(/\s+/g, '-');
    if (safeChannel) dirParts.push(safeChannel);
    if (safeProjectId) dirParts.push(`project-${safeProjectId}`);
    if (safeSegmentId) dirParts.push(`segment-${safeSegmentId}`);
    const targetDir = path.join(app.getPath('userData'), ...dirParts);
    fs.mkdirSync(targetDir, { recursive: true });
    const baseName = safeExportName(defaultName, `generated_${Date.now()}`);
    let fileName = `${baseName}.${safeExt}`;
    let suffix = 2;
    while (fs.existsSync(path.join(targetDir, fileName))) fileName = `${baseName}-${suffix++}.${safeExt}`;
    const filePath = path.join(targetDir, fileName);
    await downloadToFile(url, filePath);
    return { ok: true, filePath };
  } catch (e) {
    console.error('[download-generated-media] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

// Save merged image bytes (PNG/JPEG) from renderer-side canvas to a local file.
// payload: {
//   bytes: Uint8Array | number[] | ArrayBuffer,
//   ext: 'png' | 'jpg',
//   defaultDir?: string,         // 优先目录；不存在会自动创建
//   defaultName?: string,        // 默认文件名（带或不带扩展）
//   silent?: boolean,            // true: 不弹保存对话框，直接写到 defaultDir
// }
ipcMain.handle('save-merged-image', async (_event, payload = {}) => {
  try {
    const { bytes, ext = 'png', defaultDir, defaultName, silent = false } = payload || {};
    if (!bytes) return { ok: false, error: '没有可保存的数据' };

    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);

    const cleanExt = String(ext || 'png').replace(/^\./, '').toLowerCase();
    const finalExt = ['png', 'jpg', 'jpeg'].includes(cleanExt) ? (cleanExt === 'jpeg' ? 'jpg' : cleanExt) : 'png';

    const baseName = safeExportName(
      String(defaultName || '').replace(/\.(png|jpe?g)$/i, ''),
      `merge_${Date.now()}`,
    );

    const fallbackDir = path.join(app.getPath('temp'), 'uijiem-merged');
    const targetDirCandidate = defaultDir && String(defaultDir).trim() ? String(defaultDir) : fallbackDir;

    let targetPath;
    if (silent) {
      try {
        fs.mkdirSync(targetDirCandidate, { recursive: true });
      } catch (e) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      const dirToUse = fs.existsSync(targetDirCandidate) ? targetDirCandidate : fallbackDir;
      let fileName = `${baseName}.${finalExt}`;
      let suffix = 2;
      while (fs.existsSync(path.join(dirToUse, fileName))) {
        fileName = `${baseName}-${suffix++}.${finalExt}`;
      }
      targetPath = path.join(dirToUse, fileName);
    } else {
      try {
        fs.mkdirSync(targetDirCandidate, { recursive: true });
      } catch (_) {}
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存合并图片',
        defaultPath: path.join(targetDirCandidate, `${baseName}.${finalExt}`),
        filters: finalExt === 'jpg'
          ? [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }, { name: 'PNG 图片', extensions: ['png'] }]
          : [{ name: 'PNG 图片', extensions: ['png'] }, { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      targetPath = result.filePath;
    }

    fs.writeFileSync(targetPath, buffer);
    return { ok: true, filePath: targetPath };
  } catch (e) {
    console.error('[save-merged-image] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

// Reveal a file in the OS file explorer.
ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
  try {
    if (!filePath) return { ok: false, error: 'no path' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Mocking some system commands for batch video actions
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('open-wizstar-browser', async (_event, accountId) => {
  try {
    const numericAccountId = Number(accountId) || 0;
    if (!numericAccountId) return { ok: false, error: '账号 ID 无效' };
    return await openWizstarAccountWindow(numericAccountId);
  } catch (error) {
    const message = String(error?.message || error || '打开渠道一网页窗口失败')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '***@***')
      .replace(/(cookie|authorization|token|osduss|passOsRefreshTk)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .slice(0, 300);
    console.error('[open-wizstar-browser] failed:', message);
    return { ok: false, error: message };
  }
});

ipcMain.handle('wizstar-google-login', async (event, mailboxId) => {
  try {
    const response = await fetchJson(`${WIZSTAR_BASE_URL}/internal/mailboxes/${mailboxId}`, {
      headers: { 'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN },
    });
    const mailbox = response.data;
    if (!mailbox) return { ok: false, error: 'mailbox not found' };
    if (mailbox.provider !== 'google') {
      return { ok: false, error: '该凭证是 Microsoft 邮箱，不能用于渠道一 Google 登录' };
    }
    if (!mailbox.google_password) {
      return { ok: false, error: '该邮箱没有保存 Google 密码，请重新批量导入邮箱凭证' };
    }

    const sender = event.sender;
    const result = await openWizstarGoogleLoginWindow(mailbox, {
      onStep: (step, data) => {
        if (!sender.isDestroyed()) sender.send('wizstar-login-progress', { step, data });
      },
    });
    if (!result?.ok) {
      return {
        ok: false,
        canceled: Boolean(result?.canceled),
        error: result?.error || '渠道一 Google 登录失败',
      };
    }
    return { ok: true };
  } catch (e) {
    console.error('[wizstar-google-login] failed:', e?.message || String(e));
    return { ok: false, error: e.message || String(e) };
  }
});

// 渠道一批量 Google 登录：每个账号使用独立 profile，并按账号回传进度。
ipcMain.handle('wizstar-batch-login', async (event, payload = {}) => {
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  if (accounts.length === 0) return { ok: false, error: '请提供至少一个 Google 账号' };

  const sender = event.sender;
  const concurrency = Math.max(1, Math.min(Number.parseInt(payload.concurrency, 10) || 1, 3, accounts.length));

  try {
    const results = new Array(accounts.length);
    let cursor = 0;

    const sendProgress = (index, email, step, data = {}) => {
      if (!sender.isDestroyed()) sender.send('wizstar-batch-progress', { index, email, step, data });
    };

    const runOne = async (account, index) => {
      const email = String(account?.email || '').trim();
      const password = String(account?.password || '');
      if (!email || !password) return { ok: false, index, email, error: '邮箱或密码为空' };

      sendProgress(index, email, 'starting');
      try {
        const mailboxResponse = await fetch(`${WIZSTAR_BASE_URL}/mailboxes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, google_password: password, provider: 'google' }),
        });
        const mailboxPayload = await mailboxResponse.json();
        if (!mailboxResponse.ok) throw new Error(mailboxPayload.detail || '保存 Google 账号失败');
        const mailbox = mailboxPayload.data;
        if (!mailbox?.id) throw new Error('保存 Google 账号后未返回邮箱 ID');
        if (mailbox.provider !== 'google') {
          throw new Error('该邮箱已作为 Microsoft 邮箱保存，不能同时用于 Google 登录');
        }

        sendProgress(index, email, 'mailbox_saved');
        const loginResult = await openWizstarGoogleLoginWindow({
          ...mailbox,
          email,
          google_password: password,
        }, {
          onStep: (step, data) => sendProgress(index, email, step, data),
        });
        if (!loginResult?.ok) {
          throw new Error(loginResult?.error || '渠道一 Google 登录失败');
        }

        sendProgress(index, email, 'saved_to_db', { ok: true });
        return { ok: true, index, email };
      } catch (error) {
        const message = error.message || String(error);
        sendProgress(index, email, 'failed', { error: message });
        return { ok: false, index, email, error: message };
      }
    };

    const worker = async () => {
      while (cursor < accounts.length) {
        const index = cursor++;
        results[index] = await runOne(accounts[index], index);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const succeeded = results.filter((result) => result?.ok).length;
    const failed = results.length - succeeded;
    if (!sender.isDestroyed()) {
      sender.send('wizstar-batch-progress', {
        step: 'batch_complete',
        data: { total: results.length, succeeded, failed },
      });
    }
    return { ok: true, results, succeeded, failed };
  } catch (error) {
    console.error('[wizstar-batch-login] failed:', error);
    return { ok: false, error: error.message || String(error) };
  }
});

// OreateAI 渠道八批量注册登录 — 每个任务使用独立 Chromium 会话，由主进程限制并发。
ipcMain.handle('oreateai-register-login', async (event, payload = {}) => {
  const sender = event.sender;
  let mailboxes;
  try {
    mailboxes = await getOreateaiRegistrationMailboxes({
      mailboxIds: payload.mailboxIds,
      count: payload.count,
    });
  } catch (error) {
    return { ok: false, error: error.message || String(error), results: [], succeeded: 0, failed: 0 };
  }
  const count = mailboxes.length;
  const concurrency = Math.max(1, Math.min(Number.parseInt(payload.concurrency, 10) || 1, 5, count));
  const results = new Array(count);
  let cursor = 0;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  const sendProgress = (message) => {
    if (!sender.isDestroyed()) sender.send('oreateai-login-progress', message);
  };

  const registerOne = async (mailbox, index) => {
    try {
      const state = await registerOreateaiWithBrowser({
        app,
        BrowserWindow,
        mailbox,
        visible: payload.visible !== false,
        keepOpen: payload.keepOpen === true,
        onStep: (step, data) => sendProgress({ step, index, total: count, data }),
      });
      const response = await fetch(`${WIZSTAR_BASE_URL}/oreateai/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: state.email,
          password: state.password,
          cookie: state.cookie,
          cookies: state.cookies,
          user_agent: state.user_agent,
          location: state.location,
          note: 'Electron Chromium 自动注册登录（小苹果取件）',
        }),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.detail || '渠道8账号保存失败');
      await updateMailboxChannelUsage(mailbox.id, 'oreateai', 'registered', {
        accountEmail: state.email,
      }).catch((usageError) => {
        console.warn('[oreateai-register-login] usage update failed:', usageError.message || usageError);
      });
      succeeded += 1;
      return {
        ok: true,
        index,
        mailboxId: mailbox.id,
        email: state.email,
        cookieCount: state.cookies.length,
        account: saved.data,
      };
    } catch (error) {
      failed += 1;
      console.error(`[oreateai-register-login] task ${index + 1} failed:`, error);
      await updateMailboxChannelUsage(mailbox.id, 'oreateai', 'failed', {
        accountEmail: mailbox.email,
        error: error.message || String(error),
      }).catch((usageError) => {
        console.warn('[oreateai-register-login] failure usage update failed:', usageError.message || usageError);
      });
      return {
        ok: false,
        index,
        mailboxId: mailbox.id,
        email: mailbox.email,
        error: error.message || String(error),
      };
    } finally {
      completed += 1;
      sendProgress({ step: 'batch_progress', index, total: count, completed, succeeded, failed });
    }
  };

  const worker = async () => {
    while (cursor < count) {
      const index = cursor;
      cursor += 1;
      results[index] = await registerOne(mailboxes[index], index);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    sendProgress({ step: 'batch_complete', total: count, completed, succeeded, failed });
    const first = results[0];
    return {
      ok: true,
      results,
      total: count,
      succeeded,
      failed,
      email: count === 1 && first?.ok ? first.email : undefined,
      cookieCount: count === 1 && first?.ok ? first.cookieCount : undefined,
      account: count === 1 && first?.ok ? first.account : undefined,
    };
  } catch (error) {
    console.error('[oreateai-register-login] failed:', error);
    return { ok: false, error: error.message || String(error), results, succeeded, failed };
  }
});

ipcMain.handle('oreateai-video-capabilities', async (_event, payload = {}) => {
  try {
    const client = await createOreateaiVideoClient(payload.accountId);
    const capabilities = await client.getCapabilities({ force: true });
    return { ok: true, data: publicOreateaiCapabilities(capabilities) };
  } catch (error) {
    const message = safeOreateaiError(error);
    console.error('[oreateai-video-capabilities] failed:', message);
    return { ok: false, error: message };
  }
});

ipcMain.handle('oreateai-select-assets', async (_event, payload = {}) => {
  if (!mainWindow) return { ok: false, error: '主窗口不可用' };
  try {
    const allowVideos = payload.allowVideos === true;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: allowVideos ? '选择 OreateAI 图片或视频素材' : '选择 OreateAI 图片素材',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: allowVideos ? '图片与视频' : '图片',
        extensions: allowVideos
          ? ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']
          : ['jpg', 'jpeg', 'png', 'webp', 'bmp'],
      }],
    });
    if (result.canceled) return { ok: true, canceled: true, assets: [] };
    const assets = await inspectOreateaiAssetPaths(result.filePaths);
    return { ok: true, canceled: false, assets };
  } catch (error) {
    return { ok: false, error: safeOreateaiError(error) };
  }
});

ipcMain.handle('oreateai-generate-video', async (event, payload = {}) => {
  const requestId = String(payload.requestId || crypto.randomUUID()).slice(0, 100);
  const sendProgress = (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('oreateai-video-progress', { requestId, ...normalizeOreateaiProgress(progress) });
    }
  };
  try {
    const assets = await inspectOreateaiAssetPaths(payload.assetPaths || []);
    const client = await createOreateaiVideoClient(payload.accountId);
    const result = await client.generate({
      modelName: String(payload.modelName || ''),
      scene: String(payload.scene || ''),
      prompt: String(payload.prompt || ''),
      ratio: String(payload.ratio || ''),
      resolution: String(payload.resolution || ''),
      duration: Number(payload.duration),
      audio: payload.audio === true,
      assets: assets.map((asset) => ({ path: asset.path, durationSec: asset.durationSec || 0 })),
    }, { onProgress: sendProgress });
    sendProgress({ stage: 'complete' });
    return {
      ok: true,
      requestId,
      result: {
        url: result.url,
        chatId: result.chatId,
        modelName: result.modelName,
        scene: result.scene,
      },
    };
  } catch (error) {
    const message = safeOreateaiError(error);
    console.error('[oreateai-generate-video] failed:', message);
    sendProgress({ stage: 'failed' });
    return { ok: false, requestId, error: message };
  }
});

ipcMain.handle('oreateai-download-video', async (_event, payload = {}) => {
  try {
    const url = new URL(String(payload.url || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.oreateai.com' || !/\.mp4$/i.test(url.pathname)) {
      throw new Error('只允许下载 OreateAI CDN 返回的 MP4 文件');
    }
    const fallbackName = `OreateAI-${Date.now()}.mp4`;
    const requestedName = path.basename(String(payload.fileName || fallbackName));
    const fileName = `${safeExportName(path.basename(requestedName, path.extname(requestedName)), 'OreateAI')}.mp4`;
    let outputPath = '';
    if (payload.directory || payload.autoSave === true) {
      const directory = payload.directory ? String(payload.directory) : app.getPath('downloads');
      if (!path.isAbsolute(directory)) throw new Error('下载目录必须是绝对本地路径');
      const stat = await fs.promises.stat(directory).catch(() => null);
      if (!stat?.isDirectory()) throw new Error('下载目录不存在');
      outputPath = path.join(directory, fileName);
    } else {
      const selection = await dialog.showSaveDialog(mainWindow || undefined, {
        title: '保存 OreateAI 视频',
        defaultPath: path.join(app.getPath('downloads'), fileName),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      });
      if (selection.canceled || !selection.filePath) return { ok: true, canceled: true };
      outputPath = selection.filePath.toLowerCase().endsWith('.mp4') ? selection.filePath : `${selection.filePath}.mp4`;
    }
    const sdk = await importOreateaiSdk();
    const result = await sdk.downloadAndVerifyMp4(url.href, outputPath);
    return { ok: true, canceled: false, result };
  } catch (error) {
    const message = safeOreateaiError(error);
    console.error('[oreateai-download-video] failed:', message);
    return { ok: false, error: message };
  }
});

ipcMain.handle('oreateai-open-capture', async (event, accountId) => {
  const sender = event.sender;
  const sendProgress = (step, data = {}) => {
    if (!sender.isDestroyed()) sender.send('oreateai-capture-progress', { step, data });
  };

  try {
    const response = await fetch(`${WIZSTAR_BASE_URL}/internal/oreateai/accounts/${Number(accountId)}/session`, {
      headers: { 'X-Wizstar-Internal-Token': WIZSTAR_INTERNAL_TOKEN },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || '读取渠道八登录态失败');
    const capture = await openOreateaiCaptureBrowser({
      app,
      BrowserWindow,
      account: payload.data,
      onStep: sendProgress,
    });
    return { ok: true, ...capture };
  } catch (error) {
    console.error('[oreateai-open-capture] failed:', error);
    sendProgress('capture_failed', { error: error.message || String(error) });
    return { ok: false, error: error.message || String(error) };
  }
});

// Lovart Google OAuth login — spawns the lovart-google-login module as a child process
// and streams progress events back to the renderer via 'lovart-login-progress'.
ipcMain.handle('lovart-google-login', async (event, payload = {}) => {
  const { email, password, profileDir, proxy, visible = true, keepOpen = false, startUrl } = payload || {};
  if (!email || !password) return { ok: false, error: 'Email and password are required' };

  const sender = event.sender;
  try {
    const loginDir = app.isPackaged
      ? path.join(process.resourcesPath, 'lovart-google-login')
      : path.join(__dirname, '..', 'lovart-google-login');
    const nodeBin = process.execPath;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    const args = [
      path.join(loginDir, 'index.mjs'),
      '--email', email,
      '--password-stdin',
    ];
    if (!visible) args.push('--headless');
    if (keepOpen) args.push('--keep-open');
    if (profileDir) { args.push('--profile'); args.push(profileDir); }
    if (proxy) { args.push('--proxy'); args.push(proxy); }
    if (startUrl) { args.push('--start-url'); args.push(startUrl); }

    const child = spawn(nodeBin, args, {
      cwd: loginDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    child.stdin.write(String(password));
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      for (const line of text.split('\n')) {
        const match = line.match(/^\[lovart-login\]\s+(\S+)(?::\s*(.*))?$/);
        if (match) {
          const step = match[1];
          let stepData = {};
          try { stepData = JSON.parse(match[2] || '{}'); } catch {}
          sender.send('lovart-login-progress', { step, data: stepData });
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => {
        console.error('[lovart-login] spawn error:', err);
        resolve(-1);
      });
    });

    if (exitCode !== 0) {
      const errorMsg = stderr.trim() || stdout.match(/\[lovart-login\]\s+failed:\s*(.+)/)?.[1] || stdout.trim() || `exit code ${exitCode}`;
      return { ok: false, error: errorMsg, raw: stdout };
    }

    const hasCookie = stdout.includes('cookie: ok');
    const locationMatch = stdout.match(/location:\s*(\S+)/);
    const stateMatch = stdout.match(/\[lovart-login\]\s+state_json:\s*(.+)/);

    let state = null;
    if (stateMatch) {
      try { state = JSON.parse(stateMatch[1].trim()); } catch {}
    }

    let saved = null;
    if (state) {
      try {
        const resp = await fetch(`${WIZSTAR_BASE_URL}/lovart/accounts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            cookie: state.cookie || '',
            cookies: Array.isArray(state.cookies) ? state.cookies : [],
            user_agent: state.user_agent || '',
            location: state.location || locationMatch?.[1] || '',
            local_storage: state.local_storage || {},
            session_storage: state.session_storage || {},
            indexed_db: Array.isArray(state.indexed_db) ? state.indexed_db : [],
            note: `Google login: ${email}`,
          }),
        });
        saved = await resp.json();
      } catch (e) {
        saved = { error: e.message };
      }
    }

    return {
      ok: true,
      hasCookie,
      location: locationMatch?.[1] || '',
      state,
      saved,
      raw: stdout,
    };
  } catch (e) {
    console.error('[lovart-login] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

// Lovart batch Google login — runs multiple Lovart accounts with isolated profiles.
ipcMain.handle('lovart-batch-login', async (event, payload = {}) => {
  const {
    concurrency = 1,
    visible = true,
    keepOpen = false,
    proxy,
    startUrl,
    useMailboxPool = false,
  } = payload || {};
  let accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  if (useMailboxPool) {
    try {
      accounts = await claimPasswordRegistrationAccounts('lovart', {
        count: payload.count,
        mailboxIds: payload.mailboxIds,
      });
    } catch (error) {
      return { ok: false, error: error.message || String(error), results: [], succeeded: 0, failed: 0 };
    }
  }
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, error: 'No accounts provided' };
  }

  const sender = event.sender;
  const loginDir = app.isPackaged
    ? path.join(process.resourcesPath, 'lovart-google-login')
    : path.join(__dirname, '..', 'lovart-google-login');
  const nodeBin = process.execPath;
  const baseEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const maxConcurrency = Math.max(1, Math.min(parseInt(concurrency, 10) || 1, 3, accounts.length));

  function parseState(stdout) {
    const stateMatch = stdout.match(/\[lovart-login\]\s+state_json:\s*(.+)/);
    if (!stateMatch) return null;
    try { return JSON.parse(stateMatch[1].trim()); } catch { return null; }
  }

  async function saveToBackend(state, email) {
    try {
      const resp = await fetch(`${WIZSTAR_BASE_URL}/lovart/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          cookie: state.cookie || '',
          cookies: Array.isArray(state.cookies) ? state.cookies : [],
          user_agent: state.user_agent || '',
          location: state.location || '',
          local_storage: state.local_storage || {},
          session_storage: state.session_storage || {},
          indexed_db: Array.isArray(state.indexed_db) ? state.indexed_db : [],
          note: `Google login: ${email}`,
        }),
      });
      const payload = await resp.json().catch(() => ({}));
      return resp.ok ? payload : { error: payload.detail || `HTTP ${resp.status}` };
    } catch (e) {
      return { error: e.message };
    }
  }

  function runOneLogin(email, password, index) {
    return new Promise((resolve) => {
      const profileDir = path.join(loginDir, '.lovart-profiles', `batch-${index}-${Date.now()}`);
      const args = [
        path.join(loginDir, 'index.mjs'),
        '--email', email,
        '--password-stdin',
        '--profile', profileDir,
      ];
      if (!visible) args.push('--headless');
      if (keepOpen) args.push('--keep-open');
      if (proxy) { args.push('--proxy'); args.push(proxy); }
      if (startUrl) { args.push('--start-url'); args.push(startUrl); }

      const child = spawn(nodeBin, args, {
        cwd: loginDir,
        env: baseEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });

      child.stdin.on('error', () => {});
      child.stdin.write(`${String(password)}\n`);
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        for (const line of text.split('\n')) {
          const match = line.match(/^\[lovart-login\]\s+(\S+)(?::\s*(.*))?$/);
          if (match) {
            const step = match[1];
            let stepData = {};
            try { stepData = JSON.parse(match[2] || '{}'); } catch {}
            sender.send('lovart-batch-progress', { index, email, step, data: stepData });
          }
        }
      });

      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (exitCode) => {
        const state = parseState(stdout);
        if (exitCode === 0 && state) {
          resolve({ ok: true, email, index, state });
        } else {
          const errorMsg = stderr.trim() || stdout.match(/\[lovart-login\]\s+failed:\s*(.+)/)?.[1] || `exit code ${exitCode}`;
          resolve({ ok: false, email, index, error: errorMsg });
        }
      });

      child.on('error', () => {
        resolve({ ok: false, email, index, error: 'spawn error' });
      });
    });
  }

  const results = [];
  const queue = accounts.map((acc, i) => ({ ...acc, index: i }));
  const running = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < maxConcurrency && queue.length > 0) {
      const item = queue.shift();
      const promise = runOneLogin(item.email, item.password, item.index).then(async (result) => {
        if (result.ok && result.state) {
          const saveResult = await saveToBackend(result.state, item.email);
          result.saved = saveResult;
          if (saveResult.error) {
            result.ok = false;
            result.error = saveResult.error;
          }
          sender.send('lovart-batch-progress', { index: item.index, email: item.email, step: 'saved_to_db', data: { ok: !saveResult.error } });
          await updateMailboxChannelUsage(item.mailboxId, 'lovart', saveResult.error ? 'failed' : 'registered', {
            accountEmail: item.email,
            error: saveResult.error || '',
          }).catch(() => {});
        } else {
          await updateMailboxChannelUsage(item.mailboxId, 'lovart', 'failed', {
            accountEmail: item.email,
            error: result.error || 'Lovart login failed',
          }).catch(() => {});
        }
        return result;
      });
      const wrapped = promise.then((result) => ({ result, wrapped }));
      running.push(wrapped);
      sender.send('lovart-batch-progress', { index: item.index, email: item.email, step: 'starting', data: {} });
    }
    const { result, wrapped } = await Promise.race(running);
    results.push(result);
    const idx = running.indexOf(wrapped);
    if (idx >= 0) running.splice(idx, 1);
  }

  results.sort((a, b) => a.index - b.index);
  const succeeded = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  sender.send('lovart-batch-progress', { step: 'batch_complete', data: { total: results.length, succeeded, failed } });
  return { ok: true, results, succeeded, failed };
});

// Dola Google OAuth login — spawns the dola-google-login module as a child process
// and streams progress events back to the renderer via 'dola-login-progress'.
ipcMain.handle('dola-google-login', async (event, payload = {}) => {
  const { email, password, profileDir, proxy, visible = true, keepOpen = false } = payload || {};
  if (!email || !password) return { ok: false, error: 'Email and password are required' };

  const sender = event.sender;
  try {
    const loginDir = app.isPackaged
      ? path.join(process.resourcesPath, 'dola-google-login')
      : path.join(__dirname, '..', 'dola-google-login');
    const nodeBin = app.isPackaged ? process.execPath : process.execPath;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    const args = [
      path.join(loginDir, 'index.mjs'),
      '--email', email,
      '--password', password,
    ];
    if (!visible) args.push('--headless');
    if (keepOpen) args.push('--keep-open');
    if (profileDir) { args.push('--profile'); args.push(profileDir); }
    if (proxy) { args.push('--proxy'); args.push(proxy); }

    const child = spawn(nodeBin, args, {
      cwd: loginDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // Parse progress lines like "[dola-login] step: {...}"
      for (const line of text.split('\n')) {
        const match = line.match(/^\[dola-login\]\s+(\S+)(?::\s*(.*))?$/);
        if (match) {
          const step = match[1];
          let stepData = {};
          try { stepData = JSON.parse(match[2] || '{}'); } catch {}
          sender.send('dola-login-progress', { step, data: stepData });
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => {
        console.error('[dola-login] spawn error:', err);
        resolve(-1);
      });
    });

    if (exitCode !== 0) {
      const errorMsg = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
      return { ok: false, error: errorMsg };
    }

    // Parse the final success output for state info
    const hasCookie = stdout.includes('cookie: ok');
    const hasAccessToken = stdout.includes('access_token: ok');
    const locationMatch = stdout.match(/location:\s*(\S+)/);
    const stateMatch = stdout.match(/\[dola-login\]\s+state_json:\s*(.+)/);

    let state = null;
    if (stateMatch) {
      try { state = JSON.parse(stateMatch[1].trim()); } catch {}
    }

    // Save to wizstar backend if we got state with cookie
    let saved = null;
    if (state && state.cookie) {
      try {
        const resp = await fetch(`${WIZSTAR_BASE_URL}/dola/accounts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: email,
            cookie: state.cookie,
            note: `Google login: ${email}`,
            user_agent: state.user_agent,
            device_id: state.device_id,
            web_id: state.web_id,
            tea_uuid: state.tea_uuid,
            web_tab_id: state.web_tab_id,
            fp: state.fp,
            ms_token: state.ms_token,
          }),
        });
        saved = await resp.json();
      } catch (e) {
        saved = { error: e.message };
      }
    }

    return {
      ok: true,
      hasCookie,
      hasAccessToken,
      location: locationMatch?.[1] || '',
      state,
      saved,
      raw: stdout,
    };
  } catch (e) {
    console.error('[dola-login] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

// Dola batch Google login — runs multiple accounts concurrently
ipcMain.handle('dola-batch-login', async (event, payload = {}) => {
  const { concurrency = 2, useMailboxPool = false } = payload || {};
  let accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  if (useMailboxPool) {
    try {
      accounts = await claimPasswordRegistrationAccounts('dola', {
        count: payload.count,
        mailboxIds: payload.mailboxIds,
      });
    } catch (error) {
      return { ok: false, error: error.message || String(error), results: [], succeeded: 0, failed: 0 };
    }
  }
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, error: 'No accounts provided' };
  }

  const sender = event.sender;
  const loginDir = app.isPackaged
    ? path.join(process.resourcesPath, 'dola-google-login')
    : path.join(__dirname, '..', 'dola-google-login');
  const nodeBin = process.execPath;
  const baseEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  function runOneLogin(email, password, index) {
    return new Promise((resolve) => {
      const profileDir = path.join(loginDir, '.dola-profiles', `batch-${index}-${Date.now()}`);
      const args = [
        path.join(loginDir, 'index.mjs'),
        '--email', email,
        '--password', password,
        '--profile', profileDir,
      ];

      const child = spawn(nodeBin, args, {
        cwd: loginDir,
        env: baseEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        for (const line of text.split('\n')) {
          const match = line.match(/^\[dola-login\]\s+(\S+)(?::\s*(.*))?$/);
          if (match) {
            const step = match[1];
            let stepData = {};
            try { stepData = JSON.parse(match[2] || '{}'); } catch {}
            sender.send('dola-batch-progress', { index, email, step, data: stepData });
          }
        }
      });

      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (exitCode) => {
        const stateMatch = stdout.match(/\[dola-login\]\s+state_json:\s*(.+)/);
        if (exitCode === 0 && stateMatch) {
          try {
            const state = JSON.parse(stateMatch[1].trim());
            resolve({ ok: true, email, index, state });
          } catch {
            resolve({ ok: false, email, index, error: 'Failed to parse state' });
          }
        } else {
          const errorMsg = stderr.trim() || stdout.match(/\[dola-login\]\s+failed:\s*(.+)/)?.[1] || `exit code ${exitCode}`;
          resolve({ ok: false, email, index, error: errorMsg });
        }
      });

      child.on('error', () => {
        resolve({ ok: false, email, index, error: 'spawn error' });
      });
    });
  }

  async function saveToBackend(state, email) {
    try {
      const resp = await fetch(`${WIZSTAR_BASE_URL}/dola/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: email,
          cookie: state.cookie,
          note: `Google login: ${email}`,
          user_agent: state.user_agent,
          device_id: state.device_id,
          web_id: state.web_id,
          tea_uuid: state.tea_uuid,
          web_tab_id: state.web_tab_id,
          fp: state.fp,
          ms_token: state.ms_token,
        }),
      });
      const payload = await resp.json().catch(() => ({}));
      return resp.ok ? payload : { error: payload.detail || `HTTP ${resp.status}` };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Run with concurrency limit
  const results = [];
  const queue = accounts.map((acc, i) => ({ ...acc, index: i }));
  const running = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < concurrency && queue.length > 0) {
      const item = queue.shift();
      const promise = runOneLogin(item.email, item.password, item.index).then(async (result) => {
        if (result.ok && result.state) {
          const saveResult = await saveToBackend(result.state, item.email);
          result.saved = saveResult;
          if (saveResult.error) {
            result.ok = false;
            result.error = saveResult.error;
          }
          sender.send('dola-batch-progress', { index: item.index, email: item.email, step: 'saved_to_db', data: { ok: !saveResult.error } });
          await updateMailboxChannelUsage(item.mailboxId, 'dola', saveResult.error ? 'failed' : 'registered', {
            accountEmail: item.email,
            error: saveResult.error || '',
          }).catch(() => {});
        } else {
          await updateMailboxChannelUsage(item.mailboxId, 'dola', 'failed', {
            accountEmail: item.email,
            error: result.error || 'Dola login failed',
          }).catch(() => {});
        }
        return result;
      });
      const wrapped = promise.then((result) => ({ result, wrapped }));
      running.push(wrapped);
      sender.send('dola-batch-progress', { index: item.index, email: item.email, step: 'starting', data: {} });
    }
    const { result, wrapped } = await Promise.race(running);
    results.push(result);
    const idx = running.indexOf(wrapped);
    if (idx >= 0) running.splice(idx, 1);
  }

  results.sort((a, b) => a.index - b.index);
  const succeeded = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  sender.send('dola-batch-progress', { step: 'batch_complete', data: { total: results.length, succeeded, failed } });

  return { ok: true, results, succeeded, failed };
});

ipcMain.handle('wizstar-server-status', async () => {
  try {
    return await new Promise((resolve) => {
      const req = http.get(`${WIZSTAR_BASE_URL}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ running: true, ...JSON.parse(data) });
          } catch {
            resolve({ running: true });
          }
        });
      });
      req.on('error', () => resolve({ running: false }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ running: false }); });
    });
  } catch {
    return { running: false };
  }
});
