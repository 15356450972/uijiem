#!/usr/bin/env node
/**
 * Open HappyHorse in Chrome with a saved account session (cookie + auth_token).
 * Usage:
 *   node open-account.mjs --account /tmp/hh-open-loladaisy.json
 *   node open-account.mjs --email xxx --cookie "..." --access-token "..."
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HH_ORIGIN = 'https://www.happyhorse.com';
const HH_CREATE_URL = `${HH_ORIGIN}/creation/generation`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') out.account = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--cookie') out.cookie = argv[++i];
    else if (a === '--access-token') out.accessToken = argv[++i];
    else if (a === '--device-id') out.deviceId = argv[++i];
    else if (a === '--user-agent') out.userAgent = argv[++i];
    else if (a === '--expires-at') out.expiresAt = Number(argv[++i] || 0);
    else if (a === '--url') out.url = argv[++i];
  }
  return out;
}

async function waitForJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`CDP not ready: ${last?.message || url}`);
}

async function withPageSocket(page, work, timeoutMs = 60000) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    let nextId = 1;
    const pending = new Map();
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

    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
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
        try { ws.close(); } catch {}
        reject(error);
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseCookieHeader(cookieStr) {
  return String(cookieStr || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    })
    .filter(Boolean);
}

function buildAuthTokenStorage({ accessToken, email, expiresAt, deviceId }) {
  const now = Date.now();
  const exp = Number(expiresAt || 0);
  const accessExpiresIn = exp > now ? Math.floor((exp - now) / 1000) : 7 * 24 * 3600;
  return JSON.stringify({
    state: {
      isAuthenticated: true,
      user: {
        email: email || '',
        uid: '',
      },
      tokenInfo: {
        accessToken,
        refreshToken: '',
        accessExpiresIn,
        tokenCreatedAt: now,
      },
    },
    version: 0,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let account = {};
  if (args.account) {
    account = JSON.parse(fs.readFileSync(path.resolve(args.account), 'utf8'));
  }
  const email = args.email || account.email || '';
  const cookie = args.cookie || account.cookie || '';
  const accessToken = args.accessToken || account.access_token || account.accessToken || '';
  const deviceId = args.deviceId || account.device_id || account.deviceId || '';
  const expiresAt = args.expiresAt || account.expires_at || account.expiresAt || 0;
  const targetUrl = args.url || HH_CREATE_URL;

  if (!accessToken && !cookie) {
    throw new Error('Need access token or cookie to open account browser');
  }

  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found');

  const port = 25000 + crypto.randomInt(1000, 9000);
  const profile = path.join(
    __dir,
    '.happyhorse-profiles',
    'open',
    `open-${email.replace(/[^a-zA-Z0-9._@-]/g, '_') || 'account'}-${Date.now()}`,
  );
  fs.mkdirSync(profile, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1280,900',
    'about:blank',
  ];

  console.log(`[open-account] launching Chrome for ${email || '(unknown)'}`);
  console.log(`[open-account] profile=${profile}`);
  console.log(`[open-account] port=${port}`);

  const chromeProc = spawn(chrome, chromeArgs, {
    detached: true,
    stdio: 'ignore',
  });
  chromeProc.unref();

  await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  const page = (pages || []).find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error('No Chrome page found');

  await withPageSocket(page, async (send) => {
    await send('Network.enable');
    await send('Page.enable');
    await send('Runtime.enable');

    const cookies = parseCookieHeader(cookie);
    for (const c of cookies) {
      try {
        await send('Network.setCookie', {
          name: c.name,
          value: c.value,
          domain: '.happyhorse.com',
          path: '/',
          secure: true,
          httpOnly: false,
        });
      } catch {}
    }

    const authToken = buildAuthTokenStorage({ accessToken, email, expiresAt, deviceId });
    const initScript = `
(() => {
  try {
    localStorage.setItem('auth_token', ${JSON.stringify(authToken)});
    ${deviceId ? `localStorage.setItem('device_id', ${JSON.stringify(deviceId)});` : ''}
  } catch (e) {}
})();
`;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
    await send('Page.navigate', { url: targetUrl });
    await sleep(2500);

    // Ensure storage is present after navigation as well
    await send('Runtime.evaluate', {
      expression: `
(() => {
  localStorage.setItem('auth_token', ${JSON.stringify(authToken)});
  ${deviceId ? `localStorage.setItem('device_id', ${JSON.stringify(deviceId)});` : ''}
  return {
    href: location.href,
    hasAuth: !!localStorage.getItem('auth_token'),
    cookieLen: (document.cookie || '').length,
  };
})()
`,
      returnByValue: true,
      awaitPromise: true,
    }).then(async (result) => {
      console.log('[open-account] page state:', result.result?.value || result);
      // Soft reload so app reads auth_token
      await send('Page.reload', { ignoreCache: false });
    });
  });

  console.log(`[open-account] opened ${targetUrl}`);
  console.log(`[open-account] Chrome left running (pid=${chromeProc.pid}). Close the window when done.`);
}

main().catch((err) => {
  console.error('[open-account] failed:', err.message || err);
  process.exit(1);
});
