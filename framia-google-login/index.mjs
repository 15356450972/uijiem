#!/usr/bin/env node
/**
 * Framia Google OAuth Login Module
 *
 * Automates the full Framia → Google OAuth login flow via CDP:
 *   1. Launch Chrome with anti-detection flags (avoid CAPTCHA)
 *   2. Navigate to framia.converge.ai
 *   3. Click "登录" → click "Continue with Google"
 *   4. Input email → next → input password → next
 *   5. Accept Google Workspace terms → authorize Framia
 *   6. Extract cookies + access token from Framia
 *
 * Anti-detection strategy to avoid CAPTCHA:
 *   - Isolated browser profile per login run (prevents profile lock and stale CDP state)
 *   - Optional persistent profile via --profile when a caller explicitly needs device memory
 *   --disable-blink-features=AutomationControlled (hide webdriver flag)
 *   - Inject stealth scripts (navigator.webdriver, plugins, languages, etc.)
 *   - Realistic typing delays and mouse movements
 *   - Proper sec-ch-ua headers
 *   - Real viewport size
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FRAMIA_ORIGIN = 'https://framia.converge.ai';
const FRAMIA_CREATE_URL = `${FRAMIA_ORIGIN}/create/`;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 25000 + crypto.randomInt(1000, 9000);
}

function appendLimitedText(current, chunk, maxLength = 12000) {
  const next = `${current || ''}${chunk || ''}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

function createRunProfile(profileDir) {
  if (profileDir) {
    return {
      profile: path.resolve(profileDir),
      temporary: false,
    };
  }

  const root = path.join(__dir, '.framia-profiles', 'runs');
  const runId = `run-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return {
    profile: path.join(root, runId),
    temporary: true,
  };
}

function resolveChrome(chromePath) {
  const chrome = chromePath ? path.resolve(chromePath) : findChrome();
  if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH.');
  if (!fs.existsSync(chrome)) throw new Error(`Chrome executable not found: ${chrome}`);
  return chrome;
}

function createChromeDiagnostics({ chrome, args, port, profile }) {
  return {
    chrome,
    args,
    command: [chrome, ...args].map((part) => String(part).includes(' ') ? JSON.stringify(part) : String(part)).join(' '),
    port,
    profile,
    startedAt: Date.now(),
    stderr: '',
    spawnError: null,
    exit: null,
  };
}

function attachChromeDiagnostics(chromeProc, diagnostics) {
  chromeProc.stderr?.on('data', (chunk) => {
    diagnostics.stderr = appendLimitedText(diagnostics.stderr, chunk.toString());
  });
  chromeProc.once('error', (error) => {
    diagnostics.spawnError = error;
  });
  chromeProc.once('exit', (code, signal) => {
    diagnostics.exit = {
      code,
      signal,
      afterMs: Date.now() - diagnostics.startedAt,
    };
  });
}

function summarizeChromeDiagnostics(diagnostics, lastError) {
  const parts = [
    `port=${diagnostics.port}`,
    `profile=${diagnostics.profile}`,
  ];
  if (diagnostics.spawnError) parts.push(`spawn_error=${diagnostics.spawnError.message}`);
  if (diagnostics.exit) parts.push(`exit=${diagnostics.exit.code ?? 'null'}/${diagnostics.exit.signal ?? 'null'} after ${diagnostics.exit.afterMs}ms`);
  if (lastError?.message) parts.push(`last_cdp_error=${lastError.message}`);
  const stderr = (diagnostics.stderr || '').trim();
  if (stderr) parts.push(`stderr=${stderr.slice(-1200)}`);
  return parts.join('; ');
}

async function terminateChromeProcess(chromeProc, timeoutMs = 4000) {
  if (!chromeProc?.pid) return;
  try { process.kill(-chromeProc.pid, 'SIGTERM'); } catch {}
  try { chromeProc.kill('SIGTERM'); } catch {}

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromeProc.exitCode !== null || chromeProc.signalCode !== null) return;
    await sleep(100);
  }

  try { process.kill(-chromeProc.pid, 'SIGKILL'); } catch {}
  try { chromeProc.kill('SIGKILL'); } catch {}
}

function removeTemporaryProfile(profile) {
  if (!profile || !profile.includes(`${path.sep}.framia-profiles${path.sep}runs${path.sep}`)) return;
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

// ── CDP helpers ──────────────────────────────────────────────────────────────

async function waitForJson(url, timeoutMs, diagnostics = null) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    if (diagnostics?.spawnError || diagnostics?.exit) {
      throw new Error(`CDP not ready: ${summarizeChromeDiagnostics(diagnostics, lastError)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  if (diagnostics) {
    throw new Error(`CDP not ready: ${summarizeChromeDiagnostics(diagnostics, lastError)}`);
  }
  throw new Error(`CDP not ready: ${lastError?.message || url}`);
}

async function cdpPage(port) {
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  const normalPages = pages.filter((page) => {
    const url = page.url || '';
    return page.type === 'page' && !/^(chrome-extension|devtools|chrome):/.test(url);
  });
  return normalPages.find((p) => p.url?.includes('framia.converge.ai') || p.url?.includes('auth.converge.ai') || p.url?.includes('accounts.google.com')) || normalPages[0] || pages.find((p) => p.type === 'page') || pages[0];
}

async function withPageSocket(page, work, timeoutMs = 180000) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  return new Promise((resolve, reject) => {
    let nextId = 1;
    const pending = new Map();
    const eventHandlers = new Set();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP WebSocket timeout'));
    }, timeoutMs);

    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const onEvent = (handler) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    };

    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message.id) {
        for (const handler of eventHandlers) {
          try { handler(message); } catch {}
        }
        return;
      }
      if (!pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message || JSON.stringify(message.error)));
      else res(message.result || {});
    });

    ws.on('open', async () => {
      try {
        const result = await work(send, onEvent);
        clearTimeout(timer);
        ws.close();
        resolve(result);
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(error);
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ── Anti-detection stealth injection ──────────────────────────────────────────

const STEALTH_JS = `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, parameter);
  };
  const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', elementDescriptor);
  Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', elementDescriptor);
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'connection', { get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10 }) });
})();
`;

// ── Page interaction helpers ──────────────────────────────────────────────────

async function waitForPageNavigation(send, onEvent, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
    const unsubscribe = onEvent((message) => {
      if (message.method === 'Page.frameNavigated') {
        const url = message.params?.frame?.url || '';
        if (url && !url.startsWith('about:')) finish(url);
      }
    });
  });
}

async function evaluateJs(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.value;
}

async function waitForElement(send, selectorFn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluateJs(send, `(() => {
      const result = ${selectorFn};
      return result ? JSON.stringify(result) : null;
    })()`);
    if (found) return JSON.parse(found);
    await sleep(800);
  }
  return null;
}

async function clickElement(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(50 + Math.random() * 100);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(30 + Math.random() * 50);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function typeText(send, text, delayBase = 80) {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      text: char,
      unmodifiedText: char,
    });
    await sleep(delayBase + Math.random() * 60);
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
    });
  }
}

async function insertText(send, text) {
  await send('Input.insertText', { text });
}

async function pressKey(send, key, code, keyCode) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await sleep(30);
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function waitForUrlChange(send, onEvent, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
    const unsubscribe = onEvent((message) => {
      if (message.method === 'Page.frameNavigated') {
        const url = message.params?.frame?.url || '';
        if (url && url.startsWith('http')) finish(url);
      }
    });
  });
}

// ── Cookie / state extraction ─────────────────────────────────────────────────

function normalizeCookie(cookies) {
  return cookies
    .filter((c) => c.name && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function normalizeFramiaCookie(cookies) {
  return normalizeCookie((cookies || []).filter((c) => {
    const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'framia.converge.ai' || domain.endsWith('.framia.converge.ai') ||
           domain === 'converge.ai' || domain.endsWith('.converge.ai');
  }));
}

async function extractAccountState(send) {
  const cookieResult = await send('Network.getCookies', {
    urls: [FRAMIA_ORIGIN, FRAMIA_CREATE_URL, 'https://auth.converge.ai', 'https://framia.converge.ai'],
  });

  const allCookies = cookieResult.cookies || [];
  const framiaCookie = normalizeFramiaCookie(allCookies);

  const runtime = await send('Runtime.evaluate', {
    expression: `(() => {
      return JSON.stringify({
        user_agent: navigator.userAgent,
        location: location.href,
        cookie: document.cookie,
        local_storage: Object.fromEntries(Object.entries(localStorage || {})),
        session_storage: Object.fromEntries(Object.entries(sessionStorage || {})),
      });
    })()`,
    returnByValue: true,
  });

  const pageState = JSON.parse(runtime.result?.value || '{}');

  return {
    cookie: framiaCookie || pageState.cookie || '',
    all_cookies: allCookies,
    user_agent: pageState.user_agent || DEFAULT_UA,
    location: pageState.location || '',
    local_storage: pageState.local_storage || {},
    session_storage: pageState.session_storage || {},
  };
}

async function fetchAccessToken(send, cookie) {
  const result = await evaluateJs(send, `(async () => {
    try {
      const resp = await fetch('/api/auth/token', {
        headers: { 'Accept': 'application/json' },
        credentials: 'include',
      });
      if (!resp.ok) return JSON.stringify({ error: 'HTTP ' + resp.status });
      const data = await resp.json();
      return JSON.stringify(data);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  })()`);
  try {
    return JSON.parse(result || '{}');
  } catch {
    return { error: String(result) };
  }
}

// ── Main login flow ───────────────────────────────────────────────────────────

/**
 * Perform the full Framia Google OAuth login.
 *
 * @param {object} options
 * @param {string} options.email       - Google account email
 * @param {string} options.password    - Google account password
 * @param {string} [options.chromePath] - Path to Chrome executable
 * @param {string} [options.profileDir] - Browser profile directory (persistent for anti-detect)
 * @param {number} [options.port]       - CDP debugging port
 * @param {boolean} [options.visible]   - Show browser window (default true)
 * @param {string} [options.proxy]      - Proxy server URL
 * @param {function} [options.onStep]   - Progress callback: (step, data) => void
 */
export async function loginFramiaWithGoogle(options = {}) {
  const {
    email,
    password,
    chromePath,
    profileDir,
    port = randomPort(),
    visible = true,
    proxy,
    onStep = () => {},
  } = options;

  if (!email || !password) throw new Error('Email and password are required');

  const chrome = resolveChrome(chromePath);
  const { profile, temporary: temporaryProfile } = createRunProfile(profileDir);
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
    '--disable-infobars',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-default-apps',
    '--disable-translate',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection',
    '--window-size=1280,800',
  ];

  if (!visible) args.push('--headless=new', '--disable-gpu');
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push(FRAMIA_ORIGIN);

  const diagnostics = createChromeDiagnostics({ chrome, args, port, profile });
  onStep('launching', { port, profile, chrome, temporaryProfile });
  const chromeProc = spawn(chrome, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  attachChromeDiagnostics(chromeProc, diagnostics);
  chromeProc.unref();
  chromeProc.stderr?.unref?.();

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000, diagnostics);
    onStep('chrome_ready', { port });

    const page = await cdpPage(port);
    if (!page?.webSocketDebuggerUrl) throw new Error('No connectable page found');

    const result = await withPageSocket(page, async (send, onEvent) => {
      await send('Page.enable');
      await send('Network.enable');
      await send('Runtime.enable');

      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      await send('Runtime.evaluate', { expression: STEALTH_JS });

      // ── Step 1: Wait for Framia page to load ────────────────────────────────
      onStep('waiting_framia_load', {});
      await sleep(5000);

      // ── Step 2: Click "登录" button ──────────────────────────────────────────
      onStep('clicking_login', {});
      let clicked = false;
      const loginDeadline = Date.now() + 15000;
      while (Date.now() < loginDeadline && !clicked) {
        clicked = await evaluateJs(send, `(() => {
          const btns = [...document.querySelectorAll('button, a')].filter((b) => {
            const text = (b.innerText || '').trim();
            return (text === '登录' || text === 'Sign in' || text === 'Log in' || text === 'Login') && b.offsetWidth > 0 && b.offsetHeight > 0;
          });
          if (!btns.length) return false;
          btns[0].click();
          return true;
        })()`);
        if (!clicked) await sleep(1000);
      }

      if (clicked) {
        onStep('login_clicked', {});
        await sleep(3000);
      } else {
        onStep('login_button_not_found', {});
        await sleep(2000);
      }

      // ── Step 3: Wait for Auth0 login page and click "Continue with Google" ──
      onStep('waiting_auth0_page', {});
      let auth0Url = await waitForUrlChange(send, onEvent, 15000);
      onStep('auth0_page_loaded', { url: auth0Url });

      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      await sleep(3000);

      // Click "Continue with Google" button
      onStep('clicking_google_login', {});
      let jsClicked = false;
      const googleDeadline = Date.now() + 20000;
      while (Date.now() < googleDeadline && !jsClicked) {
        jsClicked = await evaluateJs(send, `(() => {
          // Strategy 1: button with data-provider="google"
          const googleBtn = document.querySelector('button[data-provider="google"]');
          if (googleBtn && googleBtn.offsetWidth > 0) {
            googleBtn.click();
            return true;
          }
          // Strategy 2: button with text containing "Google"
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim();
            return /google/i.test(text) && b.offsetWidth > 0 && b.offsetHeight > 0;
          });
          if (btns.length) {
            btns[0].click();
            return true;
          }
          // Strategy 3: link with Google text
          const links = [...document.querySelectorAll('a, [role="button"]')].filter((el) => {
            const text = (el.innerText || '').trim();
            return /google/i.test(text) && el.offsetWidth > 0;
          });
          if (links.length) {
            links[0].click();
            return true;
          }
          return false;
        })()`);
        if (!jsClicked) await sleep(500);
      }

      if (jsClicked) {
        onStep('google_login_clicked', {});
      } else {
        const googleBtn = await waitForElement(send, `(() => {
          const btn = document.querySelector('button[data-provider="google"]');
          if (btn && btn.offsetWidth > 0) {
            const rect = btn.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim();
            return /google/i.test(text) && b.offsetWidth > 0;
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        })()`, 20000);
        if (!googleBtn) throw new Error('Google login button not found on Auth0 page');
        await clickElement(send, googleBtn.x, googleBtn.y);
        onStep('google_login_clicked', {});
      }

      // ── Step 4: Wait for Google login page and input email ────────────────
      onStep('waiting_google_page', {});
      let googleUrl = await waitForUrlChange(send, onEvent, 15000);
      onStep('google_page_loaded', { url: googleUrl });

      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      await sleep(4000);

      // ── Step 4.5: Handle account chooser page ───────────────────────────
      const currentUrl = await evaluateJs(send, 'location.href');
      if (currentUrl && currentUrl.includes('accountchooser')) {
        onStep('handling_account_chooser', { url: currentUrl });

        const accountClicked = await evaluateJs(send, `(() => {
          const allItems = [...document.querySelectorAll('[data-identifier], [data-email], li, div')];
          for (const item of allItems) {
            const text = (item.innerText || '').trim();
            if (text.includes(${JSON.stringify(email)}) && item.offsetWidth > 0) {
              item.click();
              return 'matched';
            }
          }
          const useAnotherTexts = ['use another account', '使用其他账号', '使用另一个账号', 'sign in with a different account', 'add account', '添加账号'];
          const links = [...document.querySelectorAll('a, button, [role="link"], [role="button"], div')];
          for (const link of links) {
            const text = (link.innerText || '').trim().toLowerCase();
            if (useAnotherTexts.includes(text) && link.offsetWidth > 0) {
              link.click();
              return 'another';
            }
          }
          return false;
        })()`);

        if (accountClicked === 'matched') {
          onStep('account_chooser_matched', {});
          await sleep(3000);
          const pwdVisible = await evaluateJs(send, `(() => {
            const pwd = document.querySelector('input[type="password"], input[name="Passwd"], input[name="password"]');
            return !!(pwd && pwd.offsetWidth > 0);
          })()`);
          if (!pwdVisible) {
            await waitForUrlChange(send, onEvent, 10000);
            await sleep(2000);
          }
        } else if (accountClicked === 'another') {
          onStep('account_chooser_another', {});
          await waitForUrlChange(send, onEvent, 10000);
          await sleep(2000);
        } else {
          onStep('account_chooser_fallback', {});
          const fallbackClicked = await evaluateJs(send, `(() => {
            const items = [...document.querySelectorAll('[data-identifier], [data-email]')].filter((el) => el.offsetWidth > 0);
            if (items.length) { items[0].click(); return true; }
            const links = [...document.querySelectorAll('a, button, [role="link"], [role="button"]')].filter((el) => {
              const text = (el.innerText || '').trim().toLowerCase();
              return (text.includes('another') || text.includes('其他') || text.includes('不同')) && el.offsetWidth > 0;
            });
            if (links.length) { links[0].click(); return true; }
            return false;
          })()`);
          if (fallbackClicked) {
            await waitForUrlChange(send, onEvent, 10000);
            await sleep(2000);
          }
        }
      }

      // Check if password field is already visible (skip email input if so)
      const skipEmail = await evaluateJs(send, `(() => {
        const pwd = document.querySelector('input[type="password"], input[name="Passwd"], input[name="password"]');
        return !!(pwd && pwd.offsetWidth > 0);
      })()`);

      if (skipEmail) {
        onStep('skipping_email_input', {});
      } else {
        onStep('inputting_email', { email });
        const emailEntered = await evaluateJs(send, `(() => {
          const input = document.querySelector('input[type="email"], input[name="identifier"], input[aria-label*="邮箱"], input[aria-label*="email" i], input[id="identifierId"]');
          if (!input || input.offsetWidth === 0) return false;
          input.focus();
          input.value = '';
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(input, ${JSON.stringify(email)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);

        if (!emailEntered) {
          const emailInput = await waitForElement(send, `(() => {
            const input = document.querySelector('input[type="email"], input[name="identifier"], input[aria-label*="邮箱"], input[aria-label*="email" i], input[id="identifierId"]');
            if (input && input.offsetWidth > 0) {
              const rect = input.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, selector: 'email' };
            }
            return null;
          })()`, 15000);

          if (!emailInput) throw new Error('Email input not found on Google login page');
          await clickElement(send, emailInput.x, emailInput.y);
          await sleep(300);
          await typeText(send, email);
        }
        await sleep(300);

        onStep('email_next', {});
        const emailNext = await waitForElement(send, `(() => {
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim().toLowerCase();
            return (text === '下一步' || text === 'next') && b.offsetWidth > 0 && !b.disabled;
          });
          if (!btns.length) return null;
          const rect = btns[0].getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`, 5000);

        if (emailNext) {
          await clickElement(send, emailNext.x, emailNext.y);
        } else {
          await pressKey(send, 'Enter', 'Enter', 13);
        }
      }

      // ── Step 5: Wait for password page (may encounter CAPTCHA) ────────────
      onStep('waiting_password_page', {});
      await sleep(5000);

      const pwdAlreadyVisible = await evaluateJs(send, `(() => {
        const pwd = document.querySelector('input[type="password"], input[name="password"], input[name="Passwd"], input[autocomplete="current-password"]');
        if (pwd && pwd.offsetWidth > 0) return true;
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
        for (const input of inputs) {
          if (input.offsetWidth > 0 && input.name !== 'identifier' && input.type !== 'email' && input.type !== 'hidden') {
            const formText = (input.closest('form')?.innerText || document.body?.innerText || '').slice(0, 200);
            if (formText.includes('密码') || formText.includes('password') || formText.includes('Password')) {
              return true;
            }
          }
        }
        return false;
      })()`);

      if (!pwdAlreadyVisible) {
        const captchaCheck = await evaluateJs(send, `(() => {
          const captchaImg = document.querySelector('img[src*="Captcha"], img[alt*="captcha" i], img[alt*="人机"]');
          const captchaInput = document.querySelector('input[aria-label*="captcha" i], input[aria-label*="听到" i], input[aria-label*="看到" i]');
          const captchaVisible = (captchaInput && captchaInput.offsetWidth > 0) || (captchaImg && captchaImg.offsetWidth > 0);
          return JSON.stringify({
            hasCaptcha: !!captchaVisible,
            captchaImgUrl: captchaImg?.src || '',
          });
        })()`);

        if (captchaCheck) {
          const captchaInfo = JSON.parse(captchaCheck);
          if (captchaInfo.hasCaptcha) {
            onStep('captcha_required', captchaInfo);
            onStep('waiting_captcha_solve', { message: 'CAPTCHA detected. Please solve it in the browser window.' });
            const captchaSolved = await waitForElement(send, `(() => {
              const pwdInput = document.querySelector('input[type="password"], input[name="password"], input[name="Passwd"]');
              if (pwdInput && pwdInput.offsetWidth > 0) return { found: true, type: 'password' };
              return null;
            })()`, 120000);

            if (!captchaSolved) {
              throw new Error('CAPTCHA was not solved within 120 seconds');
            }
            onStep('captcha_solved', {});
            await sleep(2000);
          } else {
            const pwdLoaded = await waitForElement(send, `(() => {
              const pwd = document.querySelector('input[type="password"], input[name="password"], input[name="Passwd"]');
              if (pwd && pwd.offsetWidth > 0) {
                const rect = pwd.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
              return null;
            })()`, 20000);
            if (!pwdLoaded) {
              const pageText = await evaluateJs(send, 'document.body?.innerText?.slice(0, 500) || ""');
              throw new Error('Password page not loaded. Page text: ' + (pageText || '').slice(0, 200));
            }
          }
        }
      }

      // ── Step 6: Input password ────────────────────────────────────────────
      onStep('inputting_password', {});

      const pwdInput = await waitForElement(send, `(() => {
        const selectors = [
          'input[type="password"]',
          'input[name="Passwd"]',
          'input[name="password"]',
          'input[autocomplete="current-password"]',
          'input[aria-label*="密码"]',
          'input[aria-label*="password" i]',
        ];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input && input.offsetWidth > 0 && input.offsetHeight > 0) {
            const rect = input.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
        const inputs = [...document.querySelectorAll('input')];
        for (const input of inputs) {
          if (input.type === 'email' || input.type === 'hidden' || input.type === 'button' || input.type === 'submit') continue;
          if (input.offsetWidth === 0 || input.offsetHeight === 0) continue;
          if (input.name === 'identifier') continue;
          const container = input.closest('form, div') || document.body;
          const ctxText = (container?.innerText || '').slice(0, 300);
          if (ctxText.includes('密码') || /password/i.test(ctxText)) {
            const rect = input.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
        return null;
      })()`, 30000);

      if (!pwdInput) {
        const diagUrl = await evaluateJs(send, 'location.href');
        const diagText = await evaluateJs(send, 'document.body?.innerText?.slice(0, 500) || ""');
        throw new Error(`Password input not found. URL: ${diagUrl}. Page text: ${(diagText || '').slice(0, 300)}`);
      }

      await clickElement(send, pwdInput.x, pwdInput.y);
      await sleep(500);

      const pwdEntered = await evaluateJs(send, `(() => {
        const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]', 'input[aria-label*="密码"]', 'input[aria-label*="password" i]'];
        let input = null;
        for (const sel of selectors) {
          input = document.querySelector(sel);
          if (input && input.offsetWidth > 0) break;
          input = null;
        }
        if (!input) {
          const inputs = [...document.querySelectorAll('input')];
          for (const inp of inputs) {
            if (inp.type === 'email' || inp.type === 'hidden' || inp.type === 'button' || inp.type === 'submit') continue;
            if (inp.offsetWidth === 0) continue;
            if (inp.name === 'identifier') continue;
            const container = inp.closest('form, div') || document.body;
            const ctxText = (container?.innerText || '').slice(0, 300);
            if (ctxText.includes('密码') || /password/i.test(ctxText)) { input = inp; break; }
          }
        }
        if (!input) return false;
        input.focus();
        input.value = '';
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, ${JSON.stringify(password)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);

      await sleep(300);

      const pwdValueCheck = await evaluateJs(send, `(() => {
        const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]'];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input) return input.value.length;
        }
        return 0;
      })()`);

      if (!pwdEntered || !pwdValueCheck || pwdValueCheck === 0) {
        onStep('password_retry_inserttext', {});
        await clickElement(send, pwdInput.x, pwdInput.y);
        await sleep(300);
        await insertText(send, password);
        await sleep(300);
      }

      const pwdValueCheck2 = await evaluateJs(send, `(() => {
        const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]'];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input) return input.value.length;
        }
        return 0;
      })()`);

      if (!pwdValueCheck2 || pwdValueCheck2 === 0) {
        onStep('password_retry_typetext', {});
        await clickElement(send, pwdInput.x, pwdInput.y);
        await sleep(300);
        await typeText(send, password);
      }
      await sleep(500);

      // Click "下一步" / "Next"
      onStep('password_next', {});
      const pwdNextClicked = await evaluateJs(send, `(() => {
        const nextTexts = ['下一步', 'next'];
        const btns = [...document.querySelectorAll('button')].filter((b) => {
          const text = (b.innerText || '').trim().toLowerCase();
          return nextTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
        });
        if (btns.length) { btns[0].click(); return true; }
        const pwNext = document.querySelector('#passwordNext');
        if (pwNext && pwNext.offsetWidth > 0) {
          const clickTarget = pwNext.querySelector('button') || pwNext.querySelector('[role="button"]') || pwNext;
          clickTarget.click();
          return true;
        }
        const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
        if (materialBtns.length) { materialBtns[0].click(); return true; }
        return false;
      })()`);

      if (!pwdNextClicked) {
        const pwdNext = await waitForElement(send, `(() => {
          const nextTexts = ['下一步', 'next'];
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim().toLowerCase();
            return nextTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          const pwNext = document.querySelector('#passwordNext');
          if (pwNext && pwNext.offsetWidth > 0) {
            const rect = pwNext.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
          if (materialBtns.length) {
            const rect = materialBtns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        })()`, 5000);

        if (pwdNext) {
          await clickElement(send, pwdNext.x, pwdNext.y);
        } else {
          await pressKey(send, 'Enter', 'Enter', 13);
        }
      }

      // ── Step 7: Handle Google Workspace terms (if appears) ────────────────
      onStep('waiting_terms', {});
      await sleep(1500);

      let termsAccepted = false;
      const termsDeadline = Date.now() + 15000;
      while (Date.now() < termsDeadline && !termsAccepted) {
        termsAccepted = await evaluateJs(send, `(() => {
          const acceptTexts = ['我了解', 'I understand', 'Accept', '同意', '继续', 'Continue', 'Next', '下一步', 'I accept', '我同意', 'Got it', '创建', 'Create', 'Sign in', '登录'];
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim();
            return acceptTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) { btns[0].click(); return true; }
          const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
          if (materialBtns.length) { materialBtns[0].click(); return true; }
          const allBtns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim().toLowerCase();
            return acceptTexts.some(t => t.toLowerCase() === text);
          });
          if (allBtns.length) { allBtns[0].click(); return true; }
          return false;
        })()`);
        if (!termsAccepted) await sleep(1000);
      }

      if (termsAccepted) {
        onStep('accepting_terms', {});
        await sleep(1500);
      } else {
        const termsBtn = await waitForElement(send, `(() => {
          const acceptTexts = ['我了解', 'I understand', 'Accept', '同意', '继续', 'Continue', 'Next', '下一步', 'I accept', '我同意', 'Got it', '创建', 'Create', 'Sign in', '登录'];
          const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
            const text = (b.innerText || '').trim();
            return acceptTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
          if (materialBtns.length) {
            const rect = materialBtns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        })()`, 10000);

        if (termsBtn) {
          onStep('accepting_terms', {});
          await clickElement(send, termsBtn.x, termsBtn.y);
          await sleep(1500);
        }
      }

      // ── Step 8: Handle OAuth consent page ─────────────────────────────────
      onStep('waiting_consent', {});
      let consentDone = false;
      const consentDeadline = Date.now() + 15000;
      while (Date.now() < consentDeadline && !consentDone) {
        consentDone = await evaluateJs(send, `(() => {
          const consentTexts = ['continue', '继续', 'allow', '允许', 'accept', '同意', 'i agree', '我同意'];
          const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
            const text = (b.innerText || '').trim().toLowerCase();
            return consentTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) { btns[0].click(); return true; }
          const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
          if (materialBtns.length) { materialBtns[0].click(); return true; }
          return false;
        })()`);
        if (!consentDone) await sleep(1000);
      }

      if (consentDone) {
        onStep('clicking_consent', {});
        await sleep(1000);
      } else {
        const consentBtn = await waitForElement(send, `(() => {
          const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
          if (materialBtns.length) {
            const rect = materialBtns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        })()`, 5000);

        if (consentBtn) {
          onStep('clicking_consent', {});
          await clickElement(send, consentBtn.x, consentBtn.y);
        }
      }

      // ── Step 9: Wait for redirect back to Framia ───────────────────────────
      onStep('waiting_framia_redirect', {});
      let framiaUrl = await waitForUrlChange(send, onEvent, 30000);

      if (!framiaUrl || !framiaUrl.includes('framia.converge.ai')) {
        await sleep(3000);
        framiaUrl = await evaluateJs(send, 'location.href');
      }

      onStep('framia_redirected', { url: framiaUrl });

      // Wait for Framia page to fully load
      await sleep(3000);

      // ── Step 10: Extract account state ────────────────────────────────────
      onStep('extracting_state', {});
      const state = await extractAccountState(send);

      // ── Step 11: Fetch access token from Framia API ────────────────────────
      onStep('fetching_access_token', {});
      const tokenData = await fetchAccessToken(send, state.cookie);

      const accessToken = tokenData?.accessToken || tokenData?.access_token || '';
      const expiresAt = tokenData?.expiresAt || 0;
      const user = tokenData?.user || {};

      onStep('login_complete', {
        location: state.location,
        hasCookie: !!state.cookie,
        hasAccessToken: !!accessToken,
        userId: user.user_id || '',
        email: user.email || email,
      });

      return { state, accessToken, expiresAt, user, tokenData, redirectUrl: framiaUrl };
    }, 180000);

    return {
      ...result,
      port,
      profile,
    };
  } finally {
    if (!options.keepOpen) {
      await terminateChromeProcess(chromeProc);
      if (temporaryProfile) removeTemporaryProfile(profile);
    }
  }
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let email = '', password = '', visible = true, keepOpen = false, profile, proxy;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    if (arg === '--email') email = next();
    else if (arg === '--password') password = next();
    else if (arg === '--headless') visible = false;
    else if (arg === '--keep-open') keepOpen = true;
    else if (arg === '--profile') profile = next();
    else if (arg === '--proxy') proxy = next();
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node index.mjs --email EMAIL --password PASSWORD [--headless] [--keep-open] [--profile DIR] [--proxy URL]');
      process.exit(0);
    }
  }

  if (!email || !password) {
    console.error('Usage: node index.mjs --email EMAIL --password PASSWORD');
    process.exit(1);
  }

  try {
    const result = await loginFramiaWithGoogle({
      email,
      password,
      visible,
      keepOpen,
      profileDir: profile,
      proxy,
      onStep: (step, data) => {
        console.log(`[framia-login] ${step}: ${JSON.stringify(data)}`);
      },
    });
    console.log('[framia-login] success!');
    console.log(`[framia-login] cookie: ${result.state.cookie ? 'ok' : 'missing'}`);
    console.log(`[framia-login] access_token: ${result.accessToken ? 'ok' : 'missing'}`);
    console.log(`[framia-login] location: ${result.state.location}`);
    console.log(`[framia-login] state_json: ${JSON.stringify({
      cookie: result.state.cookie,
      user_agent: result.state.user_agent,
      access_token: result.accessToken,
      expires_at: result.expiresAt,
      user_id: result.user?.user_id || '',
      email: result.user?.email || email,
      location: result.state.location,
    })}`);
  } catch (error) {
    console.error(`[framia-login] failed: ${error.message}`);
    process.exit(1);
  }
}
