#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DOLA_ORIGIN = 'https://www.dola.com';
const DOLA_CHAT_URL = `${DOLA_ORIGIN}/chat`;
const DOLA_CREATE_IMAGE_URL = `${DOLA_CHAT_URL}/create-image`;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mp4SampleCodecs(filePath) {
  const data = fs.readFileSync(filePath);
  const codecs = [];
  const children = function* (start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = data.readUInt32BE(pos);
      const type = data.subarray(pos + 4, pos + 8).toString('latin1');
      let headerSize = 8;
      if (size === 1 && pos + 16 <= end) {
        size = Number(data.readBigUInt64BE(pos + 8));
        headerSize = 16;
      }
      if (size === 0) size = end - pos;
      if (size < 8 || pos + size > end) break;
      yield { pos, size, type, headerSize };
      pos += size;
    }
  };
  const walk = (start, end) => {
    for (const box of children(start, end)) {
      if (box.type === 'stsd') {
        const entryOffset = box.pos + box.headerSize + 8;
        if (entryOffset + 8 <= box.pos + box.size) {
          codecs.push(data.subarray(entryOffset + 4, entryOffset + 8).toString('latin1'));
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) {
        walk(box.pos + box.headerSize, box.pos + box.size);
      } else if (box.type === 'stsd') {
        walk(box.pos + box.headerSize + 8, box.pos + box.size);
      }
    }
  };
  walk(0, data.length);
  return codecs;
}

function makePlayableVideoIfNeeded(filePath) {
  const sourcePath = path.resolve(filePath || '');
  if (!sourcePath || !fs.existsSync(sourcePath)) return sourcePath;
  let codecs = [];
  try {
    codecs = mp4SampleCodecs(sourcePath);
  } catch (error) {
    console.warn(`[video] codec inspect failed: ${error.message}`);
    return sourcePath;
  }
  const needsTranscode = codecs.some((codec) => codec === 'hvc1' || codec === 'hev1');
  if (!needsTranscode) return sourcePath;
  const parsed = path.parse(sourcePath);
  const playablePath = path.join(parsed.dir, `${parsed.name}.playable${parsed.ext || '.mp4'}`);
  if (fs.existsSync(playablePath) && fs.statSync(playablePath).size > 0) {
    const sourceStat = fs.statSync(sourcePath);
    const playableStat = fs.statSync(playablePath);
    if (playableStat.mtimeMs >= sourceStat.mtimeMs) return playablePath;
  }
  const playablePreset = process.env.DOLA_PLAYABLE_PRESET || 'Preset640x480';
  const avconvert = spawnSync('avconvert', [
    '--source', sourcePath,
    '--preset', playablePreset,
    '--output', playablePath,
    '--replace',
  ], { encoding: 'utf8' });
  if (avconvert.status !== 0 || !fs.existsSync(playablePath)) {
    console.warn(`[video] playable transcode failed: ${avconvert.stderr || avconvert.stdout || `exit ${avconvert.status}`}`);
    return sourcePath;
  }
  console.log(`可播放副本: ${playablePath}`);
  return playablePath;
}

function ensureVideoPrompt(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error('empty prompt');
  return normalized;
}


function randomPort() {
  return 22000 + Math.floor(Math.random() * 5000);
}

function extractConversationIdFromLocation(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/chat\/(\d{6,})/);
  return match?.[1] || '';
}


function extractConversationIdFromSummary(summary = {}) {
  const location = summary?.detail?.location || summary?.result?.detail?.location || summary?.pageUrl || '';
  const fromLocation = extractConversationIdFromLocation(location);
  if (fromLocation) return fromLocation;

  const completions = Array.isArray(summary?.networkEvidence?.completions)
    ? summary.networkEvidence.completions
    : Array.isArray(summary?.result?.networkEvidence?.completions)
      ? summary.result.networkEvidence.completions
      : [];

  for (const item of [...completions].reverse()) {
    if (item?.conversation_id) return String(item.conversation_id).trim();
    if (item?.conversationId) return String(item.conversationId).trim();
  }

  return '';
}

function extractLocalConversationIdFromSummary(summary = {}) {
  const completions = Array.isArray(summary?.networkEvidence?.completions)
    ? summary.networkEvidence.completions
    : Array.isArray(summary?.result?.networkEvidence?.completions)
      ? summary.result.networkEvidence.completions
      : [];

  for (const item of [...completions].reverse()) {
    if (item?.local_conversation_id) return String(item.local_conversation_id).trim();
  }
  return '';
}

function defaultProfileDir(baseDir) {
  return path.resolve(baseDir, '.doubao_browsers', 'dola-send-profile');
}

function copyProfileSnapshot(sourceDir, targetDir) {
  const skipNames = new Set([
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'lockfile',
    'DevToolsActivePort',
    'BrowserMetrics',
    'Crashpad',
    'Crash Reports',
    'ShaderCache',
    'GrShaderCache',
    'DawnCache',
    'Code Cache',
    'GPUCache',
    'Cache',
    'Sessions',
    'Session Restore',
    'Session Storage',
    'Current Session',
    'Current Tabs',
    'Last Session',
    'RunningChromeVersion',
    'Tabs',
  ]);

  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (entryPath) => {
      const baseName = path.basename(entryPath);
      if (skipNames.has(baseName)) return false;
      return !baseName.endsWith('.lock');
    },
  });
}

function createTemporaryProfileDir(baseDir, sourceDir) {
  const tempRoot = path.resolve(baseDir, '.doubao_browsers', '.tmp_profiles');
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = path.join(
    tempRoot,
    `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tempDir, { recursive: true });
  if (sourceDir && fs.existsSync(sourceDir)) {
    copyProfileSnapshot(sourceDir, tempDir);
  }
  return tempDir;
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

function defaultExtensionDir() {
  return process.env.DOLA_EXTENSION_DIR || '';
}

function resolveExtensionDir(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const absPath = path.resolve(raw);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Extension dir not found: ${absPath}`);
  }
  return absPath;
}

function readEnvFile(envFile) {
  const file = path.resolve(String(envFile || '').trim());
  if (!file || !fs.existsSync(file)) return {};
  const values = {};
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      return name ? { name, value } : null;
    })
    .filter(Boolean);
}

async function injectDolaCookiesIfAvailable(port, envFile, targetUrl) {
  const values = readEnvFile(envFile);
  const cookieHeader = values.DOLA_COOKIE || '';
  const cookies = parseCookieHeader(cookieHeader);
  if (!cookies.length) return { injected: false, count: 0, reason: 'missing DOLA_COOKIE' };

  const page = await activeDolaPage(port, targetUrl || DOLA_CHAT_URL);
  return await withPageSocket(page, async (send) => {
    await send('Network.enable').catch(() => null);
    let count = 0;
    for (const cookie of cookies) {
      const result = await send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: '.dola.com',
        path: '/',
        url: DOLA_ORIGIN,
        secure: true,
        httpOnly: false,
        sameSite: 'None',
      }).catch(() => ({ success: false }));
      if (result?.success !== false) count += 1;
    }
    await send('Page.enable').catch(() => null);
    await send('Page.navigate', { url: targetUrl || DOLA_CHAT_URL }).catch(() => null);
    return { injected: count > 0, count };
  }, 20000);
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

async function cdpPage(port, preferredUrl = '') {
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 15000);
  const targetUrl = String(preferredUrl || '').trim();
  const targetConversationId = extractConversationIdFromLocation(targetUrl);
  if (targetConversationId) {
    const byConversation = pages.find((page) => page.type === 'page' && page.url?.includes(`/chat/${targetConversationId}`));
    if (byConversation) return byConversation;
  }
  if (targetUrl) {
    const byUrl = pages.find((page) => page.type === 'page' && (page.url === targetUrl || page.url?.includes(targetUrl)));
    if (byUrl) return byUrl;
  }
  return pages.find((page) => page.type === 'page' && page.url?.includes('dola.com')) || pages[0];
}

async function withPageSocket(page, work, timeoutMs = 45000) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  return new Promise((resolve, reject) => {
    let nextId = 1;
    const pending = new Map();
    const events = [];
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
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message || JSON.stringify(message.error)));
        else res(message.result || {});
        return;
      }
      events.push(message);
    });

    ws.on('open', async () => {
      try {
        const result = await work(send, events);
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

async function activeDolaPage(port, preferredUrl = '') {
  const page = await cdpPage(port, preferredUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error('No connectable dola page found');
  await fetch(`http://127.0.0.1:${port}/json/activate/${page.id}`).catch(() => null);
  return page;
}

async function dismissLoginModal(send) {
  const closeViaEscape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => null);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => null);
    await sleep(250);
  };

  await closeViaEscape();

  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').replace(/\s+/g, ' ').trim();
      const click = (el) => {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const loginHints = [
        /登录以解锁更多功能|请输入手机号|验证码|扫码|微信登录|手机号登录|登录|sign in|login/i,
        /打开\s*Dola\s*App|下载\s*Dola\s*App|立即登录|继续登录|扫码登录/i,
        /Cookie 政策|使用 Cookie|同意我们使用自己的 Cookie|必要的服务和安全措施|我知道了|接受 Cookie/i,
      ];
      const dismissHints = /关闭|取消|稍后|以后再说|暂不|跳过|我知道了|知道了|继续浏览|关闭弹窗|close|dismiss|not now|skip|x|同意|接受/i;
      const visibleNodes = [...document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popup"], [class*="dialog"], [class*="login"], [class*="signin"], [class*="auth"], section, aside, div')]
        .filter(isVisible);

      const candidate = visibleNodes.find((node) => loginHints.some((re) => re.test(textOf(node))));
      if (!candidate) {
        return JSON.stringify({ found: false, closed: false });
      }

      const scoped = [...candidate.querySelectorAll('button, [role="button"], a, svg, [aria-label], [title], [class*="close"], [class*="dismiss"], [class*="cancel"]')]
        .filter(isVisible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = [textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.className || '']
            .filter(Boolean).join(' ').trim();
          const explicitDismiss = dismissHints.test(label);
          const topRight = rect.top < window.innerHeight * 0.45 && rect.left > window.innerWidth * 0.45;
          const smallIcon = rect.width >= 8 && rect.height >= 8 && rect.width <= 72 && rect.height <= 72;
          return { el, rect, label, explicitDismiss, topRight, smallIcon };
        })
        .filter((item) => item.explicitDismiss || (item.topRight && item.smallIcon))
        .sort((a, b) => {
          const score = (item) => (item.explicitDismiss ? 0 : 30) + Math.abs(item.rect.right - window.innerWidth) + item.rect.top;
          return score(a) - score(b);
        });

      const global = [...document.querySelectorAll('button, [role="button"], a, svg, [aria-label], [title], [class*="close"], [class*="dismiss"], [class*="cancel"]')]
        .filter(isVisible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = [textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.className || '']
            .filter(Boolean).join(' ').trim();
          const explicitDismiss = dismissHints.test(label);
          const topRight = rect.top < window.innerHeight * 0.45 && rect.left > window.innerWidth * 0.45;
          const smallIcon = rect.width >= 8 && rect.height >= 8 && rect.width <= 72 && rect.height <= 72;
          return { el, rect, label, explicitDismiss, topRight, smallIcon };
        })
        .filter((item) => item.explicitDismiss || (item.topRight && item.smallIcon))
        .sort((a, b) => {
          const score = (item) => (item.explicitDismiss ? 0 : 30) + Math.abs(item.rect.right - window.innerWidth) + item.rect.top;
          return score(a) - score(b);
        });

      const target = scoped[0]?.el || global[0]?.el;
      if (!target) return JSON.stringify({ found: true, closed: false, method: 'escape-only' });
      click(target);
      return JSON.stringify({ found: true, closed: true, method: scoped[0] ? 'scoped-click' : 'global-click', label: (scoped[0]?.label || global[0]?.label || '').slice(0, 120) });
    })()`,
    returnByValue: true,
  });

  try { return JSON.parse(result.result?.value || '{}'); }
  catch { return {}; }
}

async function dismissBlockingOverlays(send, timeoutMs = 6000) {
  const startedAt = Date.now();
  const attempts = [];
  while (Date.now() - startedAt < timeoutMs) {
    const directResult = await send('Runtime.evaluate', {
      expression: `(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
        const click = (el) => {
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        };
        const bodyText = document.body?.innerText || '';
        const blockingHints = /Cookie 政策|使用 Cookie|同意我们使用自己的 Cookie|必要的服务和安全措施|我知道了|Log In to Unlock|Scan QR code with Dola App|登录以解锁|扫码登录|手机号登录/i;
        const dismissHints = /^(我知道了|知道了|同意|接受|接受 Cookie|继续浏览|跳过|稍后|暂不|关闭|取消|close|dismiss|not now|skip|x)$/i;
        const broadDismissHints = /我知道了|知道了|同意|接受|继续浏览|跳过|稍后|暂不|关闭|取消|close|dismiss|not now|skip/i;
        const modalRoots = [...document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popup"], [class*="dialog"]')]
          .filter(isVisible)
          .filter((el) => blockingHints.test(textOf(el)) || /modal|popup|dialog/i.test(String(el.className || '')));
        const searchRoots = modalRoots.length ? modalRoots : [document.body];
        const rawCandidates = searchRoots.flatMap((root) => [...root.querySelectorAll('button, [role="button"], a, label, div, span, [aria-label], [title], [class*="close"], [class*="dismiss"], [class*="cancel"]')]);
        const candidates = [...new Set(rawCandidates)]
          .filter(isVisible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = textOf(el);
            const label = [text, el.getAttribute('aria-label') || '', el.getAttribute('title') || '', String(el.className || '')].join(' ').replace(/\s+/g, ' ').trim();
            const compact = rect.width <= 260 && rect.height <= 120;
            const smallIcon = rect.width >= 8 && rect.height >= 8 && rect.width <= 72 && rect.height <= 72;
            const exactClose = /^(close|关闭|x)$/i.test(label) || /close/i.test(el.getAttribute('aria-label') || '') || /close/i.test(String(el.className || ''));
            const buttonLike = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A' || el.tabIndex >= 0 || el.onclick;
            return { el, text, label, compact, smallIcon, exactClose, buttonLike, rect };
          })
          .filter((item) => {
            if (item.exactClose && item.smallIcon) return true;
            if (dismissHints.test(item.text) || dismissHints.test(item.label)) return true;
            if (item.compact && broadDismissHints.test(item.label)) return true;
            return false;
          })
          .sort((a, b) => {
            const score = (item) => (item.exactClose && item.smallIcon ? -3000 : 0)
              + (dismissHints.test(item.text) || dismissHints.test(item.label) ? -1000 : 0)
              + (item.buttonLike ? -300 : 0)
              + (item.compact ? -200 : 400)
              + item.rect.top;
            return score(a) - score(b);
          });
        const target = candidates[0];
        if (target) {
          click(target.el);
        }
        return JSON.stringify({
          found: blockingHints.test(bodyText),
          closed: !!target,
          text: target?.text || '',
          label: target?.label?.slice(0, 160) || '',
          bodySnippet: bodyText.slice(0, 500),
        });
      })()`,
      returnByValue: true,
    }).catch(() => ({ result: { value: '{}' } }));

    let parsed = {};
    try { parsed = JSON.parse(directResult.result?.value || '{}'); } catch {}
    attempts.push(parsed);
    if (!parsed.found || parsed.closed) {
      await sleep(700);
    } else {
      await sleep(500);
    }

    const check = await send('Runtime.evaluate', {
      expression: `(() => {
        const bodyText = document.body?.innerText || '';
        const blocked = /Cookie 政策|使用 Cookie|同意我们使用自己的 Cookie|必要的服务和安全措施|Log In to Unlock|Scan QR code with Dola App|登录以解锁|扫码|手机号/.test(bodyText);
        return JSON.stringify({ blocked, bodySnippet: bodyText.slice(0, 500) });
      })()`,
      returnByValue: true,
    }).catch(() => ({ result: { value: '{}' } }));
    let parsedCheck = {};
    try { parsedCheck = JSON.parse(check.result?.value || '{}'); } catch {}
    if (!parsedCheck.blocked) {
      return { ok: true, attempts };
    }
  }
  return { ok: false, attempts };
}

async function selectDuration(send, durationSec) {
  const target = String(durationSec || '').trim();
  if (!target) return { ok: false, skipped: true, reason: 'empty_duration' };

  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const target = ${JSON.stringify(String(durationSec))};
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const click = (el) => {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const matchesDuration = (text) => new RegExp('(^|\\D)' + target + '\\s*(s|秒)(\\D|$)', 'i').test(text || '');
      const shortDurationText = (text) => /^(5\s*s|10\s*s|15\s*s|5秒|10秒|15秒)$|(^|\s)(5\s*s|10\s*s|15\s*s|5秒|10秒|15秒)(\s|$)/i.test(text || '');
      const scoreNode = (item) => {
        const rect = item.el.getBoundingClientRect();
        const centerPenalty = Math.abs(rect.left + rect.width / 2 - window.innerWidth * 0.5);
        const lowerHalfBonus = rect.top > window.innerHeight * 0.45 ? -120 : 0;
        return centerPenalty + rect.top + (item.text.length > 18 ? 400 : 0) + lowerHalfBonus;
      };

      const directCandidates = [...document.querySelectorAll('button, [role="button"], div, span, li')]
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((item) => item.text && shortDurationText(item.text))
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const direct = directCandidates.find((item) => matchesDuration(item.text));
      if (direct && click(direct.el)) {
        return JSON.stringify({ ok: true, mode: 'direct', text: direct.text, candidates: directCandidates.slice(0, 6).map((item) => item.text) });
      }

      const triggerCandidates = [...document.querySelectorAll('button, [role="button"], div, span')]
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((item) => item.text && item.text.length <= 16 && /(时长|秒数|duration|5\s*s|10\s*s|15\s*s|5秒|10秒|15秒)/i.test(item.text))
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const trigger = triggerCandidates[0];
      if (trigger) click(trigger.el);

      const refreshed = [...document.querySelectorAll('button, [role="button"], div, span, li')]
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((item) => item.text && shortDurationText(item.text))
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const picked = refreshed.find((item) => matchesDuration(item.text));
      if (picked && click(picked.el)) {
        return JSON.stringify({ ok: true, mode: 'opened_then_selected', text: picked.text, triggerText: trigger?.text || '', candidates: refreshed.slice(0, 6).map((item) => item.text) });
      }
      return JSON.stringify({ ok: false, reason: 'duration_option_not_found', triggerText: trigger?.text || '', candidates: refreshed.slice(0, 10).map((item) => item.text) });
    })()`,
    returnByValue: true,
  });

  try { return JSON.parse(result.result?.value || '{}'); }
  catch { return { ok: false, reason: 'duration_parse_failed' }; }
}

function buildRatioMatchers(target) {
  const raw = String(target || '').trim();
  const normalized = raw.replace(/\s+/g, '').replace(/：/g, ':');
  const aliases = new Set([raw, normalized]);
  if (normalized === '16:9') {
    aliases.add('横屏');
    aliases.add('宽屏');
  } else if (normalized === '9:16') {
    aliases.add('竖屏');
  } else if (normalized === '1:1') {
    aliases.add('方图');
    aliases.add('正方形');
  }

  return {
    raw,
    normalized,
    aliases,
    matches(text) {
      const value = String(text || '').replace(/\s+/g, '').replace(/：/g, ':');
      if (!value) return false;
      if (aliases.has(value)) return true;
      if (value.includes(normalized)) return true;
      if (normalized === '16:9' && /(横屏|宽屏)/.test(text || '')) return true;
      if (normalized === '9:16' && /竖屏/.test(text || '')) return true;
      if (normalized === '1:1' && /(方图|正方形)/.test(text || '')) return true;
      return false;
    },
  };
}

async function selectRatio(send, ratioValue) {
  const target = String(ratioValue || '').trim();
  if (!target) return { ok: false, skipped: true, reason: 'empty_ratio' };

  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const target = ${JSON.stringify(String(ratioValue))};
      const normalize = (value) => String(value || '').replace(/\s+/g, '').replace(/：/g, ':');
      const matcher = (${buildRatioMatchers.toString()})(target);
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const click = (el) => {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const scoreNode = (item) => {
        const rect = item.el.getBoundingClientRect();
        const centerPenalty = Math.abs(rect.left + rect.width / 2 - window.innerWidth * 0.5);
        const lowerHalfBonus = rect.top > window.innerHeight * 0.45 ? -120 : 0;
        return centerPenalty + rect.top + (item.text.length > 18 ? 400 : 0) + lowerHalfBonus;
      };

      const directCandidates = [...document.querySelectorAll('button, [role="button"], div, span, li')]
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((item) => item.text && matcher.matches(item.text))
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const direct = directCandidates.find((item) => matcher.matches(item.text));
      if (direct && click(direct.el)) {
        return JSON.stringify({ ok: true, mode: 'direct', text: direct.text, candidates: directCandidates.slice(0, 6).map((item) => item.text) });
      }

      const triggerCandidates = [...document.querySelectorAll('button, [role="button"], div, span')]
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((item) => item.text && item.text.length <= 16 && /(比例|画幅|ratio|aspect|横屏|竖屏|方图|正方形|16\s*[:：]\s*9|9\s*[:：]\s*16|1\s*[:：]\s*1)/i.test(item.text))
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const trigger = triggerCandidates[0];
      if (trigger) click(trigger.el);

      const refreshed = [...document.querySelectorAll('button, [role="button"], div, span, li')]
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((item) => item.text && matcher.matches(item.text))
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const picked = refreshed.find((item) => matcher.matches(item.text));
      if (picked && click(picked.el)) {
        return JSON.stringify({ ok: true, mode: 'opened_then_selected', text: picked.text, triggerText: trigger?.text || '', candidates: refreshed.slice(0, 6).map((item) => item.text) });
      }
      return JSON.stringify({ ok: false, reason: 'ratio_option_not_found', triggerText: trigger?.text || '', candidates: refreshed.slice(0, 10).map((item) => item.text) });
    })()`,
    returnByValue: true,
  });

  try { return JSON.parse(result.result?.value || '{}'); }
  catch { return { ok: false, reason: 'ratio_parse_failed' }; }
}

async function clickSendButton(send) {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null;
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const labelOf = (el) => [
        textOf(el),
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        String(el.className || ''),
        String(el.getAttribute('data-dbx-name') || ''),
      ].join(' ').trim();
      const inputs = [
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]'),
        ...document.querySelectorAll('input[type="text"]'),
        ...document.querySelectorAll('[role="textbox"]'),
        ...document.querySelectorAll('.ProseMirror'),
      ].filter((el) => isVisible(el) && !isDisabled(el));
      inputs.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const input = inputs[0];
      const inputRect = input?.getBoundingClientRect();
      const roots = [...document.querySelectorAll('button, [role="button"], .send-btn-wrapper, [class*="send"], [class*="submit"], svg')]
        .filter((el) => isVisible(el) && !isDisabled(el));
      const expanded = roots.flatMap((root) => {
        const descendants = [...root.querySelectorAll?.('button, [role="button"], svg, span, div') || []].filter(isVisible);
        return [root, ...descendants];
      });
      const unique = [...new Set(expanded)];
      const candidates = unique
        .filter((el) => isVisible(el) && !isDisabled(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const label = labelOf(el);
          const wrapper = el.closest?.('.send-btn-wrapper') || null;
          const nearInput = inputRect
            ? rect.top >= inputRect.top - 100 && rect.bottom <= inputRect.bottom + 140 && rect.left >= inputRect.left - 120
            : rect.top > window.innerHeight * 0.45;
          const rightOfInput = inputRect ? rect.left >= inputRect.right - 120 : rect.left > window.innerWidth * 0.6;
          const looksSend = /(发送|submit|send|生成|创作|arrow|paper-plane|icon-send|icon-submit|send-btn-wrapper)/i.test(label) || !!wrapper;
          const isButtonLike = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
          const compact = rect.width <= 140 && rect.height <= 140;
          return { el, rect, text, label, nearInput, rightOfInput, looksSend, compact, isButtonLike, hasWrapper: !!wrapper };
        })
        .filter((item) => item.nearInput && item.rightOfInput && item.compact && item.looksSend)
        .sort((a, b) => {
          const score = (item) => {
            const inputRight = inputRect?.right || window.innerWidth;
            return (item.hasWrapper ? -900 : 0)
              + (item.isButtonLike ? -300 : 0)
              + Math.abs(item.rect.left + item.rect.width / 2 - inputRight)
              + Math.abs(item.rect.top + item.rect.height / 2 - (inputRect?.bottom || window.innerHeight))
              + (item.text ? 20 : 0);
          };
          return score(a) - score(b);
        });
      const target = candidates[0];
      if (!target) {
        return JSON.stringify({ ok: false, reason: 'send_button_not_found', candidates: [] });
      }
      target.el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = target.el.getBoundingClientRect();
      return JSON.stringify({
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: target.text,
        label: target.label.slice(0, 160),
        isButtonLike: target.isButtonLike,
        hasWrapper: target.hasWrapper,
      });
    })()`,
    returnByValue: true,
  });

  let target;
  try { target = JSON.parse(result.result?.value || '{}'); }
  catch { return { ok: false, reason: 'send_button_parse_failed' }; }
  if (!target.ok) return target;

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  return target;
}

async function selectCreationMode(send, modeName = '视频') {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const expectedName = ${JSON.stringify(modeName)};
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const labelOf = (el) => [
        textOf(el),
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.className || '',
      ].join(' ').replace(/\s+/g, ' ').trim();
      const normalizeLabel = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const aliases = expectedName === '图像'
        ? ['图像', '图片', 'image', '图片模式', '图像模式', '图像生成', '图片生成']
        : ['视频', 'video', '视频生成', '生成视频', '视频模式'];
      const isAlias = (value) => aliases.some((alias) => normalizeLabel(value) === normalizeLabel(alias));
      const containsAlias = (value) => aliases.some((alias) => normalizeLabel(value).includes(normalizeLabel(alias)));
      const compactClickable = (el) => {
        let current = el;
        while (current && current !== document.body && current !== document.documentElement) {
          if (!isVisible(current)) {
            current = current.parentElement;
            continue;
          }
          const text = textOf(current);
          const rect = current.getBoundingClientRect();
          const clickable = current.tagName === 'BUTTON' || current.getAttribute('role') === 'button' || current.getAttribute('role') === 'tab' || current.onclick || current.tabIndex >= 0;
          const compactText = text.length <= 32;
          const compactBox = rect.width <= 260 && rect.height <= 120;
          if (clickable && compactText && compactBox) return current;
          current = current.parentElement;
        }
        return el;
      };
      const click = (el) => {
        if (!el) return false;
        const target = compactClickable(el);
        target.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = target.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2));
        const y = Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
        const actual = document.elementFromPoint(x, y) || target;
        const finalTarget = compactClickable(actual);
        finalTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        finalTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        finalTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const selectedOf = (el) => {
        const state = [
          el.getAttribute('aria-selected') || '',
          el.getAttribute('aria-pressed') || '',
          el.getAttribute('data-state') || '',
          el.getAttribute('data-active') || '',
          el.className || '',
        ].join(' ');
        return /true|active|selected|checked|current/i.test(state);
      };
      const scoreNode = (item) => {
        const rect = item.el.getBoundingClientRect();
        const exactBonus = isAlias(item.text) || isAlias(item.aria) ? -1200 : 0;
        const shortBonus = item.text.length <= 12 ? -400 : 0;
        const buttonBonus = item.buttonLike ? -250 : 0;
        const selectedBonus = item.selected ? -300 : 0;
        const hugePenalty = item.text.length > 40 ? 2000 : 0;
        const areaPenalty = Math.min(1200, (rect.width * rect.height) / 100);
        const lowerHalfPenalty = rect.top > window.innerHeight * 0.72 ? 250 : 0;
        return exactBonus + shortBonus + buttonBonus + selectedBonus + hugePenalty + areaPenalty + lowerHalfPenalty + rect.top;
      };
      const directCandidates = [...document.querySelectorAll('button, [role="button"], [role="tab"], a, div, span')]
        .filter(isVisible)
        .map((el) => {
          const text = textOf(el);
          const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
          return {
            el,
            text,
            aria,
            label: labelOf(el),
            selected: selectedOf(el),
            buttonLike: el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab',
          };
        })
        .filter((item) => {
          if (isAlias(item.text) || isAlias(item.aria)) return true;
          if (item.text.length <= 24 && containsAlias(item.text)) return true;
          if (item.aria.length <= 32 && containsAlias(item.aria)) return true;
          return false;
        });
      const textNodeCandidates = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      while (textNodeCandidates.length < 20) {
        const node = walker.nextNode();
        if (!node) break;
        const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 24 || !containsAlias(text)) continue;
        const parent = node.parentElement;
        if (!isVisible(parent)) continue;
        textNodeCandidates.push({
          el: compactClickable(parent),
          text,
          aria: '',
          label: labelOf(parent),
          selected: selectedOf(parent) || selectedOf(compactClickable(parent)),
          buttonLike: true,
        });
      }
      const candidates = [...directCandidates, ...textNodeCandidates]
        .filter((item, index, list) => list.findIndex((other) => other.el === item.el && other.text === item.text) === index)
        .sort((a, b) => scoreNode(a) - scoreNode(b));
      const target = candidates[0];
      if (!target) return JSON.stringify({ ok: false, reason: 'mode_not_found', expected: expectedName, candidates: [] });
      const clicked = click(target.el);
      return JSON.stringify({
        ok: clicked,
        text: target.text,
        label: target.label.slice(0, 160),
        selectedBeforeClick: target.selected,
        expected: expectedName,
        candidates: candidates.slice(0, 8).map((item) => item.text || item.aria || item.label.slice(0, 80)),
      });
    })()`,
    returnByValue: true,
  });

  try { return JSON.parse(result.result?.value || '{}'); }
  catch { return { ok: false, reason: 'mode_parse_failed' }; }
}

async function assertModeSelected(send, expectedName = '视频', timeoutMs = 5000) {
  const startedAt = Date.now();
  let last = { ok: false, reason: 'mode_assert_not_started' };
  while (Date.now() - startedAt < timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const expectedName = ${JSON.stringify(expectedName)};
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
        const labelOf = (el) => [textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.className || ''].join(' ').replace(/\s+/g, ' ').trim();
        const aliases = expectedName === '图像'
          ? ['图像', '图片', 'image', '图片模式', '图像模式', '图像生成', '图片生成']
          : ['视频', 'video', '视频生成', '生成视频', '视频模式'];
        const normalizeLabel = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const containsAlias = (value) => aliases.some((alias) => normalizeLabel(value) === normalizeLabel(alias) || normalizeLabel(value).includes(normalizeLabel(alias)));
        const selectedOf = (el) => {
          const state = [
            el.getAttribute('aria-selected') || '',
            el.getAttribute('aria-pressed') || '',
            el.getAttribute('data-state') || '',
            el.getAttribute('data-active') || '',
            el.className || '',
          ].join(' ');
          return /true|active|selected|checked|current/i.test(state);
        };
        const elements = [...document.querySelectorAll('button, [role="button"], [role="tab"], a, div, span')]
          .filter(isVisible)
          .map((el) => ({ el, text: textOf(el), label: labelOf(el), selected: selectedOf(el), focused: el === document.activeElement }))
          .filter((item) => item.text.length <= 32 && containsAlias(item.text || item.label));
        const active = elements.find((item) => item.selected) || elements.find((item) => item.focused) || null;
        return JSON.stringify({
          ok: !!active,
          activeText: active?.text || '',
          activeLabel: active?.label?.slice(0, 160) || '',
          candidateTexts: elements.slice(0, 8).map((item) => item.text || item.label.slice(0, 80)),
        });
      })()`,
      returnByValue: true,
    });
    last = JSON.parse(result.result?.value || '{}');
    if (last.ok) return last;
    await sleep(500);
  }
  return { ...last, ok: false, reason: 'mode_assert_timeout' };
}


async function waitForCreationModes(send, timeoutMs = 10000) {
  const startedAt = Date.now();
  let last = { ok: false, reason: 'creation_modes_not_started' };
  while (Date.now() - startedAt < timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
        const candidates = [...document.querySelectorAll('button, [role="button"], [role="tab"], a, div, span')]
          .filter(isVisible)
          .map((el) => textOf(el))
          .filter((text) => text && text.length <= 24 && /(图像生成|图片生成|视频生成|图像|图片|视频|image|video)/i.test(text));
        return JSON.stringify({ ok: candidates.length > 0, candidates: candidates.slice(0, 12) });
      })()`,
      returnByValue: true,
    });
    last = JSON.parse(result.result?.value || '{}');
    if (last.ok) return last;
    await sleep(500);
  }
  return { ...last, ok: false, reason: 'creation_modes_timeout' };
}

async function waitForUploadComplete(send, timeoutMs = 15000) {
  const startedAt = Date.now();
  let last = { ok: false, reason: 'upload_complete_not_started' };
  while (Date.now() - startedAt < timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const bodyText = document.body?.innerText || '';
        const lines = bodyText.split(String.fromCharCode(10));
        const hasProgress = lines.some((line) => /^\\d{1,3}%$/.test(line.trim()));
        const hasUploadTokens = ['参考图', 'Reference Image', '上传图片', 'Upload Image', 'Upload', 'Image', '上传图', '重新上传', 'Replace', '替换', '已上传', '图片']
          .some((token) => bodyText.includes(token));
        return JSON.stringify({
          ok: !hasProgress && hasUploadTokens,
          hasProgress,
          hasUploadTokens,
          bodySnippet: bodyText.slice(-600),
        });
      })()`,
      returnByValue: true,
    });
    last = JSON.parse(result.result?.value || '{}');
    if (last.ok) return last;
    await sleep(800);
  }
  return { ...last, ok: false, reason: 'upload_complete_timeout' };
}

async function waitForUploadReady(send, timeoutMs = 12000) {
  const startedAt = Date.now();
  let last = { ok: false, reason: 'upload_ready_not_started' };
  while (Date.now() - startedAt < timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const bodyText = document.body?.innerText || '';
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        const visibleFileInputs = fileInputs.filter(isVisible);
        const uploadTokens = ['参考图', 'Reference Image', '上传图片', 'Upload Image', 'Upload', 'Image', '上传图', '重新上传', 'Replace', '替换', '已上传', '图片'];
        const hasUploadHint = uploadTokens.some((token) => bodyText.includes(token));
        const hasFileInput = fileInputs.length > 0;
        return JSON.stringify({
          ok: hasUploadHint || hasFileInput,
          hasUploadHint,
          hasFileInput,
          fileInputCount: fileInputs.length,
          visibleFileInputCount: visibleFileInputs.length,
          bodySnippet: bodyText.slice(-600),
        });
      })()`,
      returnByValue: true,
    });
    last = JSON.parse(result.result?.value || '{}');
    if (last.ok) return last;
    await sleep(500);
  }
  return { ...last, ok: false, reason: 'upload_ready_timeout' };
}

async function uploadReferenceImages(send, imageFiles) {
  const rawPaths = Array.isArray(imageFiles)
    ? imageFiles.map((item) => String(item || '').trim()).filter(Boolean)
    : [String(imageFiles || '').trim()].filter(Boolean);
  if (!rawPaths.length) return { skipped: true, reason: 'empty_image_files' };

  const absPaths = [...new Set(rawPaths.map((rawPath) => path.resolve(rawPath)))];
  const missingPath = absPaths.find((absPath) => !fs.existsSync(absPath));
  if (missingPath) {
    return { ok: false, reason: 'image_file_not_found', filePaths: absPaths, missingPath };
  }

  const openUpload = await send('Runtime.evaluate', {
    expression: `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const labelOf = (el) => [
        textOf(el),
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        String(el.className || ''),
      ].join(' ').replace(/\s+/g, ' ').trim();
      const click = (el) => {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const triggerPattern = /(参考图|Reference Image|上传图片|上传图|本地图片|添加图片|选择图片|图片上传|image upload|upload image|add image|choose image|select image|upload)/i;
      const regionPattern = /(Reference Image|参考图)/i;
      const regionCandidates = [...document.querySelectorAll('section, form, main, article, aside, div')]
        .filter(isVisible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          return { el, rect, text };
        })
        .filter((item) => regionPattern.test(item.text) && item.rect.width <= Math.max(900, window.innerWidth * 0.9) && item.rect.height <= Math.max(700, window.innerHeight * 0.85))
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      const searchRoots = regionCandidates.length ? regionCandidates.slice(0, 3).map((item) => item.el) : [document.body];
      const allCandidates = searchRoots.flatMap((root) => [...root.querySelectorAll('button, label, [role="button"], [role="tab"], div, span, svg, input[type="file"]')]);
      const candidates = [...new Set(allCandidates)]
        .filter((el) => isVisible(el) || el.tagName === 'INPUT')
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const label = labelOf(el);
          const compact = rect.width <= 320 && rect.height <= 180;
          const clickable = el.tagName === 'BUTTON' || el.tagName === 'LABEL' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.tabIndex >= 0 || el.onclick;
          const explicitInput = el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file';
          const isHistoricalTry = /\bTry\b/i.test(text) && text.length > 80;
          const score = (explicitInput ? -1200 : 0)
            + (clickable ? -300 : 0)
            + (compact ? -200 : 800)
            + (text && text.length <= 28 ? -120 : 120)
            + (isHistoricalTry ? 2000 : 0)
            + Math.abs(rect.left + rect.width / 2 - window.innerWidth * 0.5) * 0.15
            + Math.abs(rect.top + rect.height / 2 - window.innerHeight * 0.65) * 0.25;
          return { el, text, label, compact, clickable, explicitInput, score };
        })
        .filter((item) => item.explicitInput || ((triggerPattern.test(item.text) || triggerPattern.test(item.label)) && !(/\bTry\b/i.test(item.text) && item.text.length > 80)))
        .sort((a, b) => a.score - b.score);
      const clicked = [];
      const item = candidates[0];
      if (item) {
        click(item.el);
        clicked.push({ text: item.text, label: item.label.slice(0, 120), compact: item.compact, clickable: !!item.clickable });
      }
      const inputCount = document.querySelectorAll('input[type="file"]').length;
      return JSON.stringify({ clicked: clicked.length > 0, inputCount, clickedCandidates: clicked });
    })()`,
    returnByValue: true,
  }).catch(() => ({ result: { value: '{}' } }));

  await sleep(1000);

  let parsedLocate = { ok: false, reason: 'file_input_not_found', inputCount: 0 };
  const locateStartedAt = Date.now();
  while (Date.now() - locateStartedAt < 10000) {
    const locateInput = await send('Runtime.evaluate', {
      expression: `(() => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        document.querySelectorAll('input[data-browser-send-upload="1"]').forEach((el) => el.removeAttribute('data-browser-send-upload'));
        const target = inputs.find((el) => /image/i.test(el.accept || '')) || inputs[0];
        if (!target) return JSON.stringify({ ok: false, reason: 'file_input_not_found', inputCount: 0 });
        target.setAttribute('data-browser-send-upload', '1');
        return JSON.stringify({ ok: true, inputCount: inputs.length, accept: target.accept || '', multiple: !!target.multiple });
      })()`,
      returnByValue: true,
    });
    parsedLocate = JSON.parse(locateInput.result?.value || '{}');
    if (parsedLocate.ok) break;
    await sleep(500);
  }
  if (!parsedLocate.ok) {
    return {
      ok: false,
      stage: 'locate_input',
      filePaths: absPaths,
      detail: parsedLocate,
      openUpload: JSON.parse(openUpload.result?.value || '{}'),
    };
  }

  await send('DOM.enable').catch(() => null);
  const dom = await send('DOM.getDocument', { depth: -1, pierce: true });
  const query = await send('DOM.querySelector', {
    nodeId: dom.root.nodeId,
    selector: 'input[data-browser-send-upload="1"]',
  });
  if (!query.nodeId) {
    return {
      ok: false,
      stage: 'query_input',
      filePaths: absPaths,
      detail: parsedLocate,
    };
  }

  await send('DOM.setFileInputFiles', {
    nodeId: query.nodeId,
    files: absPaths,
  });

  await sleep(1200);

  const verify = await send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input[data-browser-send-upload="1"]');
      const files = input ? [...(input.files || [])].map((file) => ({ name: file.name, size: file.size, type: file.type })) : [];
      const bodyText = document.body?.innerText || '';
      return JSON.stringify({
        ok: !!input,
        fileCount: files.length,
        files,
        bodyHasImageHints: /参考图|Reference Image|图片|图像|Image|Upload|上传成功|重新上传|替换|Replace/i.test(bodyText),
        bodySnippet: bodyText.slice(-1200),
      });
    })()`,
    returnByValue: true,
  });

  return {
    ok: true,
    stage: 'uploaded',
    expectedFileCount: absPaths.length,
    filePaths: absPaths,
    openUpload: JSON.parse(openUpload.result?.value || '{}'),
    detail: JSON.parse(verify.result?.value || '{}'),
  };
}

async function waitForVideoPromptReady(send, timeoutMs = 45000) {
  const startedAt = Date.now();
  let last = { ok: false, reason: 'video_prompt_not_started' };
  while (Date.now() - startedAt < timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
        const bodyText = document.body?.innerText || '';
        const uploading = bodyText.split(String.fromCharCode(10)).some((line) => /^\d{1,3}%$/.test(line.trim()));
        const inputs = [
          ...document.querySelectorAll('textarea'),
          ...document.querySelectorAll('[contenteditable="true"]'),
          ...document.querySelectorAll('[role="textbox"]'),
          ...document.querySelectorAll('.ProseMirror'),
        ]
          .filter(isVisible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = textOf(el);
            return { text, x: rect.left, y: rect.top, w: rect.width, h: rect.height };
          })
          .filter((item) => item.w >= 300 && item.y < window.innerHeight * 0.75);
        const promptInput = inputs.find((item) => /Describe the actions in the video|描述|视频/.test(item.text)) || inputs[0];
        const stillUploading = uploading && !promptInput;
        return JSON.stringify({
          ok: !!promptInput && !stillUploading,
          uploading: stillUploading,
          rawUploading: uploading,
          promptInput: promptInput || null,
          inputs: inputs.slice(0, 5),
          bodySnippet: bodyText.slice(-800),
        });
      })()`,
      returnByValue: true,
    }).catch(() => ({ result: { value: '{}' } }));
    try { last = JSON.parse(result.result?.value || '{}'); } catch { last = { ok: false, reason: 'parse_failed' }; }
    if (last.ok) return last;
    await sleep(700);
  }
  return { ...last, ok: false, reason: 'video_prompt_timeout' };
}

async function pollVideoResultInPage(send, conversationId, outputPath = '', options = {}) {
  const conv = String(conversationId || '').trim();
  if (!conv) return { ok: false, skipped: true, reason: 'empty_conversation_id' };
  const maxMs = Number(options.maxMs || 720_000);
  const intervalMs = Number(options.intervalMs || 10_000);
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < maxMs) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {
        const conversationId = ${JSON.stringify(conv)};
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const baseApi = [...resources].reverse().find((url) =>
          url.includes('/im/chain/single') ||
          url.includes('/im/chain/recent_conv') ||
          url.includes('/im/message/send_rate_limit')
        );
        const url = new URL('/im/chain/single', location.origin);
        if (baseApi) {
          const source = new URL(baseApi);
          for (const [key, value] of source.searchParams.entries()) {
            if (key === 'msToken' || key === 'a_bogus' || key === 'web_id' || key === 'tea_uuid') continue;
            url.searchParams.set(key, value);
          }
        } else {
          url.searchParams.set('version_code', '20800');
          url.searchParams.set('language', 'zh');
          url.searchParams.set('device_platform', 'web');
          url.searchParams.set('aid', '495671');
          url.searchParams.set('real_aid', '495671');
          url.searchParams.set('pkg_type', 'release_version');
          url.searchParams.set('pc_version', '3.23.5');
          url.searchParams.set('region', 'JP');
          url.searchParams.set('sys_region', 'JP');
          url.searchParams.set('samantha_web', '1');
          url.searchParams.set('web_platform', 'browser');
          url.searchParams.set('use-olympus-account', '1');
        }
        const body = {
          cmd: 3100,
          uplink_body: {
            pull_singe_chain_uplink_body: {
              conversation_id: conversationId,
              anchor_index: 9007199254740991,
              conversation_type: 3,
              direction: 1,
              limit: 20,
              ext: {},
              filter: { index_list: [] },
              evaluate_ab_params: '',
              evaluate_common_params: '',
            },
          },
          sequence_id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
          channel: 2,
          version: '1',
        };
        const resp = await fetch(url.toString(), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json; encoding=utf-8',
            'agw-js-conv': 'str',
          },
          body: JSON.stringify(body),
        });
        const json = await resp.json();
        const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages || json?.messages || [];
        const candidates = [];
        const failures = [];
        const seenBlockTypes = [];
        const readBlocks = (msg) => {
          if (Array.isArray(msg?.content_block)) return msg.content_block;
          if (typeof msg?.content === 'string' && msg.content.trim().startsWith('[')) {
            try { return JSON.parse(msg.content); } catch {}
          }
          return [];
        };
        const decodeBase64Url = (value) => {
          if (!value) return '';
          try { return atob(value); } catch { return ''; }
        };
        const parseVideoModel = (raw) => {
          if (!raw || typeof raw !== 'string') return {};
          try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
          } catch { return {}; }
        };
        const extractVideoUrls = (video) => {
          const model = parseVideoModel(video?.video_model);
          const gears = Object.values(model?.video_list || {}).filter((item) => item && typeof item === 'object');
          const decoded = [];
          for (const gear of gears) {
            for (const key of ['main_url', 'backup_url_1', 'backup_url_2', 'backup_url_3']) {
              const url = decodeBase64Url(gear?.[key]);
              if (url) decoded.push({ key, url, gear });
            }
          }
          const unwatermarked = decoded.find((item) => /[?&]lr=unwatermarked(?:&|$)/.test(item.url))?.url
            || decoded.find((item) => item.url.includes('unwatermarked'))?.url
            || '';
          const cici = video?.download_url || video?.video_url || video?.play_url || '';
          return {
            url: unwatermarked || cici,
            unwatermarkedUrl: unwatermarked,
            ciciUrl: cici,
            fallbackApi: typeof model?.fallback_api === 'string' ? model.fallback_api : '',
            source: unwatermarked ? 'unwatermarked' : cici ? 'cici' : '',
            fileHash: decoded.find((item) => item.url === unwatermarked)?.gear?.file_hash || '',
            downloadFileHash: video?.download_filehash || '',
          };
        };
        for (const msg of messages) {
          const blocks = readBlocks(msg);
          const ext = msg?.ext || {};
          const texts = [];
          for (const block of blocks) {
            if (block?.block_type != null) seenBlockTypes.push(block.block_type);
            const text = block?.content?.text_block?.text;
            if (text) texts.push(text);
            const creations = block?.content?.creation_block?.creations || [];
            for (const creation of creations) {
              const video = creation?.video || {};
              const urls = extractVideoUrls(video);
              const videoUrl = urls.url;
              if (videoUrl) candidates.push({
                url: videoUrl,
                unwatermarkedUrl: urls.unwatermarkedUrl,
                ciciUrl: urls.ciciUrl,
                fallbackApi: urls.fallbackApi,
                source: urls.source,
                fileHash: urls.fileHash,
                downloadFileHash: urls.downloadFileHash,
                duration: video.duration || '',
                width: video.width || '',
                height: video.height || '',
                mime: video.mime_type || '',
              });
            }
          }
          const code = ext.ai_creation_res_code || '';
          const toolList = ext.ai_creation_tool_list || '';
          const failedTool = /\"status\"\s*:\s*5|\"fail_code\"/i.test(toolList);
          const textFailure = texts.find((value) => /无法|失败|错误|不支持|保护|换其他参考图|生成失败/.test(value));
          if (code || failedTool || textFailure) {
            failures.push([textFailure, code ? 'ai_creation_res_code=' + code : '', failedTool ? 'tool_status=failed' : ''].filter(Boolean).join('；'));
          }
        }
        return JSON.stringify({
          ok: true,
          status: resp.status,
          requestUrl: url.toString(),
          messages: messages.length,
          candidates,
          failures: [...new Set(failures)],
          seenBlockTypes: [...new Set(seenBlockTypes)],
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }).catch((error) => ({ result: { value: JSON.stringify({ ok: false, reason: error.message }) } }));

    try { last = JSON.parse(result.result?.value || '{}'); }
    catch { last = { ok: false, reason: 'poll_result_parse_failed' }; }
    console.log(`[browser-poll] ${elapsed}s messages=${last.messages ?? 0} video=${last.candidates?.length || 0} failures=${last.failures?.length || 0}`);

    if (last.candidates?.length) {
      const pick = last.candidates[0];
      console.log(`[browser-poll] videoUrl: ${pick.url}`);
      console.log(`videoUrl: ${pick.url}`);
      if (pick.unwatermarkedUrl) console.log(`unwatermarkedUrl: ${pick.unwatermarkedUrl}`);
      if (pick.ciciUrl) console.log(`ciciUrl: ${pick.ciciUrl}`);
      let localPath = outputPath ? path.resolve(outputPath) : '';
      if (outputPath) {
        const res = await fetch(pick.url);
        if (!res.ok) throw new Error(`视频下载失败: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buf);
        console.log(`保存到: ${localPath}`);
        localPath = makePlayableVideoIfNeeded(localPath);
      }
      return {
        ok: true,
        ...last,
        videoUrl: pick.url,
        unwatermarkedUrl: pick.unwatermarkedUrl || '',
        ciciUrl: pick.ciciUrl || '',
        videoSource: pick.source || '',
        localPath
      };
    }
    if (last.failures?.length) {
      return { ok: false, failed: true, reason: last.failures.join('；'), ...last };
    }
    await sleep(intervalMs);
  }
  return { ok: false, timeout: true, reason: '浏览器同页轮询超时，未拿到视频结果', last };
}

async function submitPrompt(send, events, prompt, options = {}) {
  const text = ensureVideoPrompt(prompt);
  const dismissed = await dismissBlockingOverlays(send).catch(() => ({}));
  const ratio = options.ratio || '';
  const duration = options.duration || '';
  const imageFiles = Array.isArray(options.imageFiles)
    ? options.imageFiles
    : options.imageFile
      ? [options.imageFile]
      : [];

  let imageModePick = { skipped: true };
  let imageUpload = { skipped: true };
  let uploadReady = { skipped: true };
  let uploadComplete = { skipped: true };
  let postUploadDismissed = { skipped: true };
  let videoModePick = { skipped: true };
  let videoPromptReady = { skipped: true };
  let ratioPick = { skipped: true };
  let durationPick = { skipped: true };
  let finalVideoModeAssert = { skipped: true };
  await waitForCreationModes(send).catch((error) => ({ ok: false, reason: error.message }));

  if (imageFiles.length) {
    imageModePick = await selectCreationMode(send, '图像').catch((error) => ({ ok: false, reason: error.message }));
    if (imageModePick.ok) await sleep(600);
    imageUpload = await uploadReferenceImages(send, imageFiles).catch((error) => ({ ok: false, reason: error.message }));
    await sleep(1200);
    uploadReady = await waitForUploadReady(send).catch((error) => ({ ok: false, reason: error.message }));
    await sleep(800);
    uploadComplete = await waitForUploadComplete(send).catch((error) => ({ ok: false, reason: error.message }));
    await sleep(400);
    postUploadDismissed = await dismissBlockingOverlays(send, 8000).catch((error) => ({ ok: false, reason: error.message }));
    await sleep(600);
  }

  videoModePick = await selectCreationMode(send, '视频').catch((error) => ({ ok: false, reason: error.message }));
  if (videoModePick.ok) await sleep(600);

  if (!videoModePick.ok) {
    return { ok: false, stage: 'mode_video', dismissed, imageModePick, imageUpload, uploadReady, uploadComplete, postUploadDismissed, videoModePick };
  }
  const videoModeAssert = await assertModeSelected(send, '视频').catch((error) => ({ ok: false, reason: error.message }));
  if (!videoModeAssert.ok) {
    return { ok: false, stage: 'mode_video_assert', dismissed, imageModePick, imageUpload, uploadReady, uploadComplete, postUploadDismissed, videoModePick, videoModeAssert };
  }

  videoPromptReady = await waitForVideoPromptReady(send).catch((error) => ({ ok: false, reason: error.message }));
  if (!videoPromptReady.ok) {
    return { ok: false, stage: 'video_prompt_ready', dismissed, imageModePick, imageUpload, uploadReady, uploadComplete, postUploadDismissed, videoModePick, videoModeAssert, videoPromptReady };
  }

  const inputTargetResult = await send('Runtime.evaluate', {
    expression: `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null;
      const bodyText = document.body?.innerText || '';
      const isLoginLikeInput = (el) => {
        const text = [
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('name') || '',
          el.getAttribute('autocomplete') || '',
          String(el.className || ''),
          el.closest?.('[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="login"], [class*="signin"], [class*="auth"]')?.innerText || '',
        ].join(' ');
        return /Log In to Unlock|Scan QR code|Dola App|手机号|手机|验证码|phone|mobile|login|sign in|verification|captcha/i.test(text);
      };
      const candidates = [
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]'),
        ...document.querySelectorAll('input[type="text"]'),
        ...document.querySelectorAll('[role="textbox"]'),
        ...document.querySelectorAll('.ProseMirror'),
      ].filter((el) => isVisible(el) && !isDisabled(el) && !isLoginLikeInput(el));
      const inputs = candidates
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = el.value || el.innerText || el.textContent || '';
          const promptAreaScore = rect.width >= 360 ? -600 : 0;
          const topMainScore = rect.top < window.innerHeight * 0.65 ? -300 : 0;
          const loginPenalty = /Log In to Unlock|Scan QR code|Dola App/.test(bodyText) && rect.width < 360 ? 1200 : 0;
          return { el, rect, text, score: promptAreaScore + topMainScore + loginPenalty + Math.abs(rect.left + rect.width / 2 - window.innerWidth * 0.55) * 0.1 + rect.top * 0.05 };
        })
        .sort((a, b) => a.score - b.score)
        .map((item) => item.el);
      const input = inputs[0];
      if (!input) {
        return JSON.stringify({ ok: false, reason: 'textbox_not_found', location: location.href, body: (document.body?.innerText || '').slice(0, 500) });
      }
      input.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = input.getBoundingClientRect();
      return JSON.stringify({
        ok: true,
        x: Math.min(window.innerWidth - 2, Math.max(2, rect.left + Math.min(24, rect.width / 2))),
        y: Math.min(window.innerHeight - 2, Math.max(2, rect.top + Math.min(18, rect.height / 2))),
        location: location.href,
      });
    })()`,
    returnByValue: true,
  });

  const inputTarget = JSON.parse(inputTargetResult.result?.value || '{}');
  if (!inputTarget.ok) {
    return { ok: false, stage: 'fill', dismissed, imageModePick, imageUpload, uploadReady, uploadComplete, postUploadDismissed, videoPromptReady, detail: inputTarget };
  }

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputTarget.x, y: inputTarget.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputTarget.x, y: inputTarget.y, button: 'left', clickCount: 1 });
  await sleep(200);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 8, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }).catch(() => null);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 8, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }).catch(() => null);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => null);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => null);
  await send('Input.insertText', { text });
  await sleep(500);

  const inputVerifyResult = await send('Runtime.evaluate', {
    expression: `(() => {
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
      const readText = (el) => el ? (el.value || el.innerText || el.textContent || '') : '';
      const activeText = readText(document.activeElement);
      const matchedInput = inputs.find((el) => readText(el).includes(${JSON.stringify(text)}));
      const currentText = activeText.includes(${JSON.stringify(text)}) ? activeText : readText(matchedInput) || readText(inputs[0]);
      return JSON.stringify({ ok: currentText.includes(${JSON.stringify(text)}), inputText: currentText, location: location.href });
    })()`,
    returnByValue: true,
  });

  const parsedInput = JSON.parse(inputVerifyResult.result?.value || '{}');
  if (!parsedInput.ok) {
    return { ok: false, stage: 'fill', dismissed, imageModePick, imageUpload, uploadReady, uploadComplete, postUploadDismissed, videoPromptReady, detail: parsedInput };
  }

  videoModePick = await selectCreationMode(send, '视频').catch((error) => ({ ok: false, reason: error.message }));
  if (videoModePick.ok) await sleep(600);

  if (ratio) {
    ratioPick = await selectRatio(send, ratio).catch((error) => ({ ok: false, reason: error.message }));
    await sleep(800);
  }


  if (duration) {
    durationPick = await selectDuration(send, duration).catch((error) => ({ ok: false, reason: error.message }));
    await sleep(800);
  }

  finalVideoModeAssert = await assertModeSelected(send, '视频').catch((error) => ({ ok: false, reason: error.message }));
  if (!finalVideoModeAssert.ok) {
    return {
      ok: false,
      stage: 'mode_video_final_assert',
      dismissed,
      imageModePick,
      imageUpload,
      uploadReady,
      uploadComplete,
      postUploadDismissed,
      videoPromptReady,
      videoModePick,
      ratioPick,
      durationPick,
      finalVideoModeAssert,
    };
  }

  const sendClick = await clickSendButton(send).catch((error) => ({ ok: false, reason: error.message }));
  await sleep(1200);
  const sendCheckResult = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = ${JSON.stringify(text)};
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
      const readText = (el) => el ? (el.value || el.innerText || el.textContent || '') : '';
      const inputText = inputs.map(readText).find((value) => value.includes(text)) || readText(document.activeElement) || '';
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const requestUrls = resources.filter((url) => url.includes('/chat/completion'));
      return JSON.stringify({
        inputCleared: !inputText.includes(text),
        inputText,
        requestSeen: requestUrls.length > 0,
      });
    })()`,
    returnByValue: true,
  }).catch(() => ({ result: { value: '{}' } }));
  const sendCheck = JSON.parse(sendCheckResult.result?.value || '{}');
  if (!sendClick.ok || (!sendCheck.requestSeen && !sendCheck.inputCleared)) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  await sleep(7000);

  const networkEvidence = (() => {
    const requests = events
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => ({
        requestId: event.params?.requestId || '',
        url: event.params?.request?.url || '',
        method: event.params?.request?.method || '',
        postData: event.params?.request?.postData || '',
      }));

    const responses = new Map();
    for (const event of events) {
      if (event.method === 'Network.responseReceived') {
        responses.set(event.params?.requestId || '', {
          status: event.params?.response?.status,
          mimeType: event.params?.response?.mimeType || '',
          url: event.params?.response?.url || '',
          headers: event.params?.response?.headers || {},
        });
      }
    }

    const completions = requests.filter((item) => item.url.includes('/chat/completion'));
    const related = requests.filter((item) => /dola\.com\/(chat|samantha|api)|video|image|completion/i.test(item.url)).slice(-12);

    const parseBody = (postData) => {
      let body = null;
      try { body = JSON.parse(postData || '{}'); } catch { body = null; }
      const abilityParamRaw = body?.ability_param;
      let abilityParam = null;
      if (typeof abilityParamRaw === 'string') {
        try { abilityParam = JSON.parse(abilityParamRaw || '{}'); } catch { abilityParam = abilityParamRaw; }
      } else if (abilityParamRaw && typeof abilityParamRaw === 'object') {
        abilityParam = abilityParamRaw;
      }
      return {
        ability_type: body?.ability_type,
        ability_param: abilityParam,
        local_conversation_id: body?.client_meta?.local_conversation_id || body?.local_conversation_id || '',
        conversation_id: body?.client_meta?.conversation_id || body?.conversation_id || '',
        collect_id: body?.option?.collect_id ?? body?.collect_id ?? '',
        collection_id: body?.option?.collection_id ?? body?.collection_id ?? '',
        duration: abilityParam?.duration ?? '',
        model: abilityParam?.model ?? '',
        raw_post_size: String(postData || '').length,
      };
    };

    const parsedCompletion = completions.slice(-3).map((item) => {
      const parsed = parseBody(item.postData);
      const response = responses.get(item.requestId || '') || null;
      return {
        requestId: item.requestId,
        url: item.url,
        method: item.method,
        ...parsed,
        response,
      };
    });
    const latestCompletion = parsedCompletion[parsedCompletion.length - 1] || null;
    // Dola 在视频请求之后还会发起其它 /chat/completion 请求（例如标题生成、普通对话），
    // 这些请求的 ability_type 为空，会覆盖 latestCompletion 导致误判。
    // 因此优先在所有捕获到的 completion 中查找视频能力（ability_type === 17）。
    const videoCompletion =
      [...parsedCompletion].reverse().find((item) => Number(item?.ability_type ?? 0) === 17) || null;
    const videoRequestOk = Boolean(videoCompletion);
    const failureCompletion = videoCompletion ?? latestCompletion;
    const videoRequestFailure = !videoRequestOk && failureCompletion
      ? `Dola 浏览器提交没有进入视频能力：ability_type=${failureCompletion.ability_type ?? ''}，ability_param=${JSON.stringify(failureCompletion.ability_param ?? null)}`
      : '';

    return {
      requestCount: requests.length,
      completionCount: completions.length,
      completions: parsedCompletion,
      latestCompletion,
      videoCompletion,
      videoRequestOk,
      videoRequestFailure,
      relatedRequests: related.map((item) => ({ url: item.url, method: item.method })),
    };
  })();

  const verify = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = ${JSON.stringify(text)};
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
      const readText = (el) => el ? (el.value || el.innerText || el.textContent || '') : '';
      const inputText = inputs.map(readText).find((value) => value.includes(text)) || readText(document.activeElement) || '';
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const requestUrls = resources.filter((url) => url.includes('/chat/completion'));
      const bodyText = document.body?.innerText || '';
      return JSON.stringify({
        location: location.href,
        inputCleared: !inputText.includes(text),
        inputText,
        requestSeen: requestUrls.length > 0,
        requestUrl: requestUrls[requestUrls.length - 1] || '',
        bodyHasPrompt: bodyText.includes(text),
        bodyHasBusy: /当前服务访问频繁|生成中|稍后重试|system error|视频/.test(bodyText),
        bodySnippet: bodyText.slice(-1200),
      });
    })()`,
    returnByValue: true,
  });

  const verifyDetail = JSON.parse(verify.result?.value || '{}');
  const conversationId = extractConversationIdFromLocation(verifyDetail.location)
    || networkEvidence.videoCompletion?.conversation_id
    || networkEvidence.latestCompletion?.conversation_id
    || '';
  const browserPoll = options.pollResult
    ? await pollVideoResultInPage(send, conversationId, options.pollOutput || '', {
        maxMs: options.pollTimeoutMs,
        intervalMs: options.pollIntervalMs,
      })
    : { skipped: true };

  return {
    ok: true,
    stage: 'verify',
    dismissed,
    imageModePick,
    imageUpload,
    uploadReady,
    uploadComplete,
    postUploadDismissed,
    videoPromptReady,
    videoModePick,
    finalVideoModeAssert,
    ratioPick,
    durationPick,
    sendClick,
    networkEvidence,
    browserPoll,
    detail: verifyDetail,
  };
}

async function collectExistingBrowserResult(options = {}) {
  const port = Number(options.port || 0);
  if (!port) throw new Error('collect requires --port');
  const conversationId = String(options.conversationId || '').trim() || extractConversationIdFromLocation(options.url || '');
  if (!conversationId) throw new Error('collect requires --conversation-id or chat url');
  const page = await activeDolaPage(port, options.url || (conversationId ? `${DOLA_CHAT_URL}/${conversationId}` : ''));
  const browserPoll = await withPageSocket(page, async (send) => {
    await send('Network.enable').catch(() => null);
    await send('Page.enable').catch(() => null);
    return await pollVideoResultInPage(send, conversationId, options.pollOutput || '', {
      maxMs: options.pollTimeoutMs,
      intervalMs: options.pollIntervalMs,
    });
  }, Math.max(45000, Number(options.pollTimeoutMs || 720_000) + 15000));
  return {
    port,
    url: page?.url || options.url || '',
    conversationId,
    openOnly: false,
    collectOnly: true,
    result: {
      browserPoll,
    },
    browserPoll,
  };
}

async function runBrowserTest(options = {}) {
  if (options.collectOnly) return await collectExistingBrowserResult(options);

  const chromePath = options.chromePath || findChrome();
  if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH to the Chrome executable.');

  const baseProfileDir = path.resolve(options.profile || defaultProfileDir(__dir));
  const useTempProfile = options.tempProfile === true;
  const profileDir = useTempProfile
    ? createTemporaryProfileDir(__dir, baseProfileDir)
    : baseProfileDir;
  const port = Number(options.port || randomPort());
  const visible = options.visible !== false && !options.headless;
  const waitMs = Number(options.waitMs || 8000);
  const targetUrl = options.url || DOLA_CREATE_IMAGE_URL;
  const extensionDir = options.disableExtension ? '' : resolveExtensionDir(options.extensionDir || defaultExtensionDir());

  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
  ];
  if (useTempProfile) args.push('--incognito');
  if (!visible) args.push('--headless=new', '--disable-gpu');
  if (options.proxy) args.push(`--proxy-server=${options.proxy}`);
  if (extensionDir) {
    args.push(`--disable-extensions-except=${extensionDir}`);
    args.push(`--load-extension=${extensionDir}`);
  }
  args.push(targetUrl);

  const chrome = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  chrome.unref();

  let sendSucceeded = false;
  let cookieInjection = null;
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
    console.log(JSON.stringify({
      stage: 'browser-session',
      port,
      profileDir,
      baseProfileDir,
      useTempProfile,
      chromePid: chrome.pid,
      visible,
      url: targetUrl,
    }));
    if (options.envFile) {
      cookieInjection = await injectDolaCookiesIfAvailable(port, options.envFile, targetUrl).catch((error) => ({
        injected: false,
        count: 0,
        reason: error.message,
      }));
      console.log(JSON.stringify({
        stage: 'cookie-injection',
        envFile: options.envFile,
        ...cookieInjection,
      }));
    }
    await sleep(waitMs);
    if (options.openOnly) {
      return {
        port,
        profileDir,
        baseProfileDir,
        useTempProfile,
        visible,
        prompt: '',
        duration: options.duration || '',
        ratio: options.ratio || '',
        url: targetUrl,
        extensionDir,
        cookieInjection,
        openOnly: true,
      };
    }
    const page = await activeDolaPage(port);
    const result = await withPageSocket(page, async (send, events) => {
      await send('Network.enable');
      await send('Page.enable').catch(() => null);
      return await submitPrompt(send, events, options.prompt, {
        duration: options.duration,
        ratio: options.ratio,
        imageFile: options.imageFile,
        imageFiles: options.imageFiles,
      });
    }, 60000);
    sendSucceeded = true;
    return {
      port,
      profileDir,
      baseProfileDir,
      useTempProfile,
      visible,
      prompt: ensureVideoPrompt(options.prompt),
      duration: options.duration || '',
      ratio: options.ratio || '',
      imageFile: options.imageFile || '',
      imageFiles: options.imageFiles || (options.imageFile ? [options.imageFile] : []),
      url: targetUrl,
      extensionDir,
      openOnly: false,
      result,
    };
  } finally {
    if (sendSucceeded && !options.keepOpen) {
      try { process.kill(-chrome.pid); } catch {}
      try { chrome.kill(); } catch {}
    }
  }
}

function parseArgs(argv) {
  const options = {
    visible: true,
    headless: false,
    incognito: false,
    tempProfile: false,
    prompt: '一个小男孩在跳舞',
    duration: '10',
    ratio: '16:9',
    extensionDir: defaultExtensionDir(),
    imageFile: '',
    imageFiles: [],
    pollResult: false,
    pollOutput: '',
    pollTimeoutMs: 720_000,
    pollIntervalMs: 10_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--visible') options.visible = true;
    else if (arg === '--headless') {
      options.headless = true;
      options.visible = false;
    } else if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--collect-only') options.collectOnly = true;
    else if (arg === '--conversation-id') options.conversationId = next();
    else if (arg === '--open-only') options.openOnly = true;
    else if (arg === '--create-image') options.url = DOLA_CREATE_IMAGE_URL;
    else if (arg === '--incognito') {
      options.incognito = true;
      options.tempProfile = true;
    } else if (arg === '--temp-profile' || arg === '--incognito-profile') options.tempProfile = true;
    else if (arg === '--persistent-profile' || arg === '--no-temp-profile') options.tempProfile = false;
    else if (arg === '--prompt') options.prompt = next();
    else if (arg === '--prompt-file') options.prompt = fs.readFileSync(path.resolve(next()), 'utf8');
    else if (arg === '--image-file') {
      const file = next();
      options.imageFile = file;
      options.imageFiles = [...options.imageFiles, file];
    } else if (arg === '--image-files') {
      const files = next().split(',').map((item) => item.trim()).filter(Boolean);
      options.imageFiles = [...options.imageFiles, ...files];
      if (!options.imageFile && files[0]) options.imageFile = files[0];
    } else if (arg === '--image-file2') {
      const file = next();
      options.imageFiles = [...options.imageFiles, file];
      if (!options.imageFile) options.imageFile = file;
    } else if (arg === '--duration') options.duration = next();
    else if (arg === '--ratio') options.ratio = next();
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--out' || arg === '--env-file') options.envFile = next();
    else if (arg === '--proxy') options.proxy = next();
    else if (arg === '--url') options.url = next();
    else if (arg === '--chrome') options.chromePath = next();
    else if (arg === '--extension-dir') options.extensionDir = next();
    else if (arg === '--no-extension') options.disableExtension = true;
    else if (arg === '--wait-ms') options.waitMs = Number(next());
    else if (arg === '--poll-result') options.pollResult = true;
    else if (arg === '--poll-output') options.pollOutput = next();
    else if (arg === '--poll-timeout-ms') options.pollTimeoutMs = Number(next());
    else if (arg === '--poll-interval-ms') options.pollIntervalMs = Number(next());
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage:\n  node browser-send-test.mjs [--visible|--headless] [--keep-open] [--open-only] [--create-image] [--persistent-profile|--temp-profile] [--prompt TEXT|--prompt-file FILE] [--image-file FILE] [--image-file2 FILE | --image-files FILE1,FILE2] [--duration 10] [--profile DIR]\n\nOptions:\n  --visible            Open Chrome window and use the chosen profile.\n  --headless           Run without UI, suitable for an already logged-in profile.\n  --keep-open          Keep Chrome open after the test. Failures always stay open.\n  --open-only          Only open the page, do not auto-send prompt.\n  --create-image       Open https://www.dola.com/chat/create-image\n  --persistent-profile Reuse the profile directly so Dola keeps visible query history. Default: on.\n  --temp-profile       Copy the current session into a temporary incognito browser dir before sending.\n  --prompt TEXT        Prompt to submit. Default: 一个小男孩在跳舞\n  --prompt-file        Read prompt from a file.\n  --image-file FILE    Upload the first local reference image before sending.\n  --image-file2 FILE   Upload a second local reference image before sending.\n  --image-files LIST   Upload multiple local reference images, comma-separated.\n  --duration N         Try selecting target duration, default 10.\n  --ratio RATIO        Try selecting target ratio, default 16:9.\n  --profile DIR        Browser profile dir. Default: .doubao_browsers/dola-send-profile\n  --proxy URL          Chrome proxy server.\n  --url URL            Custom page URL. Default: https://www.dola.com/chat/create-image\n  --chrome FILE        Chrome executable path.\n  --extension-dir DIR  Load unpacked extension from this dir.\n  --no-extension       Disable loading local extension.\n  --wait-ms N          Wait after page load before sending. Default: 8000\n  --port N             Remote debugging port.\n`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const summary = await runBrowserTest(options);
  console.log(JSON.stringify({
    ...summary,
    conversationId: extractConversationIdFromSummary(summary),
    localConversationId: extractLocalConversationIdFromSummary(summary),
  }, null, 2));
} catch (error) {
  console.error(`[browser-send-test] failed: ${error.message}`);
  console.error('发送失败时浏览器会保留打开，方便检查当前 cookie 和页面状态；成功发送后会自动关闭。');
  process.exit(1);
}