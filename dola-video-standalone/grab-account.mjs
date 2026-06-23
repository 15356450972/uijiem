#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DOLA_ORIGIN = 'https://www.dola.com';
const DOLA_CHAT_URL = `${DOLA_ORIGIN}/chat`;
const DEFAULT_HI_TEXT = '\u4f60\u597d';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const ENV_KEYS = [
  'DOLA_COOKIE',
  'DOLA_USER_AGENT',
  'DOLA_DEVICE_ID',
  'DOLA_WEB_ID',
  'DOLA_TEA_UUID',
  'DOLA_WEB_TAB_ID',
  'DOLA_AID',
  'DOLA_VERSION_CODE',
  'DOLA_PC_VERSION',
  'DOLA_FP',
  'DOLA_MS_TOKEN',
];

function generateFallbackMsToken() {
  return crypto.randomBytes(78).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_') + '==';
}

function defaultGrabPaths(baseDir) {
  return {
    envFile: path.resolve(baseDir, '.env.dola'),
    profileDir: path.resolve(baseDir, '.doubao_browsers', 'dola-account-profile'),
  };
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

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function cleanProfileDirSafe(profileDir) {
  const resolved = path.resolve(profileDir || '');
  const allowedRoots = [
    path.resolve(__dir, '.doubao_browsers'),
    path.resolve(__dir, '..', '_wizstar_data_test', 'dola', 'accounts'),
    path.resolve(process.cwd(), '_wizstar_data_test', 'dola', 'accounts'),
    process.env.WIZSTAR_HOME ? path.resolve(process.env.WIZSTAR_HOME, 'dola', 'accounts') : '',
    process.env.HOME ? path.resolve(process.env.HOME, '.wizstar', 'dola', 'accounts') : '',
    process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE, '.wizstar', 'dola', 'accounts') : '',
  ].filter(Boolean);
  const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!resolved || resolved === path.parse(resolved).root || !allowed) {
    throw new Error(`Refusing to clear unsafe profile directory: ${profileDir}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 19000 + crypto.randomInt(1000, 9000);
}

function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie || '');
  return match ? match[1] : '';
}

function normalizeCookie(cookies) {
  return cookies
    .filter((cookie) => cookie.name && typeof cookie.value === 'string')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function normalizeDolaCookie(cookies) {
  return normalizeCookie((cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'dola.com' || domain.endsWith('.dola.com');
  }));
}

async function getDolaBrowserCookie(send) {
  const byUrl = await send('Network.getCookies', { urls: [DOLA_ORIGIN, DOLA_CHAT_URL, 'https://dola.com', 'https://dola.com/chat'] })
    .catch(() => ({ cookies: [] }));
  const cookieByUrl = normalizeCookie(byUrl.cookies || []);
  if (cookieByUrl) return { cookie: cookieByUrl, source: 'browser-cookies' };

  const all = await send('Network.getAllCookies').catch(() => ({ cookies: [] }));
  const cookieByDomain = normalizeDolaCookie(all.cookies || []);
  if (cookieByDomain) return { cookie: cookieByDomain, source: 'browser-all-cookies' };

  return { cookie: '', source: 'browser-cookies' };
}

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
  return normalPages.find((page) => page.url?.includes('dola.com')) || normalPages[0] || pages.find((page) => page.type === 'page') || pages[0];
}

async function withPageSocket(page, work, timeoutMs = 30000) {
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
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
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

async function activeDolaPage(port) {
  const page = await cdpPage(port);
  if (!page?.webSocketDebuggerUrl) throw new Error('No connectable dola page found');
  await fetch(`http://127.0.0.1:${port}/json/activate/${page.id}`).catch(() => null);
  return page;
}

function waitForHiRequestCookie(onEvent, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const targetRequestIds = new Map();
    const pendingExtraInfo = new Map();

    const cookieFromExtraInfo = (params = {}) => {
      const headers = params.headers || {};
      const cookie = headers.Cookie || headers.cookie || '';
      const associatedCookies = params.associatedCookies || [];
      const cookieFromAssociated = associatedCookies
        .map((item) => item.cookie)
        .filter((item) => item?.name && typeof item.value === 'string')
        .map((item) => `${item.name}=${item.value}`)
        .join('; ');
      return {
        cookie: cookie || cookieFromAssociated,
        source: cookie ? 'request-extra-info' : 'associated-cookies',
      };
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
    const unsubscribe = onEvent((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        const url = message.params?.request?.url || '';
        if (/\/chat\/completion(?:\?|$)/.test(url)) {
          const requestId = message.params?.requestId || '';
          targetRequestIds.set(requestId, url);
          const headers = message.params?.request?.headers || {};
          const cookie = headers.Cookie || headers.cookie || '';
          if (cookie) {
            finish({ cookie, requestId, source: 'request-header', url });
            return;
          }
          const pending = pendingExtraInfo.get(requestId);
          if (pending) {
            const extra = cookieFromExtraInfo(pending);
            if (extra.cookie) finish({ cookie: extra.cookie, requestId, source: extra.source, url });
          }
        }
        return;
      }
      if (message.method !== 'Network.requestWillBeSentExtraInfo') return;
      const requestId = message.params?.requestId || '';
      pendingExtraInfo.set(requestId, message.params || {});
      if (!targetRequestIds.has(requestId)) return;
      const extra = cookieFromExtraInfo(message.params || {});
      if (!extra.cookie) return;
      finish({
        cookie: extra.cookie,
        requestId,
        source: extra.source,
        url: targetRequestIds.get(requestId) || '',
      });
    });
  });
}

async function dismissDolaLoginModal(send) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => null);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => null);
  await sleep(500);

  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const visibleNodes = [...document.querySelectorAll('div, section, aside, dialog, [role="dialog"], [class*="modal"], [class*="popup"], [class*="float"]')]
        .filter(isVisible);
      const loginNode = visibleNodes.find((node) => /登录以解锁更多功能|请输入手机号|打开\s*Dola\s*App|点击扫一扫/.test(node.innerText || ''));
      if (!loginNode) return JSON.stringify({ found: false, closed: false });

      const all = [...loginNode.querySelectorAll('button, [role="button"], svg, [class*="close"], [aria-label], [title]'), ...document.querySelectorAll('button, [role="button"], svg, [class*="close"], [aria-label], [title]')]
        .filter(isVisible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.title, el.className]
            .filter(Boolean).join(' ').toLowerCase();
          const nearTopRight = rect.top < window.innerHeight * 0.45 && rect.left > window.innerWidth * 0.45;
          const explicitClose = /close|关闭|取消|稍后|skip|x|icon-close/.test(label);
          const smallIcon = rect.width > 8 && rect.height > 8 && rect.width <= 64 && rect.height <= 64;
          return { el, rect, label, nearTopRight, explicitClose, smallIcon };
        })
        .filter((item) => item.explicitClose || (item.nearTopRight && item.smallIcon))
        .sort((a, b) => {
          const score = (item) => (item.explicitClose ? 0 : 20) + Math.abs(item.rect.right - window.innerWidth) + item.rect.top;
          return score(a) - score(b);
        });

      const target = all[0]?.el;
      if (target) {
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return JSON.stringify({ found: true, closed: true, method: 'click', label: all[0].label.slice(0, 120) });
      }

      loginNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return JSON.stringify({ found: true, closed: false, method: 'escape-only' });
    })()`,
    returnByValue: true,
  });

  let parsed = {};
  try { parsed = JSON.parse(result.result?.value || '{}'); } catch {}
  if (parsed.found) await sleep(1200);
  return parsed;
}

async function clearDolaSiteState(send, targetUrl = DOLA_CHAT_URL) {
  await send('Network.enable').catch(() => null);
  await send('Page.enable').catch(() => null);

  const before = await send('Network.getCookies', { urls: [DOLA_ORIGIN, DOLA_CHAT_URL, 'https://dola.com'] }).catch(() => ({ cookies: [] }));
  await send('Network.clearBrowserCache').catch(() => null);
  await send('Network.clearBrowserCookies').catch(() => null);

  for (const origin of [DOLA_ORIGIN, 'https://dola.com']) {
    await send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'all',
    }).catch(() => null);
  }

  await send('Page.navigate', { url: `${DOLA_ORIGIN}/?__wizstar_clear=${Date.now()}` }).catch(() => null);
  await sleep(1500);
  await send('Runtime.evaluate', {
    expression: `(() => {
      const expireCookie = (name, domain = '') => {
        const domainPart = domain ? '; domain=' + domain : '';
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + domainPart;
      };
      try {
        for (const item of document.cookie.split(';')) {
          const name = item.split('=')[0]?.trim();
          if (!name) continue;
          expireCookie(name);
          expireCookie(name, '.dola.com');
          expireCookie(name, 'www.dola.com');
        }
      } catch {}
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try { caches?.keys?.().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))); } catch {}
      try {
        indexedDB.databases?.().then((databases) => {
          for (const db of databases || []) if (db.name) indexedDB.deleteDatabase(db.name);
        });
      } catch {}
      return true;
    })()`,
    returnByValue: true,
  }).catch(() => null);

  await send('Network.clearBrowserCache').catch(() => null);
  await send('Network.clearBrowserCookies').catch(() => null);
  for (const origin of [DOLA_ORIGIN, 'https://dola.com']) {
    await send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'all',
    }).catch(() => null);
  }
  const after = await send('Network.getCookies', { urls: [DOLA_ORIGIN, DOLA_CHAT_URL, 'https://dola.com'] }).catch(() => ({ cookies: [] }));
  await send('Page.navigate', { url: targetUrl }).catch(() => null);
  await sleep(3000);
  return { origin: DOLA_ORIGIN, beforeCookies: (before.cookies || []).length, afterCookies: (after.cookies || []).length, targetUrl };
}

async function dismissDolaCookieNotice(send) {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter(isVisible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          const parentText = (el.closest('div, section, aside, dialog')?.innerText || '').slice(0, 300);
          return { el, text, parentText, rect };
        })
        .filter((item) => /我知道了|同意|接受|允许|OK|Got it/i.test(item.text));
      const target = candidates.sort((a, b) => {
        const score = (item) => {
          const exact = /^(我知道了|同意|接受|允许|OK|Got it)$/i.test(item.text) ? 0 : 100;
          const cookieBox = /Cookie|缓存|用户体验|服务|安全措施/i.test(item.parentText) ? 0 : 200;
          const bottomLeft = item.rect.left < window.innerWidth * 0.45 && item.rect.top > window.innerHeight * 0.45 ? 0 : 50;
          return exact + cookieBox + bottomLeft + Math.abs(item.rect.left) + Math.abs(window.innerHeight - item.rect.bottom);
        };
        return score(a) - score(b);
      })[0]?.el;
      if (!target) return JSON.stringify({ found: false, clicked: false });
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return JSON.stringify({ found: true, clicked: true, text: target.innerText || target.textContent || '', x, y });
    })()`,
    returnByValue: true,
  }).catch(() => null);
  let parsed = {};
  try { parsed = JSON.parse(result?.result?.value || '{}'); } catch {}
  if (parsed.clicked && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: parsed.x, y: parsed.y }).catch(() => null);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: parsed.x, y: parsed.y, button: 'left', clickCount: 1 }).catch(() => null);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: parsed.x, y: parsed.y, button: 'left', clickCount: 1 }).catch(() => null);
  }
  if (parsed.clicked) await sleep(800);
  return parsed;
}

async function sendHiToDolaSocket(send, message = DEFAULT_HI_TEXT) {
  let lastDismiss = {};
  let lastCookieNotice = {};
  let lastAttempt = {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lastCookieNotice = await dismissDolaCookieNotice(send).catch(() => ({}));
    lastDismiss = await dismissDolaLoginModal(send).catch(() => ({}));
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const text = ${JSON.stringify(message)};
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null;
        const getText = (el) => {
          if (!el) return '';
          if (el.isContentEditable || el.classList.contains('ProseMirror')) return el.innerText || el.textContent || '';
          return el.value || el.innerText || el.textContent || '';
        };
        const setNativeValue = (el, value) => {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          setter ? setter.call(el, value) : (el.value = value);
        };
        const inputCandidates = [
          ...document.querySelectorAll('textarea'),
          ...document.querySelectorAll('[contenteditable="true"]'),
          ...document.querySelectorAll('input[type="text"]'),
          ...document.querySelectorAll('[role="textbox"]'),
          ...document.querySelectorAll('.ProseMirror'),
        ].filter((el) => isVisible(el) && !isDisabled(el));
        inputCandidates.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.bottom - ar.bottom) || (br.right - ar.right);
        });
        const input = inputCandidates[0];
        if (!input) {
          const bodyText = document.body?.innerText || '';
          return JSON.stringify({
            ok: false,
            reason: 'textbox_not_found',
            location: location.href,
            title: document.title || '',
            inputCandidates: inputCandidates.length,
            bodyText: bodyText.slice(0, 500),
          });
        }

        input.scrollIntoView({ block: 'center', inline: 'center' });
        const inputRect = input.getBoundingClientRect();
        const clickableCandidates = [
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('[role="button"]'),
          ...document.querySelectorAll('svg'),
          ...document.querySelectorAll('[class*="send"], [aria-label*="发送"], [aria-label*="send" i]'),
        ].filter((el) => isVisible(el) && !isDisabled(el));
        const sendCandidates = clickableCandidates
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const label = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.className]
              .filter(Boolean).join(' ');
            const nearInputRight = rect.left > inputRect.left + inputRect.width * 0.55 && rect.top > inputRect.top - 40 && rect.bottom < inputRect.bottom + 40;
            const explicitSend = /发送|send|arrow|submit|up/i.test(label);
            const roundBottomRight = rect.width >= 24 && rect.width <= 72 && rect.height >= 24 && rect.height <= 72 && nearInputRight;
            return { el, rect, label, nearInputRight, explicitSend, roundBottomRight };
          })
          .filter((item) => item.explicitSend || item.roundBottomRight)
          .sort((a, b) => {
            const score = (item) => (item.explicitSend ? 0 : 20) + Math.abs(item.rect.right - inputRect.right) + Math.abs(item.rect.bottom - inputRect.bottom);
            return score(a) - score(b);
          });
        const sendButton = sendCandidates[0];
        if (sendButton) {
          const rect = sendButton.rect;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const inputCenterX = inputRect.left + inputRect.width / 2;
          const inputCenterY = inputRect.top + inputRect.height / 2;
          return JSON.stringify({ ok: true, method: 'cdp-input-click', value: text, inputText: getText(input), sendLabel: sendButton.label.slice(0, 120), x, y, inputX: inputCenterX, inputY: inputCenterY, location: location.href });
        }

        return JSON.stringify({ ok: false, reason: 'send_button_not_found', value: text, inputText: getText(input), location: location.href });
      })()`,
      returnByValue: true,
    });

    let parsed = {};
    try { parsed = JSON.parse(result.result?.value || '{}'); } catch {}
    lastAttempt = { parsed, dismissedLoginModal: lastDismiss, cookieNotice: lastCookieNotice };
    if (parsed.ok) {
      if (parsed.method === 'cdp-input-click' && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        if (Number.isFinite(parsed.inputX) && Number.isFinite(parsed.inputY)) {
          const selectModifier = process.platform === 'darwin' ? 4 : 2;
          const selectKey = process.platform === 'darwin' ? 'Meta' : 'Control';
          const selectCode = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
          const selectKeyCode = process.platform === 'darwin' ? 91 : 17;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: parsed.inputX, y: parsed.inputY }).catch(() => null);
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: parsed.inputX, y: parsed.inputY, button: 'left', clickCount: 1 }).catch(() => null);
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: parsed.inputX, y: parsed.inputY, button: 'left', clickCount: 1 }).catch(() => null);
          await sleep(300);
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: selectKey, code: selectCode, windowsVirtualKeyCode: selectKeyCode, nativeVirtualKeyCode: selectKeyCode, modifiers: selectModifier }).catch(() => null);
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: selectModifier }).catch(() => null);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: selectModifier }).catch(() => null);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: selectKey, code: selectCode, windowsVirtualKeyCode: selectKeyCode, nativeVirtualKeyCode: selectKeyCode }).catch(() => null);
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => null);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => null);
          await send('Input.insertText', { text: message }).catch(() => null);
          await sleep(500);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: parsed.x, y: parsed.y }).catch(() => null);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: parsed.x, y: parsed.y, button: 'left', clickCount: 1 }).catch(() => null);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: parsed.x, y: parsed.y, button: 'left', clickCount: 1 }).catch(() => null);
      }
      await sleep(2500);
      const verify = await send('Runtime.evaluate', {
        expression: `(() => {
          const text = ${JSON.stringify(message)};
          const isVisible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const inputs = [
            ...document.querySelectorAll('textarea'),
            ...document.querySelectorAll('[contenteditable="true"]'),
            ...document.querySelectorAll('input[type="text"]'),
            ...document.querySelectorAll('[role="textbox"]'),
            ...document.querySelectorAll('.ProseMirror'),
          ].filter(isVisible);
          inputs.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
          const input = inputs[0];
          const inputText = input ? (input.value || input.innerText || input.textContent || '') : '';
          const bodyText = document.body?.innerText || '';
          return JSON.stringify({
            inputCleared: !inputText.includes(text),
            pageContainsText: bodyText.includes(text),
            inputText,
            location: location.href,
          });
        })()`,
        returnByValue: true,
      });
      let checked = {};
      try { checked = JSON.parse(verify.result?.value || '{}'); } catch {}
      lastAttempt = { parsed, verify: checked, dismissedLoginModal: lastDismiss, cookieNotice: lastCookieNotice };
      if (checked.inputCleared) {
        return { ...parsed, confirmed: true, dismissedLoginModal: lastDismiss, cookieNotice: lastCookieNotice, verify: checked };
      }
      return { ...parsed, confirmed: false, dismissedLoginModal: lastDismiss, cookieNotice: lastCookieNotice, verify: checked };
    }

    await sleep(1000);
  }

  throw new Error(`Dola chat textbox found but hello was not submitted. Last page state: ${JSON.stringify(lastAttempt).slice(0, 1200)}`);
}

async function extractFromPage(port, waitMs, options = {}) {
  const page = await activeDolaPage(port);

  return await withPageSocket(page, async (send, onEvent) => {
    await send('Network.enable');
    await send('Page.enable').catch(() => null);
    const actions = {};
    actions.clearSiteState = await clearDolaSiteState(send, options.url || DOLA_CHAT_URL);
    await sleep(waitMs);
    let requestCookie = null;
    if (options.sendHi) {
      const requestCookiePromise = waitForHiRequestCookie(onEvent, Math.max(15000, Number(options.waitMs || 8000) + 10000));
      actions.sendHi = await sendHiToDolaSocket(send, options.hiText || DEFAULT_HI_TEXT);
      requestCookie = await requestCookiePromise;
      actions.sendHi.requestCookieCaptured = Boolean(requestCookie?.cookie);
      actions.sendHi.requestCookieSource = requestCookie?.source || '';
      if (!requestCookie?.cookie) {
        actions.sendHi.requestCookieWarning = 'Dola hello request was not exposed through CDP request headers; falling back to browser cookies.';
      }
    }
    const browserCookieResult = await getDolaBrowserCookie(send);
    const browserCookie = browserCookieResult.cookie;
    const cookie = firstValue(requestCookie?.cookie, browserCookie);
    const cookieSource = requestCookie?.cookie ? requestCookie.source : browserCookieResult.source;
    actions.cookieSource = cookieSource;
    actions.requestCookieCaptured = Boolean(requestCookie?.cookie);
    actions.browserCookieCaptured = Boolean(browserCookie);
    if (actions.sendHi && !requestCookie?.cookie && browserCookie) {
      actions.sendHi.requestCookieFallback = cookieSource;
    }
    const runtime = await send('Runtime.evaluate', {
      expression: `(() => {
        const fromUrl = {};
        const entries = performance.getEntriesByType('resource').map((entry) => entry.name);
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
    return { cookie, browserCookie, requestCookie, cookieSource, pageState, actions };
  }, Math.max(60000, Number(options.waitMs || 8000) + 45000));
}

async function clearDolaLogin(port) {
  const page = await activeDolaPage(port);

  return await withPageSocket(page, async (send) => {
    await send('Network.enable');
    const cookies = await send('Network.getCookies', { urls: [DOLA_ORIGIN, DOLA_CHAT_URL] });
    for (const cookie of cookies.cookies || []) {
      await send('Network.deleteCookies', {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      }).catch(() => null);
    }
    await send('Storage.clearDataForOrigin', {
      origin: DOLA_ORIGIN,
      storageTypes: 'cookies,local_storage,indexeddb,service_workers,cache_storage',
    }).catch(() => null);
    await send('Runtime.evaluate', {
      expression: `(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
        try {
          indexedDB.databases?.().then((databases) => {
            for (const db of databases || []) if (db.name) indexedDB.deleteDatabase(db.name);
          });
        } catch {}
        return true;
      })()`,
      returnByValue: true,
    });
    return { clearedCookies: (cookies.cookies || []).length };
  });
}

function firstValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractStorageValue(storage, names) {
  for (const [key, value] of Object.entries(storage || {})) {
    const lower = key.toLowerCase();
    if (names.some((name) => lower.includes(name))) return String(value || '');
  }
  return '';
}

function buildAccountState({ cookie, cookieSource, pageState }) {
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
    cookie_source: firstValue(cookieSource, 'unknown'),
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
  };
}

function upsertEnv(content, key, value) {
  if (value === undefined || value === null || value === '') return content;
  const line = `${key}=${String(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  return `${content}${prefix}${line}\n`;
}

function writeDolaEnv(envFile, state) {
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const before = content;
  const values = {
    DOLA_COOKIE: state.cookie,
    DOLA_USER_AGENT: state.user_agent,
    DOLA_DEVICE_ID: state.device_id,
    DOLA_WEB_ID: state.web_id,
    DOLA_TEA_UUID: state.tea_uuid,
    DOLA_WEB_TAB_ID: state.web_tab_id,
    DOLA_AID: state.aid,
    DOLA_VERSION_CODE: state.version_code,
    DOLA_PC_VERSION: state.pc_version,
    DOLA_FP: state.fp,
    DOLA_MS_TOKEN: state.ms_token,
  };

  for (const key of ENV_KEYS) content = upsertEnv(content, key, values[key]);
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, content, 'utf8');

  return { changed: before !== content, keys: Object.keys(values).filter((key) => values[key]) };
}

function validateAccount(state) {
  const missing = [];
  if (!state.cookie || !state.cookie.includes('ttwid=')) missing.push('DOLA_COOKIE(ttwid)');
  if (!state.user_agent) missing.push('DOLA_USER_AGENT');
  if (!state.fp) missing.push('DOLA_FP');
  return missing;
}

async function grabDolaAccount(options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const defaults = defaultGrabPaths(baseDir);
  const chromePath = options.chromePath || findChrome();
  if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH to the Chrome executable.');

  const envFile = path.resolve(options.out || defaults.envFile);
  const profileDir = path.resolve(options.profile || defaults.profileDir);
  const port = options.port || randomPort();
  const visible = options.visible !== false && !options.headless;
  const waitMs = Number(options.waitMs || 8000);
  const actions = {};

  actions.clearProfile = { profileDir: cleanProfileDirSafe(profileDir) };

  const targetUrl = options.url || DOLA_CHAT_URL;

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
  ];
  if (!visible) args.push('--headless=new', '--disable-gpu');
  if (options.proxy) args.push(`--proxy-server=${options.proxy}`);
  args.push(targetUrl);

  const chrome = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  chrome.unref();

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
    const raw = await extractFromPage(port, waitMs, options);
    Object.assign(actions, raw.actions || {});
    const state = buildAccountState(raw);
    const missing = validateAccount(state);
    if (missing.length) {
      throw new Error(`grab incomplete: ${missing.join(', ')}. Please log in to dola and rerun with --visible.`);
    }
    const written = writeDolaEnv(envFile, state);
    if (options.clearLogin) {
      actions.clearLogin = await clearDolaLogin(port);
    }
    return { state, envFile, profileDir, port, written, actions };
  } finally {
    if (!options.keepOpen) {
      try { process.kill(-chrome.pid); } catch {}
      try { chrome.kill(); } catch {}
    }
  }
}

function parseArgs(argv) {
  const options = {
    baseDir: __dir,
    visible: true,
    headless: false,
    sendHi: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--visible') options.visible = true;
    else if (arg === '--headless') {
      options.headless = true;
      options.visible = false;
    } else if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--send-hi') options.sendHi = true;
    else if (arg === '--hi-text') {
      options.sendHi = true;
      options.hiText = next();
    } else if (arg === '--close-login' || arg === '--clear-login') options.clearLogin = true;
    else if (arg === '--proxy') options.proxy = next();
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--url') options.url = next();
    else if (arg === '--chrome') options.chromePath = next();
    else if (arg === '--wait-ms') options.waitMs = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  const defaults = defaultGrabPaths(__dir);
  return `Usage:
  node grab-account.mjs [--visible|--headless] [--hi-text TEXT] [--close-login] [--proxy URL] [--profile DIR] [--out FILE]

Defaults:
  profile: ${defaults.profileDir}
  out:     ${defaults.envFile}

Options:
  --visible      Open Chrome window, suitable for first login or QR login.
  --headless     Run without UI, suitable for an existing logged-in profile.
  --keep-open    Keep Chrome open after grabbing.
  --send-hi      Send "你好" for account validation; prefer the real request Cookie and fall back to browser cookies. Enabled by default.
  --hi-text TEXT Send custom text for the account validation request.
  --close-login  Clear Dola cookies/storage from the selected profile after grabbing.
  --clear-login  Alias of --close-login.
  --proxy URL    Set Chrome proxy server.
  --profile DIR  Use a specific dola browser profile directory.
  --out FILE     Write account state to a specific .env.dola file.
  --chrome FILE  Use a specific Chrome executable.
  --wait-ms N    Wait after page load before grabbing, default 8000.
`;
}

function printResult(result) {
  const state = result.state;
  const present = {
    cookie: Boolean(state.cookie),
    user_agent: Boolean(state.user_agent),
    device_id: Boolean(state.device_id),
    web_id: Boolean(state.web_id),
    tea_uuid: Boolean(state.tea_uuid),
    web_tab_id: Boolean(state.web_tab_id),
    fp: Boolean(state.fp),
    ms_token: Boolean(state.ms_token),
  };

  console.log('[grab-account] dola account grabbed');
  console.log(`[grab-account] env: ${result.envFile}`);
  console.log(`[grab-account] profile: ${result.profileDir}`);
  console.log(`[grab-account] fields: ${Object.entries(present).map(([key, ok]) => `${key}=${ok ? 'ok' : 'missing'}`).join(', ')}`);
  console.log(`[grab-account] cookie-source: ${state.cookie_source || 'unknown'}`);
  if (result.actions?.sendHi) {
    const action = result.actions.sendHi;
    if (action.cookieNotice?.found) {
      console.log(`[grab-account] cookie-notice: handled (${action.cookieNotice.clicked ? 'clicked' : 'seen'})`);
    }
    if (action.dismissedLoginModal?.found) {
      console.log(`[grab-account] login-modal: dismissed (${action.dismissedLoginModal.closed ? 'closed' : 'escape-only'})`);
    }
    console.log(`[grab-account] send-hi: submitted (${action.method}, confirmed=${action.confirmed ? 'yes' : 'no'}, request-cookie=${action.requestCookieCaptured ? 'yes' : 'no'}${action.requestCookieSource ? `, source=${action.requestCookieSource}` : ''}${action.requestCookieFallback ? `, fallback=${action.requestCookieFallback}` : ''})`);
  }
  if (result.actions?.clearLogin) {
    console.log(`[grab-account] close-login: ok (cookies=${result.actions.clearLogin.clearedCookies})`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const result = await grabDolaAccount(options);
  printResult(result);
} catch (error) {
  console.error(`[grab-account] failed: ${error.message}`);
  console.error('If login or QR code is required, run: node grab-account.mjs --visible --keep-open');
  process.exit(1);
}