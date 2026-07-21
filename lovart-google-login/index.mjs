#!/usr/bin/env node

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const LOVART_ORIGIN = 'https://www.lovart.ai';
const LOVART_ALT_ORIGIN = 'https://lovart.ai';
const LOVART_START_URL = `${LOVART_ORIGIN}/zh`;

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const STEALTH_JS = `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });
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
})();
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 24000 + crypto.randomInt(1000, 9000);
}

function emitStep(onStep, step, data = {}) {
  try { onStep(step, data); } catch {}
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

async function cdpPage(port, targetHost = 'lovart.ai') {
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  const normalPages = pages.filter((page) => {
    const url = page.url || '';
    return page.type === 'page' && !/^(chrome-extension|devtools|chrome):/.test(url);
  });
  return normalPages.find((page) => {
    try {
      return new URL(page.url || '').hostname.endsWith(targetHost) || page.url?.includes('accounts.google.com');
    } catch {
      return page.url?.includes('accounts.google.com');
    }
  }) || normalPages[0] || pages.find((page) => page.type === 'page') || pages[0];
}

async function waitForGooglePageTarget(send, targetHost, timeoutMs = 15000, includeTargetPage = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await send('Target.getTargets');
    const pageTargets = (targets.targetInfos || []).filter((info) => info.type === 'page');
    const googleTarget = pageTargets.find((info) => {
      try {
        return new URL(info.url || '').hostname.includes('accounts.google.com');
      } catch {
        return false;
      }
    });
    const targetPage = includeTargetPage && pageTargets.find((info) => {
      try {
        const url = new URL(info.url || '');
        return isTargetHost(info.url, targetHost) && !/^\/login(?:[/?#]|$)/.test(url.pathname);
      } catch {
        return false;
      }
    });
    const target = includeTargetPage ? (targetPage || googleTarget) : (googleTarget || targetPage);
    if (target) {
      const attached = await send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      const sessionId = attached.sessionId;
      return (method, params = {}) => send(method, params, sessionId);
    }
    await sleep(300);
  }
  return null;
}

async function prepareAttachedPageSession(send) {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
  await evaluateJs(send, STEALTH_JS, { toleratePageException: true });
}

function createResilientPageSender(browserSend, targetHost, initialSend) {
  let activeSend = initialSend;
  return async (method, params = {}) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await activeSend(method, params);
      } catch (error) {
        lastError = error;
        const message = error?.message || String(error);
        if (!/Session with given id not found|Target .*closed|Inspected target navigated/.test(message)) {
          throw error;
        }
        const refreshedSend = await waitForGooglePageTarget(browserSend, targetHost, 10000, true);
        if (!refreshedSend) break;
        try {
          await prepareAttachedPageSession(refreshedSend);
          activeSend = refreshedSend;
        } catch (refreshError) {
          lastError = refreshError;
          await sleep(500);
        }
      }
    }
    throw lastError;
  };
}

async function withPageSocket(page, work, timeoutMs = 240000) {
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

    const send = (method, params = {}, sessionId = undefined) => {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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

async function evaluateJs(send, expression, options = {}) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    if (options.toleratePageException) return undefined;
    const exceptionType = String(result.exceptionDetails.exception?.className || 'Error')
      .replace(/[^A-Za-z]/g, '') || 'Error';
    const line = Number.isInteger(result.exceptionDetails.lineNumber)
      ? result.exceptionDetails.lineNumber
      : -1;
    const column = Number.isInteger(result.exceptionDetails.columnNumber)
      ? result.exceptionDetails.columnNumber
      : -1;
    throw new Error(`browser_page_script_failed:${exceptionType}@${line}:${column}`);
  }
  return result.result?.value;
}

async function evaluateJson(send, expression, fallback = null) {
  const value = await evaluateJs(send, expression);
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function waitForReadyState(send, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readyState = await evaluateJs(send, 'document.readyState');
    if (readyState === 'interactive' || readyState === 'complete') return true;
    await sleep(500);
  }
  return false;
}

async function clickElement(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(60 + Math.random() * 90);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40 + Math.random() * 60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function typeText(send, text, delayBase = 70) {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char });
    await sleep(delayBase + Math.random() * 50);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
  }
}

async function insertText(send, text) {
  await send('Input.insertText', { text });
}

async function pressEnter(send) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(40);
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

function normalizeCookie(cookies) {
  return cookies
    .filter((cookie) => cookie.name && typeof cookie.value === 'string')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function normalizeLovartCookie(cookies) {
  return normalizeCookie((cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'lovart.ai' || domain.endsWith('.lovart.ai');
  }));
}

function publicCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
}

const LOGIN_TOKEN_FIELDS = ['usertoken', 'userToken', 'user_token', 'accessToken', 'access_token', 'wizstar-token'];
const REFRESH_TOKEN_FIELDS = ['refreshToken', 'refresh_token'];
const USER_UUID_FIELDS = ['useruuid', 'userUuid', 'user_uuid', 'uuid'];

function normalizeFieldName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function jsonish(value) {
  const text = String(value || '').trim();
  if (!text || !['{', '['].includes(text[0])) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function* walkNamedValues(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkNamedValues(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield [key, item];
      yield* walkNamedValues(item);
    }
    return;
  }
  if (typeof value === 'string') {
    const parsed = jsonish(value);
    if (parsed) yield* walkNamedValues(parsed);
  }
}

function hasNamedValue(state, fieldNames) {
  const wanted = new Set(fieldNames.map(normalizeFieldName));
  for (const cookie of state.cookies || []) {
    if (wanted.has(normalizeFieldName(cookie?.name)) && String(cookie?.value || '').trim()) return true;
  }
  for (const root of [state.local_storage, state.session_storage, state.indexed_db]) {
    if (!root || typeof root !== 'object') continue;
    for (const [key, value] of walkNamedValues(root)) {
      if (wanted.has(normalizeFieldName(key)) && String(value || '').trim()) return true;
    }
  }
  return false;
}

function loginSummary(state) {
  return {
    hasUserToken: hasNamedValue(state, LOGIN_TOKEN_FIELDS),
    hasRefreshToken: hasNamedValue(state, REFRESH_TOKEN_FIELDS),
    hasUserUuid: hasNamedValue(state, USER_UUID_FIELDS),
    cookieCount: Array.isArray(state.cookies) ? state.cookies.length : 0,
    localStorageCount: state.local_storage && typeof state.local_storage === 'object' ? Object.keys(state.local_storage).length : 0,
    sessionStorageCount: state.session_storage && typeof state.session_storage === 'object' ? Object.keys(state.session_storage).length : 0,
    indexedDbCount: Array.isArray(state.indexed_db) ? state.indexed_db.length : 0,
  };
}

async function startLovartGoogleOAuth(
  send,
  onStep,
  startUrl,
  targetHost = 'lovart.ai',
  profilePrefix = 'lovart',
  siteName = 'Lovart',
) {
  emitStep(onStep, `opening_${profilePrefix}`, { url: startUrl });
  await send('Page.navigate', { url: startUrl });
  await waitForReadyState(send, 30000);
  await sleep(2500);

  const deadline = Date.now() + 70000;
  let turnstileReported = false;

  while (Date.now() < deadline) {
    const targetSend = await waitForGooglePageTarget(send, targetHost, 300);
    if (targetSend) {
      emitStep(onStep, 'google_oauth_opened', { target: 'new-page' });
      return targetSend;
    }
    const url = await evaluateJs(send, 'location.href');
    if (/accounts\.google\.com/.test(url || '')) {
      emitStep(onStep, 'google_oauth_opened', { url });
      return send;
    }

    const result = await evaluateJson(send, `(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (el) => [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.alt]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const clickCandidate = (el) => {
        const target = el.closest('button,a,[role="button"],[role="link"]') || el;
        target.click();
      };
      const clickables = [...document.querySelectorAll('button,a,[role="button"],[role="link"]')].filter(visible);
      const termsText = (document.body?.innerText || '').toLowerCase();
      if (/terms of service|privacy policy|我已阅读|服务条款|隐私政策/.test(termsText)) {
        const checkbox = [...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')]
          .find((el) => visible(el) && (el.type !== 'checkbox' || !el.checked) && el.getAttribute('aria-checked') !== 'true');
        if (checkbox) {
          const target = checkbox.closest('label') || checkbox;
          target.click();
          return JSON.stringify({ action: 'terms', text: textOf(target) });
        }
      }
      const googleNeedles = ['google', '使用 google', '继续使用 google', 'continue with google', 'sign in with google', 'log in with google'];
      for (const el of clickables) {
        const text = textOf(el);
        const lower = text.toLowerCase();
        if (googleNeedles.some((needle) => lower.includes(needle))) {
          clickCandidate(el);
          return JSON.stringify({ action: 'google', text });
        }
      }
      const googleAssets = [...document.querySelectorAll('img,svg')].filter(visible).filter((el) => {
        const text = textOf(el).toLowerCase();
        const src = el.getAttribute('src') || '';
        return text.includes('google') || /google/i.test(src);
      });
      for (const asset of googleAssets) {
        const parent = asset.closest('button,a,[role="button"],[role="link"],div');
        if (parent && visible(parent)) {
          clickCandidate(parent);
          return JSON.stringify({ action: 'google_asset', text: textOf(parent).slice(0, 120) });
        }
      }
      const loginNeedles = ['登录', '登入', 'login', 'log in', 'sign in', 'sign up', 'get started', '开始使用', '免费开始'];
      for (const el of clickables) {
        const text = textOf(el);
        const lower = text.toLowerCase();
        if (loginNeedles.some((needle) => lower === needle || lower.includes(needle))) {
          clickCandidate(el);
          return JSON.stringify({ action: 'login', text });
        }
      }
      const turnstile = [...document.querySelectorAll('iframe')].some((frame) => /challenges\.cloudflare\.com|turnstile/i.test(frame.src || ''));
      return JSON.stringify({
        action: null,
        turnstile,
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 500),
      });
    })()`, {});

    if (result?.turnstile && !turnstileReported) {
      turnstileReported = true;
      emitStep(onStep, `${profilePrefix}_turnstile_present`, {});
    }
    if (result?.action) {
      emitStep(onStep, `${profilePrefix}_${result.action}_clicked`, { text: result.text || '' });
      await sleep(result.action === 'login' ? 1800 : 3000);
      continue;
    }

    await sleep(1000);
  }

  const diagnostic = await evaluateJson(send, `(() => JSON.stringify({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 800),
    turnstile: [...document.querySelectorAll('iframe')].some((frame) => /challenges\.cloudflare\.com|turnstile/i.test(frame.src || '')),
  }))()`, {});
  if (diagnostic?.turnstile) throw new Error(`${profilePrefix}_turnstile_required`);
  throw new Error(`${siteName} Google login entry not found. URL: ${diagnostic?.url || ''}. Text: ${(diagnostic?.text || '').slice(0, 200)}`);
}

async function inspectAuthPage(send) {
  return await evaluateJson(send, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const inputs = [...document.querySelectorAll('input')];
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const inputSummary = inputs
      .filter(visible)
      .map((input) => ({
        type: input.type || '',
        name: input.name || '',
        id: input.id || '',
        autocomplete: input.autocomplete || '',
        ariaLabel: input.getAttribute('aria-label') || '',
      }))
      .slice(0, 10);
    const passwordRoute = location.pathname === '/challenge/pwd' || location.pathname.startsWith('/challenge/pwd/');
    const hasEmailInput = inputs.some((input) => visible(input) && (
      input.id === 'identifierId' || input.name === 'identifier' || input.type === 'email' || /email|邮箱/i.test(input.getAttribute('aria-label') || '')
    ));
    const hasPasswordInput = inputs.some((input) => visible(input) && (
      input.type === 'password' || input.name === 'Passwd' || input.name === 'password' || input.autocomplete === 'current-password' || /password|密码/i.test(input.getAttribute('aria-label') || '')
    ));
    const captchaInput = inputs.some((input) => visible(input) && /captcha|验证码|听到|看到|characters/i.test(input.getAttribute('aria-label') || ''));
    const captchaFrame = [...document.querySelectorAll('iframe')].some((frame) => visible(frame) && /recaptcha|captcha|challenge/i.test(frame.src || ''));
    const captchaImg = [...document.querySelectorAll('img')].some((img) => visible(img) && /captcha|challenge/i.test([img.src, img.alt].join(' ')));
    const accountChooser = /accountchooser/.test(location.href) || /use another account|使用其他账号|使用另一个账号|选择帐号|选择账号/i.test(text);
    return JSON.stringify({
      url: location.href,
      title: document.title,
      text: text.slice(0, 1000),
      hasEmailInput: passwordRoute ? false : hasEmailInput,
      hasPasswordInput,
      passwordRoute,
      inputs: inputSummary,
      hasCaptcha: captchaInput || captchaFrame || captchaImg || /captcha|验证码|verify.*human|确认.*不是机器人|请输入您看到或听到的字符/i.test(text),
      deletedAccount: /账号已被删除|帐号已被删除|account (has been|was) deleted|this account was deleted|此账号不存在|此帐号不存在/i.test(text),
      wrongPassword: /密码错误|wrong password|couldn.t verify|无法验证|try again/i.test(text),
      unknownError: /unknownerror/.test(location.href) || /unknownerror|出了点问题|something went wrong/i.test(lower),
      accountChooser,
    });
  })()`, {});
}

async function clickGoogleNext(send) {
  const clicked = await evaluateJs(send, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const selectors = ['#identifierNext', '#passwordNext'];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (visible(el)) {
        (el.querySelector('button,[role="button"]') || el).click();
        return true;
      }
    }
    const nextTexts = ['下一步', 'next'];
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter((button) => {
      const text = (button.innerText || button.textContent || '').trim().toLowerCase();
      return visible(button) && !button.disabled && nextTexts.includes(text);
    });
    if (buttons.length) {
      buttons[0].click();
      return true;
    }
    const material = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter(visible);
    if (material.length) {
      material[0].click();
      return true;
    }
    return false;
  })()`);
  if (!clicked) await pressEnter(send);
  return true;
}

async function fillEmail(send, email, onStep) {
  const inputSelector = '#identifierId, input[type="email"], input[name="identifier"], input[aria-label*="邮箱"], input[aria-label*="email" i]';
  emitStep(onStep, 'inputting_email', { length: email.length });

  const setWithNativeSetter = await evaluateJson(send, `(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    if (!input || input.offsetWidth === 0 || input.offsetHeight === 0) return JSON.stringify({ found: false, verified: false });
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return JSON.stringify({ found: true, verified: false });
    setter.call(input, '');
    setter.call(input, ${JSON.stringify(email)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const rect = input.getBoundingClientRect();
    return JSON.stringify({
      found: true,
      verified: input.value === ${JSON.stringify(email)},
      length: input.value.length,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
  })()`, { found: false, verified: false });

  if (!setWithNativeSetter.found) throw new Error('google_email_input_not_found');
  let verified = setWithNativeSetter.verified;

  if (!verified) {
    emitStep(onStep, 'email_retry_inserttext', {});
    await clickElement(send, setWithNativeSetter.x, setWithNativeSetter.y);
    await evaluateJs(send, `(() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, '');
      else input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })()`);
    await insertText(send, email);
    await sleep(500);
    verified = await evaluateJs(send, `document.querySelector(${JSON.stringify(inputSelector)})?.value === ${JSON.stringify(email)}`);
  }

  if (!verified) {
    emitStep(onStep, 'email_retry_typing', {});
    await clickElement(send, setWithNativeSetter.x, setWithNativeSetter.y);
    await evaluateJs(send, `(() => {
      const input = document.querySelector(${JSON.stringify(inputSelector)});
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, '');
      else input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })()`);
    await typeText(send, email);
    await sleep(500);
    verified = await evaluateJs(send, `document.querySelector(${JSON.stringify(inputSelector)})?.value === ${JSON.stringify(email)}`);
  }

  if (!verified) throw new Error('google_email_input_not_written');

  emitStep(onStep, 'email_input_verified', { length: email.length });
  emitStep(onStep, 'email_next', {});
  await clickGoogleNext(send);
}

async function fillPassword(send, password, onStep) {
  emitStep(onStep, 'inputting_password', {});
  const box = await evaluateJson(send, `(() => {
    const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]', 'input[aria-label*="密码"]', 'input[aria-label*="password" i]'];
    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (input && input.offsetWidth > 0 && input.offsetHeight > 0) {
        const rect = input.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      }
    }
    return null;
  })()`, null);
  if (!box) throw new Error('google_password_input_not_found');

  await clickElement(send, box.x, box.y);
  await sleep(400);

  const entered = await evaluateJs(send, `(() => {
    const selectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]', 'input[autocomplete="current-password"]', 'input[aria-label*="密码"]', 'input[aria-label*="password" i]'];
    let input = null;
    for (const selector of selectors) {
      input = document.querySelector(selector);
      if (input && input.offsetWidth > 0) break;
      input = null;
    }
    if (!input) return false;
    input.focus();
    input.value = '';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(password)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value.length > 0;
  })()`);

  if (!entered) {
    emitStep(onStep, 'password_retry_inserttext', {});
    await clickElement(send, box.x, box.y);
    await sleep(300);
    await insertText(send, password);
  }

  await sleep(500);
  emitStep(onStep, 'password_next', {});
  await clickGoogleNext(send);
}

async function handleAccountChooser(send, email, onStep) {
  const action = await evaluateJs(send, `(() => {
    const visible = (el) => el && el.offsetWidth > 0 && el.offsetHeight > 0;
    const email = ${JSON.stringify(email)};
    const items = [...document.querySelectorAll('[data-identifier], [data-email], li, div, button, [role="button"]')];
    for (const item of items) {
      const text = (item.innerText || '').trim();
      if (visible(item) && text.includes(email)) {
        item.click();
        return 'matched';
      }
    }
    const useAnotherTexts = ['use another account', '使用其他账号', '使用另一个账号', 'sign in with a different account', 'add account', '添加账号'];
    const links = [...document.querySelectorAll('a, button, [role="link"], [role="button"], div')];
    for (const link of links) {
      const text = (link.innerText || '').trim().toLowerCase();
      if (visible(link) && useAnotherTexts.some((candidate) => text.includes(candidate))) {
        link.click();
        return 'another';
      }
    }
    return '';
  })()`);
  if (action) emitStep(onStep, `account_chooser_${action}`, {});
  return !!action;
}

async function clickGoogleContinuation(send) {
  return await evaluateJson(send, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
    };
    const acceptTexts = [
      '我了解', 'i understand', 'accept', '同意', '继续', 'continue', 'next', '下一步',
      'i accept', '我同意', 'got it', 'allow', '允许', 'agree'
    ];
    const controls = [...document.querySelectorAll('button, [role="button"], a')].filter(visible);
    for (const control of controls) {
      const text = (control.innerText || control.textContent || '').trim();
      const lower = text.toLowerCase();
      if (acceptTexts.some((candidate) => lower === candidate || lower.includes(candidate))) {
        control.click();
        return JSON.stringify({ clicked: true, text });
      }
    }
    const material = [...document.querySelectorAll('div.VfPpkd-RLmnJb')].filter(visible);
    if (material.length) {
      material[0].click();
      return JSON.stringify({ clicked: true, text: 'material-button' });
    }
    return JSON.stringify({ clicked: false });
  })()`, { clicked: false });
}

function isTargetHost(url, targetHost) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const normalized = String(targetHost || '').replace(/^www\./, '').toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  } catch {
    return false;
  }
}

async function driveGoogleOAuth(send, email, password, onStep, targetHost = 'lovart.ai', timeoutMs = 190000) {
  const deadline = Date.now() + timeoutMs;
  let emailAttempts = 0;
  let passwordAttempts = 0;
  let unknownErrorRetries = 0;

  while (Date.now() < deadline) {
    const signal = await inspectAuthPage(send);
    const url = signal?.url || '';

    if (isTargetHost(url, targetHost) && !/accounts\.google\.com/.test(url)) {
      emitStep(onStep, 'lovart_redirected', { url });
      return url;
    }
    if (signal?.deletedAccount) {
      emitStep(onStep, 'google_account_deleted', { url, text: signal.text });
      throw new Error('google_account_deleted');
    }
    if (signal?.wrongPassword) {
      emitStep(onStep, 'google_password_rejected', { url, text: signal.text });
      throw new Error('google_password_rejected');
    }
    if (signal?.hasCaptcha) {
      emitStep(onStep, 'google_captcha_required', { url, text: signal.text });
      throw new Error('google_captcha_required');
    }
    if (signal?.unknownError) {
      unknownErrorRetries += 1;
      emitStep(onStep, 'google_unknownerror', { url, retry: unknownErrorRetries });
      if (unknownErrorRetries > 2) throw new Error('google_unknownerror_after_retry');
      await clickGoogleNext(send);
      await sleep(3000);
      continue;
    }
    if (signal?.accountChooser) {
      emitStep(onStep, 'handling_account_chooser', { url });
      const handled = await handleAccountChooser(send, email, onStep);
      await sleep(handled ? 3000 : 1200);
      continue;
    }
    if (signal?.hasEmailInput) {
      emailAttempts += 1;
      if (emailAttempts > 4) {
        throw new Error(`google_email_step_repeated. URL: ${url}. Text: ${(signal.text || '').slice(0, 240)}`);
      }
      await fillEmail(send, email, onStep);
      await sleep(3500);
      continue;
    }
    if (signal?.hasPasswordInput) {
      passwordAttempts += 1;
      if (passwordAttempts > 3) throw new Error('google_password_step_repeated');
      await fillPassword(send, password, onStep);
      await sleep(5000);
      continue;
    }
    if (signal?.passwordRoute) {
      emitStep(onStep, 'waiting_password_input', { url, inputs: signal.inputs || [] });
      await sleep(1200);
      continue;
    }

    const continuation = await clickGoogleContinuation(send);
    if (continuation?.clicked) {
      emitStep(onStep, 'google_continue_clicked', { text: continuation.text || '' });
      await sleep(3500);
      continue;
    }

    await sleep(1000);
  }

  const finalSignal = await inspectAuthPage(send);
  throw new Error(`google_oauth_timeout. URL: ${finalSignal?.url || ''}. Text: ${(finalSignal?.text || '').slice(0, 240)}`);
}

async function extractLovartState(send, siteOrigins = [LOVART_ORIGIN, LOVART_ALT_ORIGIN, LOVART_START_URL], targetHost = 'lovart.ai') {
  const cookieResult = await send('Network.getCookies', { urls: siteOrigins });
  const siteCookies = (cookieResult.cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return isTargetHost(`https://${domain}`, targetHost);
  });
  const cookie = normalizeCookie(siteCookies);

  const runtime = await evaluateJson(send, `(async () => {
    const dumpStorage = (storage) => {
      const result = {};
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          result[key] = storage.getItem(key);
        }
      } catch {}
      return result;
    };
    const compact = (value) => {
      try {
        const json = JSON.stringify(value);
        if (json.length > 50000) return { truncated: true, json: json.slice(0, 50000) };
        return JSON.parse(json);
      } catch {
        return String(value).slice(0, 2000);
      }
    };
    const requestToPromise = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const dumpIndexedDB = async () => {
      if (!window.indexedDB || !indexedDB.databases) return [];
      const dbInfos = await indexedDB.databases();
      const output = [];
      for (const info of dbInfos) {
        if (!info.name) continue;
        const dbEntry = { name: info.name, version: info.version, stores: {} };
        try {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          for (const storeName of Array.from(db.objectStoreNames || [])) {
            try {
              const transaction = db.transaction(storeName, 'readonly');
              const store = transaction.objectStore(storeName);
              const keys = await requestToPromise(store.getAllKeys(undefined, 100));
              const values = await requestToPromise(store.getAll(undefined, 100));
              dbEntry.stores[storeName] = { keys: compact(keys), values: compact(values) };
            } catch (error) {
              dbEntry.stores[storeName] = { error: error?.message || String(error) };
            }
          }
          db.close();
        } catch (error) {
          dbEntry.error = error?.message || String(error);
        }
        output.push(dbEntry);
      }
      return output;
    };
    return JSON.stringify({
      location: location.href,
      title: document.title,
      document_cookie: document.cookie,
      user_agent: navigator.userAgent,
      local_storage: dumpStorage(localStorage),
      session_storage: dumpStorage(sessionStorage),
      indexed_db: await dumpIndexedDB(),
    });
  })()`, {});

  return {
    cookie,
    cookies: siteCookies.map(publicCookie),
    user_agent: runtime?.user_agent || DEFAULT_UA,
    location: runtime?.location || '',
    title: runtime?.title || '',
    document_cookie: runtime?.document_cookie || '',
    local_storage: runtime?.local_storage || {},
    session_storage: runtime?.session_storage || {},
    indexed_db: runtime?.indexed_db || [],
  };
}

export async function loginLovartWithGoogle(options = {}) {
  const {
    email,
    password,
    chromePath,
    profileDir,
    port = randomPort(),
    visible = true,
    keepOpen = false,
    proxy,
    startUrl = LOVART_START_URL,
    targetOrigin = LOVART_ORIGIN,
    profilePrefix = 'lovart',
    siteName = 'Lovart',
    onStep = () => {},
  } = options;

  if (!email || !password) throw new Error('Email and password are required');

  const chrome = chromePath || findChrome();
  if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH.');

  const targetHost = new URL(targetOrigin).hostname;
  const defaultProfile = path.join(__dir, `.${profilePrefix}-profiles`, 'default');
  const profile = path.resolve(profileDir || defaultProfile);
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
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-default-apps',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=zh-CN',
    `--user-agent=${DEFAULT_UA}`,
    '--window-size=1366,900',
  ];

  if (!visible) args.push('--headless=new');
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push(startUrl);

  emitStep(onStep, 'launching_chrome', { port, visible, profile });
  const chromeProc = spawn(chrome, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 20000);
    const page = await cdpPage(port, targetHost);
    if (!page?.webSocketDebuggerUrl) throw new Error('CDP page target not found');

    const result = await withPageSocket(page, async (send) => {
      await prepareAttachedPageSession(send);
      await send('Network.setUserAgentOverride', {
        userAgent: DEFAULT_UA,
        acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        platform: 'macOS',
      });

      let authSend = await startLovartGoogleOAuth(
        send,
        onStep,
        startUrl,
        targetHost,
        profilePrefix,
        siteName,
      ) || send;
      if (authSend !== send) await prepareAttachedPageSession(authSend);
      authSend = createResilientPageSender(send, targetHost, authSend);
      const redirectUrl = await driveGoogleOAuth(authSend, email, password, onStep, targetHost);

      emitStep(onStep, `waiting_${profilePrefix}_ready`, {});
      await waitForReadyState(authSend, 30000);
      await sleep(3000);

      emitStep(onStep, 'extracting_state', {});
      const state = await extractLovartState(authSend, [targetOrigin, startUrl], targetHost);
      const summary = loginSummary(state);
      emitStep(onStep, 'login_complete', {
        location: state.location,
        ...summary,
      });
      const requiresStorageToken = profilePrefix !== 'wizstar';
      if ((requiresStorageToken && !summary.hasUserToken) || (!summary.hasUserToken && summary.cookieCount === 0)) {
        throw new Error(`${profilePrefix}_auth_state_missing_after_login`);
      }

      return { state, redirectUrl, summary };
    }, 260000);

    return {
      ...result,
      port,
      profile,
    };
  } finally {
    if (!keepOpen) {
      try {
        if (process.platform !== 'win32') process.kill(-chromeProc.pid);
        else chromeProc.kill();
      } catch {}
    }
  }
}

export async function loginWizstarWithGoogle(options = {}) {
  return loginLovartWithGoogle({
    ...options,
    startUrl: options.startUrl || 'https://wizstar.com/login',
    targetOrigin: 'https://wizstar.com',
    profilePrefix: 'wizstar',
    siteName: 'Wizstar',
  });
}

async function readStdin() {
  return await new Promise((resolve) => {
    let data = '';
    const finish = () => resolve(data.replace(/[\r\n]+$/g, ''));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        process.stdin.pause();
        finish();
      }
    });
    process.stdin.on('end', finish);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let email = '';
  let password = '';
  let passwordStdin = false;
  let visible = true;
  let keepOpen = false;
  let profile;
  let output;
  let proxy;
  let startUrl = LOVART_START_URL;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => args[++i];
    if (arg === '--email') email = next();
    else if (arg === '--password') password = next();
    else if (arg === '--password-stdin') passwordStdin = true;
    else if (arg === '--headless') visible = false;
    else if (arg === '--keep-open') keepOpen = true;
    else if (arg === '--profile') profile = next();
    else if (arg === '--output') output = next();
    else if (arg === '--proxy') proxy = next();
    else if (arg === '--start-url') startUrl = next();
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node index.mjs --email EMAIL (--password PASSWORD | --password-stdin) [--headless] [--keep-open] [--profile DIR] [--output FILE] [--proxy URL] [--start-url URL]');
      process.exit(0);
    }
  }

  if (passwordStdin) password = await readStdin();

  if (!email || !password) {
    console.error('Usage: node index.mjs --email EMAIL (--password PASSWORD | --password-stdin)');
    process.exit(1);
  }

  try {
    const result = await loginLovartWithGoogle({
      email,
      password,
      visible,
      keepOpen,
      profileDir: profile,
      proxy,
      startUrl,
      onStep: (step, data) => {
        console.log(`[lovart-login] ${step}: ${JSON.stringify(data)}`);
      },
    });
    console.log('[lovart-login] success!');
    const statePayload = {
      email,
      cookie: result.state.cookie,
      cookies: result.state.cookies,
      user_agent: result.state.user_agent,
      location: result.state.location,
      local_storage: result.state.local_storage,
      session_storage: result.state.session_storage,
      indexed_db: result.state.indexed_db,
    };
    const outputPath = path.resolve(output || path.join(result.profile, 'lovart-state.json'));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(statePayload, null, 2), 'utf8');
    console.log(`[lovart-login] cookie: ${result.state.cookie ? 'ok' : 'missing'}`);
    console.log(`[lovart-login] state_json: ${JSON.stringify({
      cookie: result.state.cookie,
      cookies: result.state.cookies,
      user_agent: result.state.user_agent,
      location: result.state.location,
      local_storage: result.state.local_storage,
      session_storage: result.state.session_storage,
      indexed_db: result.state.indexed_db,
    })}`);
    console.log(`[lovart-login] location: ${result.state.location}`);
  } catch (error) {
    console.error(`[lovart-login] failed: ${error.message}`);
    process.exit(1);
  }
}