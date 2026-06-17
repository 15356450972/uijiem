/**
 * Cookie 自动刷新模块（轻量版，无需 Playwright）
 * 
 * 方案：用系统 Chrome 打开 dola.com，通过 CDP 提取 cookie。
 * 如果 CDP 不可用，则打开浏览器让用户手动复制 cookie。
 */

import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const DOLA_URL = 'https://www.dola.com/chat';

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function extractCookieViaCDP(port, timeout = 15000) {
  const start = Date.now();
  let wsUrl = null;

  // 等待 CDP 端口就绪
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const data = await res.json();
      wsUrl = data.webSocketDebuggerUrl;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (!wsUrl) return null;

  // 等待页面加载
  await new Promise(r => setTimeout(r, 5000));

  // 获取页面列表，找到 dola.com 的页面
  const pagesRes = await fetch(`http://127.0.0.1:${port}/json`);
  const pages = await pagesRes.json();
  const dolaPage = pages.find(p => p.url.includes('dola.com'));

  if (!dolaPage) return null;

  // 通过 CDP HTTP API 获取 cookies
  // 使用 fetch 发送 CDP 命令
  const targetId = dolaPage.id;

  // 激活页面
  await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`);
  await new Promise(r => setTimeout(r, 3000));

  // 通过 WebSocket 发送 CDP 命令获取 cookies
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(dolaPage.webSocketDebuggerUrl);

  return new Promise((resolve) => {
    let msgId = 1;
    const pending = new Map();

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    });

    ws.on('open', async () => {
      const send = (method, params = {}) => {
        const id = msgId++;
        return new Promise(res => {
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      try {
        // 获取所有 cookies
        const cookieResult = await send('Network.getCookies', { urls: ['https://www.dola.com'] });
        const cookies = cookieResult.cookies || [];

        // 构建 cookie 字符串
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        // 获取 URL 参数（从 performance entries）
        const evalResult = await send('Runtime.evaluate', {
          expression: `(() => {
            const entries = performance.getEntriesByType('resource');
            let device_id = '', web_id = '', tea_uuid = '', web_tab_id = '';
            for (const entry of entries) {
              if (entry.name.includes('dola.com') && entry.name.includes('device_id=')) {
                const url = new URL(entry.name);
                device_id = url.searchParams.get('device_id') || device_id;
                web_id = url.searchParams.get('web_id') || web_id;
                tea_uuid = url.searchParams.get('tea_uuid') || tea_uuid;
                web_tab_id = url.searchParams.get('web_tab_id') || web_tab_id;
              }
            }
            return JSON.stringify({ device_id, web_id, tea_uuid, web_tab_id });
          })()`,
          returnByValue: true,
        });

        const params = JSON.parse(evalResult.result.value || '{}');
        ws.close();
        resolve({ cookie: cookieStr, params });
      } catch (e) {
        ws.close();
        resolve(null);
      }
    });

    ws.on('error', () => resolve(null));
    setTimeout(() => { ws.close(); resolve(null); }, 20000);
  });
}

export async function refreshDolaCookie(envFilePath, { proxy, profileDir } = {}) {
  console.log('\n[cookie-refresh] 正在打开浏览器获取新 cookie...');

  const chromePath = findChrome();
  const cdpPort = 19222 + Math.floor(Math.random() * 100);
  const userDataDir = profileDir || path.resolve(path.dirname(envFilePath), '.doubao_browsers', 'dola-refresh-profile');

  if (chromePath) {
    // 方案 A：通过 CDP 自动提取
    console.log(`[cookie-refresh] 使用 Chrome: ${chromePath}`);
    console.log(`[cookie-refresh] CDP 端口: ${cdpPort}`);

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${userDataDir}`,
      DOLA_URL,
    ];
    if (proxy) args.push(`--proxy-server=${proxy}`);

    const chrome = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('[cookie-refresh] Chrome 已启动，等待页面加载...');

    try {
      const result = await extractCookieViaCDP(cdpPort, 20000);

      if (result && result.cookie && result.cookie.includes('ttwid=')) {
        console.log('[cookie-refresh] 成功通过 CDP 获取新 cookie');
        updateEnvFile(envFilePath, result.cookie, result.params);
        updateProcessEnv(result.cookie, result.params);
        // 关闭 Chrome
        try { process.kill(-chrome.pid); } catch {}
        return result;
      }
    } catch (e) {
      console.log(`[cookie-refresh] CDP 提取失败: ${e.message}`);
    }

    // CDP 失败，保持浏览器打开让用户手动操作
    console.log('[cookie-refresh] 自动提取失败，浏览器已打开 dola.com');
    console.log('[cookie-refresh] 请在浏览器中等待页面加载完成...');
    console.log('[cookie-refresh] 然后按 Enter 键继续（将重新尝试提取）...');

    await waitForEnter();

    const retryResult = await extractCookieViaCDP(cdpPort, 10000);
    try { process.kill(-chrome.pid); } catch {}

    if (retryResult && retryResult.cookie && retryResult.cookie.includes('ttwid=')) {
      console.log('[cookie-refresh] 重试成功，已获取新 cookie');
      updateEnvFile(envFilePath, retryResult.cookie, retryResult.params);
      updateProcessEnv(retryResult.cookie, retryResult.params);
      return retryResult;
    }
  }

  // 方案 B：手动输入
  console.log('\n[cookie-refresh] 无法自动提取 cookie');
  console.log('[cookie-refresh] 请手动操作：');
  console.log('  1. 打开浏览器访问 https://www.dola.com/chat');
  console.log('  2. 按 F12 打开开发者工具 → Network 标签');
  console.log('  3. 刷新页面，找到任意发往 www.dola.com 的请求');
  console.log('  4. 复制请求头中的 cookie 值');
  console.log('');

  const cookie = await askInput('请粘贴 cookie: ');
  if (!cookie || !cookie.includes('ttwid=')) {
    throw new Error('无效的 cookie（必须包含 ttwid）');
  }

  updateEnvFile(envFilePath, cookie, {});
  updateProcessEnv(cookie, {});
  return { cookie, params: {} };
}

function updateEnvFile(envFilePath, newCookie, params) {
  if (!fs.existsSync(envFilePath)) {
    console.warn(`[cookie-refresh] .env.dola 文件不存在: ${envFilePath}`);
    return;
  }

  let content = fs.readFileSync(envFilePath, 'utf8');
  content = content.replace(/^DOLA_COOKIE=.*/m, `DOLA_COOKIE=${newCookie}`);

  if (params.device_id) {
    content = content.replace(/^DOLA_DEVICE_ID=.*/m, `DOLA_DEVICE_ID=${params.device_id}`);
  }
  if (params.web_id) {
    content = content.replace(/^DOLA_WEB_ID=.*/m, `DOLA_WEB_ID=${params.web_id}`);
  }
  if (params.tea_uuid) {
    content = content.replace(/^DOLA_TEA_UUID=.*/m, `DOLA_TEA_UUID=${params.tea_uuid}`);
  }
  if (params.web_tab_id) {
    content = content.replace(/^DOLA_WEB_TAB_ID=.*/m, `DOLA_WEB_TAB_ID=${params.web_tab_id}`);
  }

  fs.writeFileSync(envFilePath, content, 'utf8');
  console.log('[cookie-refresh] .env.dola 已更新');
}

function updateProcessEnv(cookie, params) {
  process.env.DOLA_COOKIE = cookie;
  process.env.DOUBAO_COOKIE = cookie;
  if (params.device_id) {
    process.env.DOLA_DEVICE_ID = params.device_id;
    process.env.DOUBAO_DEVICE_ID = params.device_id;
  }
  if (params.web_id) {
    process.env.DOLA_WEB_ID = params.web_id;
    process.env.DOUBAO_WEB_ID = params.web_id;
  }
  if (params.tea_uuid) {
    process.env.DOLA_TEA_UUID = params.tea_uuid;
    process.env.DOUBAO_TEA_UUID = params.tea_uuid;
  }
  if (params.web_tab_id) {
    process.env.DOLA_WEB_TAB_ID = params.web_tab_id;
    process.env.DOUBAO_WEB_TAB_ID = params.web_tab_id;
  }
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('', () => { rl.close(); resolve(); });
  });
}

function askInput(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export function detectNeedsRefresh(responseText) {
  if (!responseText) return false;
  const indicators = [
    '额度不足', '次数已用完', '请稍后再试', 'quota',
    'rate_limit', 'login_required', 'session_expired',
  ];
  const lower = responseText.toLowerCase();
  return indicators.some(ind => lower.includes(ind.toLowerCase()));
}
