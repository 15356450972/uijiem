import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const DOLA_CHAT_URL = 'https://www.dola.com/chat';
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
];

export function defaultGrabPaths(baseDir) {
  return {
    envFile: path.resolve(baseDir, '.env.dola'),
    profileDir: path.resolve(baseDir, '.doubao_browsers', 'dola-account-profile'),
  };
}

export function findChrome() {
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
  throw new Error(`CDP ??????: ${lastError?.message || url}`);
}

async function cdpPage(port) {
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  return pages.find((page) => page.url?.includes('dola.com')) || pages[0];
}

async function withPageSocket(page, work, timeoutMs = 30000) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  return new Promise((resolve, reject) => {
    let nextId = 1;
    const pending = new Map();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP WebSocket ???'));
    }, timeoutMs);

    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (!message.id || !pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message || JSON.stringify(message.error)));
      else res(message.result || {});
    });

    ws.on('open', async () => {
      try {
        const result = await work(send);
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

async function triggerHelloMessage(send) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const text = '你好';
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const candidates = [
          ...document.querySelectorAll('textarea'),
          ...document.querySelectorAll('[contenteditable="true"]'),
          ...document.querySelectorAll('input[type="text"]'),
          ...document.querySelectorAll('[role="textbox"]'),
        ].filter(isVisible);
        const input = candidates[candidates.length - 1];
        if (!input) return JSON.stringify({ ok: false, reason: 'textbox_not_found', location: location.href });

        input.focus();
        if (input.isContentEditable) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } else {
          input.value = text;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const buttons = [...document.querySelectorAll('button')].filter(isVisible);
        const sendButton = buttons.find((btn) => /发送|send|提交/i.test(btn.innerText || btn.ariaLabel || btn.title || ''))
          || buttons.find((btn) => /svg|path/i.test(btn.innerHTML || '') && !btn.disabled)
          || buttons[buttons.length - 1];
        if (sendButton && !sendButton.disabled) {
          sendButton.click();
          return JSON.stringify({ ok: true, method: 'button' });
        }

        return JSON.stringify({ ok: true, method: 'keyboard' });
      })()`,
      returnByValue: true,
    });

    let parsed = {};
    try { parsed = JSON.parse(result.result?.value || '{}'); } catch {}
    if (parsed.ok) {
      if (parsed.method === 'keyboard') {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
      await sleep(3500);
      return parsed;
    }

    await sleep(1000);
  }

  throw new Error('未找到 Dola 聊天输入框，无法发送“你好”。请先在弹出的 Dola 窗口完成登录并进入聊天页后重试。');
}

async function extractFromPage(port, waitMs) {
  await sleep(waitMs);
  const page = await cdpPage(port);
  if (!page?.webSocketDebuggerUrl) throw new Error('???????????? dola ???');

  await fetch(`http://127.0.0.1:${port}/json/activate/${page.id}`).catch(() => null);

  return await withPageSocket(page, async (send) => {
    await send('Network.enable');
    await send('Page.enable').catch(() => null);
    await triggerHelloMessage(send);
    const cookieResult = await send('Network.getCookies', { urls: ['https://www.dola.com', DOLA_CHAT_URL] });
    const cookie = normalizeCookie(cookieResult.cookies || []);
    const runtime = await send('Runtime.evaluate', {
      expression: `(() => {
        const fromUrl = {};
        const entries = performance.getEntriesByType('resource').map((entry) => entry.name);
        entries.unshift(location.href);
        for (const entry of entries) {
          try {
            const url = new URL(entry);
            for (const key of ['device_id', 'web_id', 'tea_uuid', 'web_tab_id']) {
              const value = url.searchParams.get(key);
              if (value) fromUrl[key] = value;
            }
          } catch {}
        }
        return JSON.stringify({
          user_agent: navigator.userAgent,
          location: location.href,
          local_storage: Object.fromEntries(Object.entries(localStorage || {})),
          session_storage: Object.fromEntries(Object.entries(sessionStorage || {})),
          from_url: fromUrl,
        });
      })()`,
      returnByValue: true,
    });
    const pageState = JSON.parse(runtime.result?.value || '{}');
    return { cookie, pageState };
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

function buildAccountState({ cookie, pageState }) {
  const local = pageState.local_storage || {};
  const session = pageState.session_storage || {};
  const fromUrl = pageState.from_url || {};
  const cookieFp = cookieValue(cookie, 's_v_web_id');
  const webId = firstValue(fromUrl.web_id, extractStorageValue(local, ['web_id']), extractStorageValue(session, ['web_id']), cookieFp);
  const teaUuid = firstValue(fromUrl.tea_uuid, extractStorageValue(local, ['tea_uuid']), extractStorageValue(session, ['tea_uuid']), webId);
  const deviceId = firstValue(fromUrl.device_id, extractStorageValue(local, ['device_id']), extractStorageValue(session, ['device_id']), webId, teaUuid, cookieFp);
  const fp = firstValue(cookieFp, extractStorageValue(local, ['s_v_web_id', 'fp']), extractStorageValue(session, ['s_v_web_id', 'fp']), webId, teaUuid, deviceId);

  return {
    cookie,
    user_agent: firstValue(pageState.user_agent, DEFAULT_UA),
    device_id: deviceId,
    web_id: webId,
    tea_uuid: teaUuid,
    web_tab_id: firstValue(fromUrl.web_tab_id, extractStorageValue(session, ['web_tab_id']), extractStorageValue(local, ['web_tab_id'])),
    fp,
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

export function writeDolaEnv(envFile, state) {
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

export async function grabDolaAccount(options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const defaults = defaultGrabPaths(baseDir);
  const chromePath = options.chromePath || findChrome();
  if (!chromePath) throw new Error('????? Chrome???????? CHROME_PATH ??? Chrome ??????????');

  const envFile = path.resolve(options.out || defaults.envFile);
  const profileDir = path.resolve(options.profile || defaults.profileDir);
  const port = options.port || randomPort();
  const visible = options.visible !== false && !options.headless;
  const waitMs = Number(options.waitMs || 8000);

  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
  ];
  if (!visible) args.push('--headless=new', '--disable-gpu');
  if (options.proxy) args.push(`--proxy-server=${options.proxy}`);
  args.push(DOLA_CHAT_URL);

  const chrome = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  chrome.unref();

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
    const raw = await extractFromPage(port, waitMs);
    const state = buildAccountState(raw);
    const missing = validateAccount(state);
    if (missing.length) {
      throw new Error(`grab incomplete: ${missing.join(', ')}. Please log in to dola and rerun with --visible.`);
    }
    const written = writeDolaEnv(envFile, state);
    return { state, envFile, profileDir, port, written };
  } finally {
    if (!options.keepOpen) {
      try { process.kill(-chrome.pid); } catch {}
      try { chrome.kill(); } catch {}
    }
  }
}