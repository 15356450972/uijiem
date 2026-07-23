#!/usr/bin/env node
/**
 * HappyHorse Google OAuth Login Module
 *
 * Automates the full HappyHorse → Google OAuth login flow via CDP:
 *   1. Launch Chrome with anti-detection flags (avoid CAPTCHA)
 *   2. Open HappyHorse homepage, dismiss promo modal (IconCircleX)
 *   3. Click purple "Login" button
 *   4. Click "Sign in with Google"
 *   5. Input email → next → input password → next
 *   6. Accept Google Workspace terms → authorize HappyHorse
 *   7. Extract auth_token from localStorage
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
const HH_ORIGIN = 'https://www.happyhorse.com';
const HH_HOME_URL = `${HH_ORIGIN}/`;
const HH_CREATE_URL = `${HH_ORIGIN}/creation/generation`;

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

  const root = path.join(__dir, '.happyhorse-profiles', 'runs');
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
  if (!profile || !profile.includes(`${path.sep}.happyhorse-profiles${path.sep}runs${path.sep}`)) return;
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

async function listNormalPages(port) {
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  return (pages || []).filter((page) => {
    const url = page.url || '';
    return page.type === 'page' && page.webSocketDebuggerUrl && !/^(chrome-extension|devtools|chrome):/.test(url);
  });
}

async function cdpPage(port) {
  const normalPages = await listNormalPages(port);
  return normalPages.find((p) => p.url?.includes('www.happyhorse.com') || p.url?.includes('happyhorse.com') || p.url?.includes('accounts.google.com'))
    || normalPages[0]
    || null;
}

async function waitForPageMatching(port, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pages = await listNormalPages(port);
      const match = pages.find((p) => {
        try { return predicate(p.url || '', p); } catch { return false; }
      });
      if (match) return match;
    } catch {}
    await sleep(400);
  }
  return null;
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

const GOOGLE_EMAIL_SELECTOR = [
  'input[type="email"]',
  'input[name="identifier"]',
  'input[id="identifierId"]',
  'input[autocomplete="username"]',
  'input[aria-label*="邮箱"]',
  'input[aria-label*="email" i]',
  'input[aria-label*="Email"]',
  'input[aria-label*="电话"]',
].join(', ');

const GOOGLE_PASSWORD_SELECTOR = [
  'input[type="password"]',
  'input[name="Passwd"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[aria-label*="密码"]',
  'input[aria-label*="password" i]',
].join(', ');

async function findVisibleInputRect(send, selector, timeoutMs = 20000) {
  return waitForElement(send, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input || input.offsetWidth === 0 || input.offsetHeight === 0) return null;
    const rect = input.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, value: input.value || '' };
  })()`, timeoutMs);
}

async function fillGoogleInput(send, selector, value, label) {
  const rect = await findVisibleInputRect(send, selector);
  if (!rect) throw new Error(`${label} input not found`);

  // Strategy 1: native setter + InputEvent (React/Polymer friendly)
  const jsFilled = await evaluateJs(send, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input || input.offsetWidth === 0) return false;
    input.focus();
    input.click();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)}, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === ${JSON.stringify(value)};
  })()`);
  if (jsFilled) return true;

  // Strategy 2: click + CDP insertText
  await clickElement(send, rect.x, rect.y);
  await sleep(200);
  await evaluateJs(send, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(100);
  await insertText(send, value);
  await sleep(200);
  let current = await evaluateJs(send, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    return input ? (input.value || '') : '';
  })()`);
  if (current === value) return true;

  // Strategy 3: clear + typeText key events
  await clickElement(send, rect.x, rect.y);
  await sleep(150);
  // Select-all then type
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await sleep(50);
  await typeText(send, value, 60);
  await sleep(200);
  current = await evaluateJs(send, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    return input ? (input.value || '') : '';
  })()`);
  if (current === value) return true;
  throw new Error(`Failed to fill ${label} (got "${String(current || '').slice(0, 40)}")`);
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

function normalizeHappyHorseCookie(cookies) {
  return normalizeCookie((cookies || []).filter((c) => {
    const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'happyhorse.com' || domain.endsWith('.happyhorse.com') ||
           domain === 'aorizon.com' || domain.endsWith('.aorizon.com');
  }));
}

async function extractAccountState(send) {
  const cookieResult = await send('Network.getCookies', {
    urls: [HH_ORIGIN, HH_CREATE_URL, 'https://api-gateway.aorizon.com', 'https://gw.happyhorse.com'],
  });
  const allCookies = cookieResult.cookies || [];
  const hhCookie = normalizeHappyHorseCookie(allCookies);
  const runtime = await send('Runtime.evaluate', {
    expression: `(() => JSON.stringify({
      user_agent: navigator.userAgent,
      location: location.href,
      cookie: document.cookie,
      local_storage: Object.fromEntries(Object.entries(localStorage || {})),
      session_storage: Object.fromEntries(Object.entries(sessionStorage || {})),
    }))()`,
    returnByValue: true,
  });
  const pageState = JSON.parse(runtime.result?.value || '{}');
  return {
    cookie: hhCookie || pageState.cookie || '',
    all_cookies: allCookies,
    user_agent: pageState.user_agent || DEFAULT_UA,
    location: pageState.location || '',
    local_storage: pageState.local_storage || {},
    session_storage: pageState.session_storage || {},
  };
}

function parseAuthTokenFromStorage(localStorageObj = {}) {
  try {
    const raw = localStorageObj.auth_token || '';
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const state = parsed?.state || parsed || {};
    const tokenInfo = state.tokenInfo || {};
    const user = state.user || {};
    const accessToken = tokenInfo.accessToken || tokenInfo.access_token || '';
    const refreshToken = tokenInfo.refreshToken || '';
    const accessExpiresIn = Number(tokenInfo.accessExpiresIn || 0);
    const tokenCreatedAt = Number(tokenInfo.tokenCreatedAt || Date.now());
    const expiresAt = accessExpiresIn ? tokenCreatedAt + accessExpiresIn * 1000 : 0;
    const umid = String(localStorageObj.lswucn || '').split('@@')[0] || '';
    return {
      accessToken,
      refreshToken,
      expiresAt,
      user,
      deviceId: localStorageObj.device_id || '',
      bxUmidtoken: umid,
      isAuthenticated: !!state.isAuthenticated,
    };
  } catch {
    return { accessToken: '', refreshToken: '', expiresAt: 0, user: {}, deviceId: '', bxUmidtoken: '' };
  }
}

async function clickButtonByTexts(send, texts, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const lowered = texts.map((t) => t.toLowerCase());
  while (Date.now() < deadline) {
    const clicked = await evaluateJs(send, `(() => {
      const targets = ${JSON.stringify(lowered)};
      const btns = [...document.querySelectorAll('button, [role="button"], a')].filter((b) => {
        if (b.offsetWidth === 0 || b.disabled) return false;
        const text = (b.innerText || '').trim().toLowerCase();
        return targets.some((t) => text === t || text.includes(t));
      });
      if (!btns.length) return false;
      btns[0].click();
      return true;
    })()`);
    if (clicked) return true;
    await sleep(700);
  }
  return false;
}

/** Close HappyHorse promo modal (IconCircleX at top-right). */
async function dismissPromoModal(send, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const closed = await evaluateJs(send, `(() => {
      const tryClick = (el) => {
        if (!el) return false;
        const target = el.closest('button, [role="button"], a') || el;
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        target.click();
        return true;
      };

      // 1) Explicit IconCircleX / close SVG from HappyHorse promo
      const iconNodes = [...document.querySelectorAll('svg, button, div, span')].filter((el) => {
        const html = el.outerHTML || '';
        return html.includes('IconCircleX')
          || (html.includes('Ellipse 90') && html.includes('M15 9L9 15'))
          || (html.includes('cx="12"') && html.includes('r="10"') && html.includes('M15 9L9 15'));
      });
      for (const node of iconNodes) {
        if (tryClick(node)) return 'icon';
      }

      // 2) Small circular close buttons on the right half / upper area
      const candidates = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
        if (b.disabled || b.offsetWidth === 0) return false;
        const rect = b.getBoundingClientRect();
        if (rect.width < 18 || rect.width > 56 || rect.height < 18 || rect.height > 56) return false;
        if (rect.top > window.innerHeight * 0.5) return false;
        if (rect.left < window.innerWidth * 0.4) return false;
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const hasSvg = !!b.querySelector('svg');
        return hasSvg || aria.includes('close') || aria.includes('关闭') || aria.includes('dismiss');
      });
      if (candidates.length) {
        candidates.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.left + br.top) - (ar.left + ar.top);
        });
        candidates[0].click();
        return 'button';
      }
      return false;
    })()`);
    if (closed) return closed;
    await sleep(500);
  }
  return false;
}

/** Click homepage login / sign-in entry. */
async function clickHomeLoginButton(send, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await evaluateJs(send, `(() => {
      const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const btns = [...document.querySelectorAll('button, a, [role="button"]')].filter((b) => {
        if (b.disabled || b.offsetWidth === 0) return false;
        const text = normalize(b.innerText || b.textContent || '');
        if (!text) return false;
        if (text === 'login' || text === 'sign in' || text === 'log in') return true;
        if (text.includes('sign in to get')) return true;
        if (text.includes('free credits') && text.includes('sign')) return true;
        if (text.includes('登录') || text.includes('登入')) return true;
        return false;
      });
      if (!btns.length) return false;
      const preferred = btns.find((b) => {
        const cls = String(b.className || '');
        const text = normalize(b.innerText || b.textContent || '');
        return cls.includes('7160f7')
          || cls.includes('rounded-[29')
          || cls.includes('bg-[#7160f7]')
          || text.includes('sign in to get')
          || text === 'login';
      });
      (preferred || btns[0]).click();
      return (preferred || btns[0]).innerText || true;
    })()`);
    if (clicked) return clicked;
    await sleep(600);
  }
  return false;
}

export async function loginHappyHorseWithGoogle(options = {}) {
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
    '--window-size=1280,800',
  ];
  if (!visible) args.push('--headless=new', '--disable-gpu');
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push(HH_HOME_URL);

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

    // 1) Open HappyHorse and click Google login (may open popup)
    await withPageSocket(page, async (send) => {
      await send('Page.enable');
      await send('Network.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      await send('Runtime.evaluate', { expression: STEALTH_JS });

      onStep('waiting_happyhorse_load', {});
      await sleep(4000);

      // Step 1: close promo modal (IconCircleX)
      onStep('dismissing_promo_modal', {});
      const promoClosed = await dismissPromoModal(send, 10000);
      onStep('promo_modal_result', { closed: !!promoClosed });
      await sleep(800);

      // Cookie banner (if present)
      onStep('accepting_cookies', {});
      await clickButtonByTexts(send, ['accept all', '接受全部', '同意全部', 'accept'], 5000);
      await sleep(600);

      // Step 2: click homepage Login / Sign in entry
      onStep('clicking_home_login', {});
      const loginClicked = await clickHomeLoginButton(send, 20000);
      if (!loginClicked) throw new Error('Homepage Login/Sign in button not found');
      onStep('home_login_clicked', { text: loginClicked });
      await sleep(2500);

      // Step 3: Sign in with Google
      onStep('clicking_google_login', {});
      const googleClicked = await clickButtonByTexts(send, ['sign in with google', 'continue with google', 'google'], 25000);
      if (!googleClicked) throw new Error('Sign in with Google button not found');
      onStep('google_login_clicked', {});
    }, 90000);

    // 2) Switch to Google popup/page — HappyHorse OAuth usually opens a new window
    onStep('waiting_google_page', {});
    let googlePage = await waitForPageMatching(
      port,
      (url) => url.includes('accounts.google.com'),
      35000,
    );
    if (!googlePage) {
      const current = await cdpPage(port);
      if (current?.url?.includes('accounts.google.com')) googlePage = current;
    }
    if (!googlePage?.webSocketDebuggerUrl) {
      throw new Error('Google login page/popup not found (accounts.google.com)');
    }
    onStep('google_page_attached', { url: googlePage.url });

    await withPageSocket(googlePage, async (send, onEvent) => {
      await send('Page.enable');
      await send('Network.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      await sleep(2500);

      const currentUrl = await evaluateJs(send, 'location.href');
      if (currentUrl && currentUrl.includes('accountchooser')) {
        onStep('handling_account_chooser', { url: currentUrl });
        await evaluateJs(send, `(() => {
          const email = ${JSON.stringify(email)};
          const items = [...document.querySelectorAll('[data-identifier], [data-email], li, div')];
          for (const item of items) {
            if ((item.innerText || '').includes(email) && item.offsetWidth > 0) { item.click(); return 'matched'; }
          }
          const links = [...document.querySelectorAll('a, button, [role="link"], [role="button"], div')];
          for (const link of links) {
            const text = (link.innerText || '').trim().toLowerCase();
            if ((text.includes('another') || text.includes('其他') || text.includes('添加') || text.includes('不同')) && link.offsetWidth > 0) {
              link.click(); return 'another';
            }
          }
          return false;
        })()`);
        await sleep(2500);
      }

      const skipEmail = await evaluateJs(send, `(() => {
        const pwd = document.querySelector(${JSON.stringify(GOOGLE_PASSWORD_SELECTOR)});
        return !!(pwd && pwd.offsetWidth > 0);
      })()`);

      if (!skipEmail) {
        onStep('inputting_email', { email });
        await fillGoogleInput(send, GOOGLE_EMAIL_SELECTOR, email, 'Email');
        await sleep(400);
        onStep('email_next', {});
        if (!(await clickButtonByTexts(send, ['下一步', 'next'], 10000))) {
          await pressKey(send, 'Enter', 'Enter', 13);
        }
        await sleep(3500);
      } else {
        onStep('skipping_email_input', {});
      }

      onStep('inputting_password', {});
      const pwdReady = await findVisibleInputRect(send, GOOGLE_PASSWORD_SELECTOR, 60000);
      if (!pwdReady) throw new Error('Password input not found');
      await fillGoogleInput(send, GOOGLE_PASSWORD_SELECTOR, password, 'Password');
      await sleep(400);
      onStep('password_next', {});
      if (!(await clickButtonByTexts(send, ['下一步', 'next'], 10000))) {
        await pressKey(send, 'Enter', 'Enter', 13);
      }

      onStep('waiting_terms', {});
      for (let i = 0; i < 3; i++) {
        await sleep(1500);
        const accepted = await clickButtonByTexts(send, ['我了解', 'i understand', 'got it'], 8000);
        if (accepted) onStep('accepting_terms', { round: i + 1 });
        else break;
        await sleep(1500);
      }

      onStep('waiting_consent', {});
      await sleep(2000);
      await clickButtonByTexts(send, ['scroll down', '向下滚动'], 5000);
      await sleep(500);
      const continued = await clickButtonByTexts(send, ['continue', '继续', 'allow', '允许'], 15000);
      if (continued) onStep('consent_continued', {});

      await sleep(2000);
      await waitForUrlChange(send, onEvent, 8000);
    }, 180000);

    // 3) Back on HappyHorse — read auth_token from localStorage
    onStep('waiting_redirect', {});
    const hhPage = await waitForPageMatching(
      port,
      (url) => url.includes('happyhorse.com') && !url.includes('accounts.google.com'),
      90000,
    );
    if (!hhPage?.webSocketDebuggerUrl) {
      throw new Error('Did not redirect back to HappyHorse after Google login');
    }
    onStep('happyhorse_redirected', { url: hhPage.url });

    const result = await withPageSocket(hhPage, async (send) => {
      await send('Page.enable');
      await send('Network.enable');
      await send('Runtime.enable');
      await sleep(3000);

      onStep('extracting_state', {});
      let state = await extractAccountState(send);
      let tokenData = parseAuthTokenFromStorage(state.local_storage);

      for (let i = 0; i < 10 && !tokenData.accessToken; i++) {
        await sleep(1500);
        state = await extractAccountState(send);
        tokenData = parseAuthTokenFromStorage(state.local_storage);
      }

      if (!tokenData.accessToken) {
        throw new Error('Login finished but auth_token.accessToken missing in localStorage');
      }

      onStep('login_complete', {
        location: state.location,
        hasCookie: !!state.cookie,
        hasAccessToken: !!tokenData.accessToken,
        userId: tokenData.user?.uid || '',
        email,
      });

      return {
        state,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt: tokenData.expiresAt,
        user: tokenData.user,
        deviceId: tokenData.deviceId,
        bxUmidtoken: tokenData.bxUmidtoken,
      };
    }, 90000);

    return { ...result, port, profile };
  } finally {
    if (!options.keepOpen) {
      await terminateChromeProcess(chromeProc);
      if (temporaryProfile) removeTemporaryProfile(profile);
    }
  }
}

// CLI
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
    const result = await loginHappyHorseWithGoogle({
      email, password, visible, keepOpen, profileDir: profile, proxy,
      onStep: (step, data) => console.log(`[happyhorse-login] ${step}: ${JSON.stringify(data)}`),
    });
    console.log('[happyhorse-login] success!');
    console.log(`[happyhorse-login] access_token: ${result.accessToken ? 'ok' : 'missing'}`);
    console.log(`[happyhorse-login] state_json: ${JSON.stringify({
      cookie: result.state?.cookie || '',
      user_agent: result.state?.user_agent || '',
      access_token: result.accessToken,
      refresh_token: result.refreshToken || '',
      expires_at: result.expiresAt || 0,
      user_id: result.user?.uid || '',
      email: result.user?.nickname ? email : email,
      device_id: result.deviceId || '',
      bx_umidtoken: result.bxUmidtoken || '',
      location: result.state?.location || '',
    })}`);
  } catch (error) {
    console.error(`[happyhorse-login] failed: ${error.message}`);
    process.exit(1);
  }
}
