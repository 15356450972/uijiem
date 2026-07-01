#!/usr/bin/env node
/**
 * Dola Google OAuth Login Module
 *
 * Automates the full Dola → Google OAuth login flow via CDP:
 *   1. Launch Chrome with anti-detection flags (avoid CAPTCHA)
 *   2. Navigate to dola.com/chat
 *   3. Click "登录" → click Google login icon
 *   4. Input email → next → input password → next
 *   5. Accept Google Workspace terms → authorize Dola
 *   6. Confirm age dialog on Dola
 *   7. Extract cookies + account state (same format as grab-account.mjs)
 *
 * Anti-detection strategy to avoid CAPTCHA:
 *   - Persistent browser profile (Google remembers the device)
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
const DOLA_ORIGIN = 'https://www.dola.com';
const DOLA_CHAT_URL = `${DOLA_ORIGIN}/chat`;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 23000 + crypto.randomInt(1000, 9000);
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

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`CDP not ready: ${lastError?.message || url}`);
}

async function cdpPage(port) {
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  const normalPages = pages.filter((page) => {
    const url = page.url || '';
    return page.type === 'page' && !/^(chrome-extension|devtools|chrome):/.test(url);
  });
  return normalPages.find((p) => p.url?.includes('dola.com') || p.url?.includes('accounts.google.com')) || normalPages[0] || pages.find((p) => p.type === 'page') || pages[0];
}

async function withPageSocket(page, work, timeoutMs = 120000) {
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
  // Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Realistic plugins
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });

  // Realistic languages
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });

  // Chrome runtime
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};

  // Permissions API
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }

  // WebGL vendor/renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, parameter);
  };

  // Hairline feature detection
  const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', elementDescriptor);
  Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', elementDescriptor);

  // Prevent automation detection via CDP
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

// More reliable text insertion using CDP Input.insertText — directly inserts
// text into the currently focused element, bypassing key event simulation
// issues that can occur on some React-controlled inputs (e.g. Google password field).
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

function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie || '');
  return match ? match[1] : '';
}

function normalizeCookie(cookies) {
  return cookies
    .filter((c) => c.name && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function normalizeDolaCookie(cookies) {
  return normalizeCookie((cookies || []).filter((c) => {
    const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'dola.com' || domain.endsWith('.dola.com');
  }));
}

function firstValue(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function extractStorageValue(storage, names) {
  for (const [key, value] of Object.entries(storage || {})) {
    const lower = key.toLowerCase();
    if (names.some((n) => lower.includes(n))) return String(value || '');
  }
  return '';
}

function generateFallbackMsToken() {
  return crypto.randomBytes(78).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_') + '==';
}

async function extractAccountState(send) {
  const cookieResult = await send('Network.getCookies', { urls: [DOLA_ORIGIN, DOLA_CHAT_URL, 'https://dola.com'] });
  const cookie = normalizeCookie((cookieResult.cookies || []).filter((c) => {
    const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'dola.com' || domain.endsWith('.dola.com');
  }));

  const runtime = await send('Runtime.evaluate', {
    expression: `(() => {
      const fromUrl = {};
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      entries.unshift(location.href);
      for (const entry of entries) {
        try {
          const url = new URL(entry);
          for (const key of ['device_id', 'web_id', 'tea_uuid', 'web_tab_id', 'msToken']) {
            const value = url.searchParams.get(key);
            if (value) fromUrl[key] = value;
          }
        } catch {}
      }
      return JSON.stringify({
        user_agent: navigator.userAgent,
        location: location.href,
        cookie_ms_token: (document.cookie.match(/(?:^|;\\s*)msToken=([^;]+)/) || [])[1] || '',
        local_storage: Object.fromEntries(Object.entries(localStorage || {})),
        session_storage: Object.fromEntries(Object.entries(sessionStorage || {})),
        from_url: fromUrl,
      });
    })()`,
    returnByValue: true,
  });

  const pageState = JSON.parse(runtime.result?.value || '{}');
  const local = pageState.local_storage || {};
  const session = pageState.session_storage || {};
  const fromUrl = pageState.from_url || {};
  const cookieFp = cookieValue(cookie, 's_v_web_id');
  const webId = firstValue(fromUrl.web_id, extractStorageValue(local, ['web_id']), extractStorageValue(session, ['web_id']), cookieFp);
  const teaUuid = firstValue(fromUrl.tea_uuid, extractStorageValue(local, ['tea_uuid']), extractStorageValue(session, ['tea_uuid']), webId);
  const deviceId = firstValue(fromUrl.device_id, extractStorageValue(local, ['device_id']), extractStorageValue(session, ['device_id']), webId, teaUuid, cookieFp);
  const fp = firstValue(cookieFp, extractStorageValue(local, ['s_v_web_id', 'fp']), extractStorageValue(session, ['s_v_web_id', 'fp']), webId, teaUuid, deviceId);
  const msToken = firstValue(
    pageState.cookie_ms_token,
    extractStorageValue(local, ['ms_token', 'mstoken', 'msToken']),
    extractStorageValue(session, ['ms_token', 'mstoken', 'msToken']),
    cookieValue(cookie, 'msToken'),
    generateFallbackMsToken()
  );

  return {
    cookie,
    user_agent: firstValue(pageState.user_agent, DEFAULT_UA),
    device_id: deviceId,
    web_id: webId,
    tea_uuid: teaUuid,
    web_tab_id: firstValue(fromUrl.web_tab_id, extractStorageValue(session, ['web_tab_id']), extractStorageValue(local, ['web_tab_id'])),
    fp,
    ms_token: msToken,
    aid: '495671',
    version_code: '20800',
    pc_version: '3.17.3',
    location: pageState.location,
  };
}

// ── Main login flow ───────────────────────────────────────────────────────────

/**
 * Perform the full Dola Google OAuth login.
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
export async function loginDolaWithGoogle(options = {}) {
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

  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH.');

  // Use persistent profile for anti-detection (Google remembers the device)
  const defaultProfile = path.join(__dir, '.dola-profiles', 'default');
  const profile = path.resolve(profileDir || defaultProfile);
  fs.mkdirSync(profile, { recursive: true });

  // Anti-detection Chrome flags
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    // Anti-detection: hide automation
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
    // Realistic rendering
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
    // Realistic window size
    '--window-size=1280,800',
  ];

  if (!visible) args.push('--headless=new', '--disable-gpu');
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push(DOLA_CHAT_URL);

  onStep('launching', { port, profile, chrome });
  const chromeProc = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  chromeProc.unref();

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
    onStep('chrome_ready', { port });

    // Get the page and start the login flow
    const page = await cdpPage(port);
    if (!page?.webSocketDebuggerUrl) throw new Error('No connectable page found');

    const result = await withPageSocket(page, async (send, onEvent) => {
      await send('Page.enable');
      await send('Network.enable');
      await send('Runtime.enable');

      // Inject stealth scripts before any page interaction
      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      // Also inject into current page
      await send('Runtime.evaluate', { expression: STEALTH_JS });

      // ── Step 1: Wait for Dola page to load ────────────────────────────────
      onStep('waiting_dola_load', {});
      await sleep(5000);

      // ── Step 1b: Dismiss cookie consent dialog if present ──────────────────
      onStep('dismissing_cookie_consent', {});
      // Use JS click directly — more reliable than CDP mouse events for overlay elements
      await evaluateJs(send, `(() => {
        const banner = document.querySelector('[class*="cookie-banner"], [class*="cookie_banner"]');
        if (!banner) return false;
        const btn = [...banner.querySelectorAll('button')].find((b) => {
          const text = (b.innerText || '').trim();
          return (text === '我知道了' || text === 'Got it' || text === 'OK' || text === 'Accept') && b.offsetWidth > 0;
        });
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      await sleep(500);
      onStep('cookie_consent_dismissed', {});

      // ── Step 2: Click "登录" button (if login modal not already open) ──────
      onStep('clicking_login', {});
      // First check if login modal is already open
      const loginModalText = await evaluateJs(send, `(() => {
        const modal = document.querySelector('.semi-modal-content, [class*="login_modal"]');
        if (!modal) return '';
        const rect = modal.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return '';
        return (modal.innerText || '').slice(0, 200);
      })()`);
      
      if (!loginModalText || !loginModalText.includes('登录以解锁')) {
        // Login modal not open — click the "登录" button via JS (more reliable)
        // Retry for up to 10 seconds since the button may take time to render
        let clicked = false;
        const loginDeadline = Date.now() + 10000;
        while (Date.now() < loginDeadline && !clicked) {
          clicked = await evaluateJs(send, `(() => {
            const btns = [...document.querySelectorAll('button')].filter((b) => {
              const text = (b.innerText || '').trim();
              return text === '登录' && b.offsetWidth > 0 && b.offsetHeight > 0;
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
          // Maybe modal auto-opened, wait for it
          await sleep(2000);
        }
      } else {
        onStep('login_modal_already_open', { text: loginModalText.slice(0, 80) });
      }

      // ── Step 3: Click Google login button ─────────────────────────────────
      // The Google login button can be either:
      //   - A <button> with text "Google 登录" (newer Dola UI)
      //   - A <div> with class "button-PgvIWh" containing the Google logo image
      // Both contain an <img> with the Google logo (base64 iVBORw0KGgo...)
      // It may take a few seconds to render after the modal opens
      onStep('clicking_google_login', {});

      // Try JS click first (more reliable for div-based buttons)
      // Retry for up to 20 seconds since the Google button may take time to render
      let jsClicked = false;
      const googleDeadline = Date.now() + 20000;
      while (Date.now() < googleDeadline && !jsClicked) {
        jsClicked = await evaluateJs(send, `(() => {
          // Strategy 1: Find button with text containing "Google"
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim();
            return /google/i.test(text) && b.offsetWidth > 0 && b.offsetHeight > 0;
          });
          if (btns.length) {
            btns[0].click();
            return true;
          }
          // Strategy 2: Find the Google logo image and click its clickable parent
          const googleImg = document.querySelector('img[src*="iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/Nly"]');
          if (googleImg && googleImg.offsetWidth > 0) {
            let el = googleImg;
            while (el && el !== document.body) {
              const tag = el.tagName;
              const cls = (el.className || '').toString();
              if (tag === 'BUTTON' || cls.includes('button-PgvIWh') || cls.includes('clickable') || el.hasAttribute('data-disabled')) {
                if (el.offsetWidth > 0) {
                  el.click();
                  return true;
                }
              }
              el = el.parentElement;
            }
            googleImg.click();
            return true;
          }
          return false;
        })()`);
        if (!jsClicked) await sleep(500);
      }

      if (jsClicked) {
        onStep('google_login_clicked', {});
      } else {
        // Fallback: use CDP mouse events with waitForElement
        const googleBtn = await waitForElement(send, `(() => {
          // Strategy 1: Find button with text containing "Google"
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim();
            return /google/i.test(text) && b.offsetWidth > 0 && b.offsetHeight > 0;
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          // Strategy 2: Find the Google logo image and click its clickable parent
          const googleImg = document.querySelector('img[src*="iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/Nly"]');
          if (googleImg) {
            let el = googleImg;
            while (el && el !== document.body) {
              const tag = el.tagName;
              const cls = (el.className || '').toString();
              if (tag === 'BUTTON' || cls.includes('button-PgvIWh') || cls.includes('clickable') || el.hasAttribute('data-disabled')) {
                if (el.offsetWidth > 0) {
                  const rect = el.getBoundingClientRect();
                  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
              }
              el = el.parentElement;
            }
            const imgRect = googleImg.getBoundingClientRect();
            if (imgRect.width > 0) {
              return { x: imgRect.x + imgRect.width / 2, y: imgRect.y + imgRect.height / 2 };
            }
          }
          return null;
        })()`, 20000);

        if (!googleBtn) throw new Error('Google login button not found in login dialog');
        await clickElement(send, googleBtn.x, googleBtn.y);
        onStep('google_login_clicked', {});
      }

      // ── Step 4: Wait for Google login page and input email ────────────────
      onStep('waiting_google_page', {});
      // Wait for navigation to accounts.google.com
      let googleUrl = await waitForUrlChange(send, onEvent, 15000);
      onStep('google_page_loaded', { url: googleUrl });

      // Re-inject stealth on new page (for future navigations)
      await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
      // Wait for the Google page to fully load
      await sleep(4000);

      // ── Step 3.5: Handle account chooser page ───────────────────────────
      // If Google shows an account chooser (URL contains 'accountchooser'),
      // try to click the matching account or "Use another account" to proceed
      const currentUrl = await evaluateJs(send, 'location.href');
      if (currentUrl && currentUrl.includes('accountchooser')) {
        onStep('handling_account_chooser', { url: currentUrl });

        // Try to find and click the account matching our email
        const accountClicked = await evaluateJs(send, `(() => {
          // Strategy 1: Look for account items containing the email text
          const allItems = [...document.querySelectorAll('[data-identifier], [data-email], li, div')];
          for (const item of allItems) {
            const text = (item.innerText || '').trim();
            if (text.includes(${JSON.stringify(email)}) && item.offsetWidth > 0) {
              item.click();
              return 'matched';
            }
          }
          // Strategy 2: Look for "Use another account" / "使用其他账号" link
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
          // Wait for navigation to password page or consent page
          await sleep(3000);
          // After selecting a known account, we might go directly to password or consent
          // Check if password field is already visible
          const pwdVisible = await evaluateJs(send, `(() => {
            const pwd = document.querySelector('input[type="password"], input[name="Passwd"], input[name="password"]');
            return !!(pwd && pwd.offsetWidth > 0);
          })()`);
          if (pwdVisible) {
            onStep('account_chooser_password_ready', {});
            // Skip email input, go directly to password step
            // We'll set a flag to skip the email input section
          } else {
            // Wait for navigation to settle, then check if we're on email input page
            await waitForUrlChange(send, onEvent, 10000);
            await sleep(2000);
          }
        } else if (accountClicked === 'another') {
          onStep('account_chooser_another', {});
          // Wait for navigation to the email input page
          await waitForUrlChange(send, onEvent, 10000);
          await sleep(2000);
        } else {
          // Fallback: try clicking any visible account item or "Use another account"
          onStep('account_chooser_fallback', {});
          const fallbackClicked = await evaluateJs(send, `(() => {
            // Try clicking the first account item
            const items = [...document.querySelectorAll('[data-identifier], [data-email]')].filter((el) => el.offsetWidth > 0);
            if (items.length) { items[0].click(); return true; }
            // Try any "use another" link
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
      // Input email — use JS to focus and set value, then dispatch events
      // This is more reliable than CDP typeText for Google's React-based inputs
      onStep('inputting_email', { email });
      const emailEntered = await evaluateJs(send, `(() => {
        const input = document.querySelector('input[type="email"], input[name="identifier"], input[aria-label*="邮箱"], input[aria-label*="email" i], input[id="identifierId"]');
        if (!input || input.offsetWidth === 0) return false;
        input.focus();
        input.value = '';
        // Use React-compatible value setting
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, ${JSON.stringify(email)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);

      if (!emailEntered) {
        // Fallback: try CDP mouse click + typeText
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

      // Click "下一步" / "Next" button
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
        // Press Enter as fallback
        await pressKey(send, 'Enter', 'Enter', 13);
      }
      } // end of else (skipEmail)

      // ── Step 5: Wait for password page (may encounter CAPTCHA) ────────────
      onStep('waiting_password_page', {});
      // Wait for navigation or captcha — give the page time to load
      await sleep(5000);

      // First check if password page is already loaded (no CAPTCHA needed)
      // Use a broad selector: password inputs may have various attributes on v3 signin
      const pwdAlreadyVisible = await evaluateJs(send, `(() => {
        const pwd = document.querySelector('input[type="password"], input[name="password"], input[name="Passwd"], input[autocomplete="current-password"]');
        if (pwd && pwd.offsetWidth > 0) return true;
        // Also check for any visible text input that's not email (show-password mode)
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
        for (const input of inputs) {
          if (input.offsetWidth > 0 && input.name !== 'identifier' && input.type !== 'email' && input.type !== 'hidden') {
            // Check if it's in the password form context
            const formText = (input.closest('form')?.innerText || document.body?.innerText || '').slice(0, 200);
            if (formText.includes('密码') || formText.includes('password') || formText.includes('Password')) {
              return true;
            }
          }
        }
        return false;
      })()`);

      if (!pwdAlreadyVisible) {
        // Check if CAPTCHA appeared (only count visible captcha elements)
        const captchaCheck = await evaluateJs(send, `(() => {
          const captchaImg = document.querySelector('img[src*="Captcha"], img[alt*="captcha" i], img[alt*="人机"]');
          const captchaInput = document.querySelector('input[aria-label*="captcha" i], input[aria-label*="听到" i], input[aria-label*="看到" i]');
          // Only count as captcha if the input or image is actually visible
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
            // Wait for user to solve captcha manually (up to 120 seconds)
            onStep('waiting_captcha_solve', { message: 'CAPTCHA detected. Please solve it in the browser window.' });
            const captchaSolved = await waitForElement(send, `(() => {
              // After captcha is solved, password field appears
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
            // No CAPTCHA, wait for password page to load
            const pwdLoaded = await waitForElement(send, `(() => {
              const pwd = document.querySelector('input[type="password"], input[name="password"], input[name="Passwd"]');
              if (pwd && pwd.offsetWidth > 0) {
                const rect = pwd.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
              return null;
            })()`, 20000);
            if (!pwdLoaded) {
              // Check for error messages or unexpected state
              const pageText = await evaluateJs(send, 'document.body?.innerText?.slice(0, 500) || ""');
              throw new Error('Password page not loaded. Page text: ' + (pageText || '').slice(0, 200));
            }
          }
        }
      }

      // ── Step 6: Input password ────────────────────────────────────────────
      onStep('inputting_password', {});

      // Diagnostic: dump all inputs and check for shadow DOM
      const inputDiag = await evaluateJs(send, `(() => {
        const inputs = [...document.querySelectorAll('input')];
        const inputInfo = inputs.map((inp) => ({
          type: inp.type, name: inp.name, id: inp.id,
          autocomplete: inp.autocomplete, ariaLabel: inp.getAttribute('aria-label'),
          w: inp.offsetWidth, h: inp.offsetHeight,
          visible: inp.offsetWidth > 0 && inp.offsetHeight > 0,
        }));
        // Check for shadow DOM hosts
        const shadowHosts = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).map((el) => ({
          tag: el.tagName, class: (el.className || '').toString().slice(0, 50),
        }));
        // Check for iframes
        const iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, w: f.offsetWidth }));
        return JSON.stringify({ inputs: inputInfo, shadowHosts, iframes, inputCount: inputs.length });
      })()`);
      onStep('password_input_diagnostic', { diag: inputDiag });

      // Wait for password input to appear — use broad selector for v3 signin
      const pwdInput = await waitForElement(send, `(() => {
        // Strategy 1: Standard password selectors
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
        // Strategy 2: Any visible non-email input in password form context
        const inputs = [...document.querySelectorAll('input')];
        for (const input of inputs) {
          if (input.type === 'email' || input.type === 'hidden' || input.type === 'button' || input.type === 'submit') continue;
          if (input.offsetWidth === 0 || input.offsetHeight === 0) continue;
          if (input.name === 'identifier') continue;
          // Check context for password-related text
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

      // Click the password input to focus it
      await clickElement(send, pwdInput.x, pwdInput.y);
      await sleep(500);

      // Strategy 1: React-compatible value setter (same approach as email field)
      // Google's password field is React-controlled; nativeInputValueSetter + event
      // dispatch is the most reliable way to set the value.
      const pwdEntered = await evaluateJs(send, `(() => {
        const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]', 'input[aria-label*="密码"]', 'input[aria-label*="password" i]'];
        let input = null;
        for (const sel of selectors) {
          input = document.querySelector(sel);
          if (input && input.offsetWidth > 0) break;
          input = null;
        }
        // Fallback: any visible non-email input in password context
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

      // Verify the password was actually entered
      const pwdValueCheck = await evaluateJs(send, `(() => {
        const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]'];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input) return input.value.length;
        }
        return 0;
      })()`);

      if (!pwdEntered || !pwdValueCheck || pwdValueCheck === 0) {
        // Strategy 2: CDP Input.insertText (bypasses key event simulation issues)
        onStep('password_retry_inserttext', {});
        await clickElement(send, pwdInput.x, pwdInput.y);
        await sleep(300);
        await insertText(send, password);
        await sleep(300);
      }

      // Re-verify after insertText attempt
      const pwdValueCheck2 = await evaluateJs(send, `(() => {
        const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]'];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input) return input.value.length;
        }
        return 0;
      })()`);

      if (!pwdValueCheck2 || pwdValueCheck2 === 0) {
        // Strategy 3: CDP typeText (key event simulation as final fallback)
        onStep('password_retry_typetext', {});
        await clickElement(send, pwdInput.x, pwdInput.y);
        await sleep(300);
        await typeText(send, password);
      }
      await sleep(500);

      // Click "下一步" / "Next" — try JS click first, then CDP click, then Enter
      onStep('password_next', {});
      const pwdNextClicked = await evaluateJs(send, `(() => {
        // Strategy 1: button with text "下一步" / "Next"
        const nextTexts = ['下一步', 'next'];
        const btns = [...document.querySelectorAll('button')].filter((b) => {
          const text = (b.innerText || '').trim().toLowerCase();
          return nextTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
        });
        if (btns.length) { btns[0].click(); return true; }
        // Strategy 2: #passwordNext (older Google layout)
        const pwNext = document.querySelector('#passwordNext');
        if (pwNext && pwNext.offsetWidth > 0) {
          const clickTarget = pwNext.querySelector('button') || pwNext.querySelector('[role="button"]') || pwNext;
          clickTarget.click();
          return true;
        }
        // Strategy 3: Material Design button container
        const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
        if (materialBtns.length) { materialBtns[0].click(); return true; }
        return false;
      })()`);

      if (!pwdNextClicked) {
        // Fallback: CDP mouse click on button or #passwordNext
        const pwdNext = await waitForElement(send, `(() => {
          // button with text
          const nextTexts = ['下一步', 'next'];
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim().toLowerCase();
            return nextTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          // #passwordNext
          const pwNext = document.querySelector('#passwordNext');
          if (pwNext && pwNext.offsetWidth > 0) {
            const rect = pwNext.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          // Material Design button
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
          // Final fallback: press Enter
          await pressKey(send, 'Enter', 'Enter', 13);
        }
      }

      // ── Step 7: Handle Google Workspace terms (if appears) ────────────────
      onStep('waiting_terms', {});
      await sleep(1500);

      // Retry loop — terms page may take time to render after password submission
      let termsAccepted = false;
      const termsDeadline = Date.now() + 15000;
      while (Date.now() < termsDeadline && !termsAccepted) {
        termsAccepted = await evaluateJs(send, `(() => {
          // Strategy 1: Find button with known terms-acceptance text
          const acceptTexts = ['我了解', 'I understand', 'Accept', '同意', '继续', 'Continue', 'Next', '下一步', 'I accept', '我同意', 'Got it', '创建', 'Create', 'Sign in', '登录'];
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            const text = (b.innerText || '').trim();
            return acceptTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) {
            btns[0].click();
            return true;
          }
          // Strategy 2: Google Material Design button — div.VfPpkd-RLmnJb
          const materialBtns = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter((d) => d.offsetWidth > 0);
          if (materialBtns.length) {
            materialBtns[0].click();
            return true;
          }
          // Strategy 3: Any visible button that looks like acceptance
          const allBtns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim().toLowerCase();
            return acceptTexts.some(t => t.toLowerCase() === text);
          });
          if (allBtns.length) {
            allBtns[0].click();
            return true;
          }
          return false;
        })()`);
        if (!termsAccepted) await sleep(1000);
      }

      if (termsAccepted) {
        onStep('accepting_terms', {});
        await sleep(1500);
      } else {
        // Fallback: try CDP click with waitForElement
        const termsBtn = await waitForElement(send, `(() => {
          const acceptTexts = ['我了解', 'I understand', 'Accept', '同意', '继续', 'Continue', 'Next', '下一步', 'I accept', '我同意', 'Got it', '创建', 'Create', 'Sign in', '登录'];
          // Check buttons
          const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
            const text = (b.innerText || '').trim();
            return acceptTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          // Check Material Design div buttons
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
      // Retry loop — consent page may take time to render
      let consentDone = false;
      const consentDeadline = Date.now() + 15000;
      while (Date.now() < consentDeadline && !consentDone) {
        consentDone = await evaluateJs(send, `(() => {
          // Strategy 1: Find button with consent text
          const consentTexts = ['continue', '继续', 'allow', '允许', 'accept', '同意', 'i agree', '我同意'];
          const btns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
            const text = (b.innerText || '').trim().toLowerCase();
            return consentTexts.includes(text) && b.offsetWidth > 0 && !b.disabled;
          });
          if (btns.length) { btns[0].click(); return true; }
          // Strategy 2: Click any visible Material Design button container (VfPpkd-RLmnJb)
          // These divs are ripple containers inside buttons — they have no text but are clickable
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
        // Final fallback: CDP click on any VfPpkd-RLmnJb
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

      // ── Step 9: Wait for redirect back to Dola ────────────────────────────
      onStep('waiting_dola_redirect', {});
      // Wait for navigation to dola.com with access_token
      let dolaUrl = await waitForUrlChange(send, onEvent, 30000);

      // If we haven't navigated yet, wait more
      if (!dolaUrl || !dolaUrl.includes('dola.com')) {
        await sleep(3000);
        dolaUrl = await evaluateJs(send, 'location.href');
      }

      onStep('dola_redirected', { url: dolaUrl });

      // ── Step 9.5: Click "继续/Continue" button on Dola page (before age dialog) ─
      await sleep(1000);
      onStep('clicking_dola_continue', {});
      let continueClicked = false;
      const continueDeadline = Date.now() + 10000;
      while (Date.now() < continueDeadline && !continueClicked) {
        continueClicked = await evaluateJs(send, `(() => {
          // Look for any visible button with "继续" or "Continue" text
          const continueTexts = ['继续', 'continue', 'next', '下一步', 'proceed', 'go'];
          const btns = [...document.querySelectorAll('button, [role="button"], a')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim().toLowerCase();
            return continueTexts.includes(text);
          });
          if (btns.length) { btns[0].click(); return true; }
          // Also check Semi Design buttons
          const semiBtns = [...document.querySelectorAll('button')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim();
            const spanText = (b.querySelector('span')?.innerText || '').trim();
            return text === '继续' || spanText === '继续' || text === 'Continue' || spanText === 'Continue';
          });
          if (semiBtns.length) { semiBtns[0].click(); return true; }
          return false;
        })()`);
        if (!continueClicked) await sleep(1000);
      }
      if (continueClicked) {
        onStep('dola_continue_clicked', {});
        await sleep(1000);
      }

      // ── Step 10: Handle age confirmation dialog ───────────────────────────
      // Dola shows a Semi Design modal with aria-label="confirm" button after redirect
      // The button contains <span class="semi-button-content">确认</span>
      await sleep(1500);
      onStep('checking_age_confirm', {});

      // Retry loop — the age dialog may take a few seconds to appear after redirect
      let ageConfirmed = false;
      const ageDeadline = Date.now() + 15000;
      while (Date.now() < ageDeadline && !ageConfirmed) {
        ageConfirmed = await evaluateJs(send, `(() => {
          // Strategy 1: Semi Design button with aria-label="confirm"
          const confirmBtns = [...document.querySelectorAll('button[aria-label="confirm"]')].filter((b) => b.offsetWidth > 0 && !b.disabled);
          if (confirmBtns.length) { confirmBtns[0].click(); return true; }
          // Strategy 2: Button with text "确认" (check innerText and span text)
          const textBtns = [...document.querySelectorAll('button')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim();
            const spanText = (b.querySelector('span')?.innerText || '').trim();
            return text === '确认' || spanText === '确认' || text === 'Confirm' || spanText === 'Confirm';
          });
          if (textBtns.length) { textBtns[0].click(); return true; }
          // Strategy 3: Age gate buttons
          const ageBtns = [...document.querySelectorAll('button')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim();
            return text === '我已满18周岁' || text === '我已年满18岁' || text === 'I am 18+' || text === 'I am over 18';
          });
          if (ageBtns.length) { ageBtns[0].click(); return true; }
          return false;
        })()`);
        if (!ageConfirmed) await sleep(1000);
      }

      if (ageConfirmed) {
        onStep('confirming_age', {});
        await sleep(1000);
      } else {
        // Fallback: CDP mouse click
        const ageConfirm = await waitForElement(send, `(() => {
          // Semi Design button with aria-label="confirm"
          const confirmBtns = [...document.querySelectorAll('button[aria-label="confirm"]')].filter((b) => b.offsetWidth > 0 && !b.disabled);
          if (confirmBtns.length) {
            const rect = confirmBtns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          // Any button with "确认" text
          const btns = [...document.querySelectorAll('button')].filter((b) => {
            if (b.offsetWidth === 0 || b.disabled) return false;
            const text = (b.innerText || '').trim();
            const spanText = (b.querySelector('span')?.innerText || '').trim();
            return text === '确认' || spanText === '确认' || text === '我已满18周岁' || text === '我已年满18岁';
          });
          if (btns.length) {
            const rect = btns[0].getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
          return null;
        })()`, 5000);

        if (ageConfirm) {
          onStep('confirming_age', {});
          await clickElement(send, ageConfirm.x, ageConfirm.y);
          await sleep(1000);
        }
      }

      // ── Step 11: Wait for Dola chat page to fully load ────────────────────
      onStep('waiting_dola_chat', {});
      await sleep(1500);

      // ── Step 12: Extract account state ────────────────────────────────────
      onStep('extracting_state', {});
      const state = await extractAccountState(send);

      // Check if we have the access_token in URL
      const accessToken = dolaUrl?.match(/access_token=([^&]+)/)?.[1] || '';

      onStep('login_complete', {
        location: state.location,
        hasCookie: !!state.cookie,
        hasAccessToken: !!accessToken,
      });

      return { state, accessToken, redirectUrl: dolaUrl };
    }, 180000);

    return {
      ...result,
      port,
      profile,
    };
  } finally {
    if (!options.keepOpen) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { chromeProc.kill(); } catch {}
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
    const result = await loginDolaWithGoogle({
      email,
      password,
      visible,
      keepOpen,
      profileDir: profile,
      proxy,
      onStep: (step, data) => {
        console.log(`[dola-login] ${step}: ${JSON.stringify(data)}`);
      },
    });
    console.log('[dola-login] success!');
    console.log(`[dola-login] cookie: ${result.state.cookie ? 'ok' : 'missing'}`);
    console.log(`[dola-login] access_token: ${result.accessToken ? 'ok' : 'missing'}`);
    console.log(`[dola-login] location: ${result.state.location}`);
    // Output full state as JSON line for programmatic parsing
    console.log(`[dola-login] state_json: ${JSON.stringify({
      cookie: result.state.cookie,
      user_agent: result.state.user_agent,
      device_id: result.state.device_id,
      web_id: result.state.web_id,
      tea_uuid: result.state.tea_uuid,
      web_tab_id: result.state.web_tab_id,
      fp: result.state.fp,
      ms_token: result.state.ms_token,
      access_token: result.accessToken,
      location: result.state.location,
      email,
    })}`);
  } catch (error) {
    console.error(`[dola-login] failed: ${error.message}`);
    process.exit(1);
  }
}
