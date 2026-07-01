/**
 * OiiOii.ai 完整 SDK
 *
 * 提供能力：
 *   - register()         全自动注册（临时邮箱 + TCaptcha 破解 + 邮箱验证）
 *   - login()            账号登录获取 JWT Token
 *   - getPoints()        查询积分余额
 *   - signIn()           每日签到领积分
 *   - getPointsConfig()  查询积分规则
 *   - getModelPricings() 查询所有模型定价
 *   - uploadImage()      上传参考图，返回 hogi:// URI
 *   - generateImage()    生成图片（提交 + 轮询 + 可选下载）
 *   - generateVideo()    生成视频（提交 + 轮询 + 可选下载）
 *   - download()         下载 hogi:// 资源到本地
 *
 * 用法：
 *   const { OiiOiiClient } = require('./oiioii_sdk');
 *   const client = new OiiOiiClient({ email, password });
 *   await client.login();
 *   const res = await client.generateImage({ prompt: '一只猫', download: true });
 */

const http = require('http');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 可选依赖：注册流程需要，纯生成/下载流程不需要
let TCaptchaCracker = null;
let gptmail = null;
try { ({ TCaptchaCracker } = require('./tcaptcha_crack')); } catch (e) {}
try { gptmail = require('./gptmail'); } catch (e) {}

const DEFAULTS = {
  apiHost: 'api-qc.oiioii.ai',
  authHost: 'api.oiioii.ai',
  origin: 'https://www.oiioii.ai',
  cdnBase: 'https://static-oiioii-sg.hogiai.cn',
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  proxy: { host: '127.0.0.1', port: 7890 },
  captchaAid: '199217712'
};

// 模型别名 → mcpMethodName
const VIDEO_MODELS = {
  'gemini': 'generate_video_gemini_omni',
  'gemini-omni': 'generate_video_gemini_omni',
  'seedance-pro': 'generate_video_seedance20',
  'seedance-fast': 'generate_video_seedance20',
  'seedance-1.5-pro': 'generate_video_seedance10_pro',
  'sora2': 'generate_video_sora2',
  'happyhorse': 'generate_video_happyhorse',
  'vidu': 'generate_video_vidu',
  'vidu-q3-mix': 'generate_video_vidu',
  'vidu-q3-ref': 'generate_video_vidu',
  'vidu-q3-pro': 'generate_video_vidu',
  'vidu-q2': 'generate_video_vidu',
  'wan': 'generate_video_wan27',
  'wan2.7': 'generate_video_wan27',
  'grok': 'generate_video_grok_imagine',
  'grok-imagine': 'generate_video_grok_imagine',
  'kling-3-pro': 'generate_video_kling',
  'kling-3-std': 'generate_video_kling',
  'kling-v3-omni': 'generate_video_kling',
  'kling-o1': 'generate_video_kling_o1',
  'kling-2.6': 'generate_video_kling',
  'hailuo-2.3-pro': 'generate_video_hailuo02',
  'hailuo-2.3-std': 'generate_video_hailuo02'
};

const VIDEO_MODEL_PARAMS = {
  'seedance-pro': 'pro',
  'seedance-fast': 'fast',
  'seedance-1.5-pro': 'Seedance1-5Pro',
  'vidu': 'viduQ3MixRef',
  'vidu-q3-mix': 'viduQ3MixRef',
  'vidu-q3-ref': 'viduQ3Ref',
  'vidu-q3-pro': 'viduQ3',
  'vidu-q2': 'viduQ2',
  'kling-3-pro': '3.0pro',
  'kling-3-std': '3.0std',
  'kling-v3-omni': 'kling-v3-omni',
  'kling-2.6': '2.6',
  'hailuo-2.3-pro': 'hailuo23pro',
  'hailuo-2.3-std': 'hailuo23standard'
};

const IMAGE_MODELS = {
  'gpt-image2': 'generate_image_gpt_image2',
  'nano-pro': 'generate_image_nano',
  'nano2': 'generate_image_nano',
  'seedream5': 'generate_image_seedream50',
  'seedream-5': 'generate_image_seedream50',
  'seedream45': 'generate_image_seedream45',
  'seedream-4.5': 'generate_image_seedream45',
  'midjourney-niji7': 'generate_image_midjourney',
  'midjourney-niji6': 'generate_image_midjourney',
  'midjourney': 'generate_image_midjourney',
  'novelai': 'generate_image_novelai',
  'gpt4o': 'generate_image_gpt4o'
};

const IMAGE_MODEL_PARAMS = {
  'nano-pro': 'nanopro',
  'nano2': 'nano2',
  'midjourney': 'niji7',
  'midjourney-niji7': 'niji7',
  'midjourney-niji6': 'niji6'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function isJwtUsable(token, skewSeconds = 300) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return false;
  return Number(payload.exp) > Math.floor(Date.now() / 1000) + skewSeconds;
}

function authCodeFromResponse(res) {
  return res?.json?.code || res?.json?.error?.code || res?.json?.error || '';
}

function isAuthExpiredResponse(res) {
  const code = String(authCodeFromResponse(res) || '').toUpperCase();
  return code === 'USER_NOT_LOGIN' || code === 'INVALID_REQUEST' || code === 'TOKEN_EXPIRED' || code === 'JWT_EXPIRED';
}

function formatUpstreamError(prefix, res) {
  const code = authCodeFromResponse(res);
  if (isAuthExpiredResponse(res)) {
    return `${prefix}: 渠道四登录态已过期，请刷新积分或重新登录/注册渠道四账号`;
  }
  return `${prefix}: ${res?.data ? res.data.substring(0, 150) : code || '未知错误'}`;
}

class OiiOiiClient {
  constructor(options = {}) {
    this.email = options.email || null;
    this.password = options.password || null;
    this.token = options.token || null;
    this.shareToken = options.shareToken || '';
    this.subAccountId = options.subAccountId || '';
    this.workspaceId = options.workspaceId || null;

    this.apiHost = options.apiHost || DEFAULTS.apiHost;
    this.authHost = options.authHost || DEFAULTS.authHost;
    this.origin = options.origin || DEFAULTS.origin;
    this.cdnBase = options.cdnBase || DEFAULTS.cdnBase;
    this.ua = options.ua || DEFAULTS.ua;
    this.captchaAid = options.captchaAid || DEFAULTS.captchaAid;

    this.useProxy = options.useProxy !== undefined ? options.useProxy : true;
    this.proxy = options.proxy || DEFAULTS.proxy;
    this.outputDir = options.outputDir || './downloads';
    this.debug = !!options.debug;
    this.log = options.logger || ((...a) => console.log(...a));
  }

  _dbg(...a) { if (this.debug) this.log('[debug]', ...a); }

  // ---------------------------------------------------------------------------
  // 底层传输：通过本地代理 CONNECT 隧道发送 HTTPS 请求
  // ---------------------------------------------------------------------------
  _request(apiPath, options = {}) {
    return new Promise((resolve, reject) => {
      const payload = options.body || '';
      const targetHost = options.host || this.apiHost;
      const targetPort = 443;
      const timeout = options.timeout || 30000;

      const headers = {
        'Host': targetHost,
        'User-Agent': this.ua,
        'Accept': '*/*',
        'Origin': this.origin,
        'Referer': `${this.origin}/`,
        'Content-Type': 'application/json',
        'Connection': 'close',
        ...(this.token && !options.noAuth ? { 'Authorization': `Bearer ${this.token}` } : {}),
        ...(!options.noAuth ? { 'x-share-token': this.shareToken, 'x-sub-account-id': this.subAccountId } : {}),
        ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...options.headers
      };

      const sendRequest = (socket) => {
        const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
          const method = options.method || 'GET';
          let reqStr = `${method} ${apiPath} HTTP/1.1\r\n`;
          for (const [k, v] of Object.entries(headers)) reqStr += `${k}: ${v}\r\n`;
          reqStr += '\r\n';
          tlsSocket.write(reqStr);
          if (payload) tlsSocket.write(payload);

          const chunks = [];
          tlsSocket.on('data', d => chunks.push(d));
          tlsSocket.on('end', () => {
            try {
              resolve(this._parseResponse(Buffer.concat(chunks)));
            } catch (e) { reject(e); }
          });
        });
        tlsSocket.on('error', e => reject(new Error(`TLS error: ${e.message}`)));
        tlsSocket.setTimeout(timeout, () => { tlsSocket.destroy(); reject(new Error('TLS timeout')); });
      };

      this._tunnel(targetHost, targetPort, timeout, sendRequest, reject);
    });
  }

  // 建立到目标主机的 socket（走代理或直连）
  _tunnel(targetHost, targetPort, timeout, onSocket, reject) {
    if (this.useProxy) {
      const connectReq = http.request({
        host: this.proxy.host,
        port: this.proxy.port,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        timeout
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`)); return; }
        onSocket(socket);
      });
      connectReq.on('error', reject);
      connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('Proxy timeout')); });
      connectReq.end();
    } else {
      const socket = net.connect(targetPort, targetHost, () => onSocket(socket));
      socket.on('error', reject);
      socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error('Direct connect timeout')); });
    }
  }

  _parseResponse(raw) {
    const rawStr = raw.toString('binary');
    const headerEnd = rawStr.indexOf('\r\n\r\n');
    if (headerEnd === -1) throw new Error('No HTTP headers in response');

    const headerStr = rawStr.substring(0, headerEnd);
    const statusMatch = headerStr.match(/HTTP\/\d\.\d (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;

    const respHeaders = {};
    headerStr.split('\r\n').slice(1).forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) respHeaders[line.substring(0, idx).toLowerCase().trim()] = line.substring(idx + 1).trim();
    });

    let buf = raw.slice(headerEnd + 4);
    if (respHeaders['transfer-encoding']?.includes('chunked')) buf = this._decodeChunked(buf);

    const enc = respHeaders['content-encoding'];
    try {
      if (enc === 'gzip') buf = zlib.gunzipSync(buf);
      else if (enc === 'deflate') buf = zlib.inflateSync(buf);
      else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
    } catch (e) {}

    const text = buf.toString('utf-8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status, data: text, json, headers: respHeaders, body: buf };
  }

  _decodeChunked(buf) {
    const parts = [];
    let pos = 0;
    const str = buf.toString('binary');
    while (pos < str.length) {
      const lineEnd = str.indexOf('\r\n', pos);
      if (lineEnd === -1) break;
      const size = parseInt(str.substring(pos, lineEnd), 16);
      if (!size) break;
      pos = lineEnd + 2;
      parts.push(Buffer.from(str.substring(pos, pos + size), 'binary'));
      pos += size + 2;
    }
    return Buffer.concat(parts);
  }

  // ---------------------------------------------------------------------------
  // 文件下载（跟随重定向）
  // ---------------------------------------------------------------------------
  _downloadFile(url, destPath, options = {}) {
    const cfg = {
      timeout: 120000,
      retry: 0,
      backoffMs: 1000,
      maxBackoffMs: 15000,
      timeoutStepMs: 15000,
      maxTimeoutMs: 300000,
      maxRedirects: 5,
      ...options,
    };

    const retriablePattern = /TLS timeout|Proxy timeout|Download TLS error|Download failed: HTTP 5\d\d|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|No HTTP headers in download response/i;
    const shouldRetry = (msg) => retriablePattern.test(msg);

    const downloadOnce = (currentUrl, remainingRetry, currentTimeout, redirectCount = 0) => new Promise((resolve, reject) => {
      const urlObj = new URL(currentUrl);
      const targetHost = urlObj.hostname;
      const targetPort = urlObj.port || 443;
      let settled = false;

      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const retryOrReject = (err) => {
        const msg = String(err?.message || err || '');
        if (remainingRetry > 0 && shouldRetry(msg)) {
          const nextRetry = remainingRetry - 1;
          const nextTimeout = Math.min(cfg.maxTimeoutMs, currentTimeout + cfg.timeoutStepMs);
          const usedRetries = cfg.retry - remainingRetry + 1;
          const backoff = Math.min(cfg.maxBackoffMs, cfg.backoffMs * Math.max(1, usedRetries));
          this.log(`[download] 链路抖动，${backoff}ms 后重试（剩余 ${nextRetry} 次，超时 ${nextTimeout}ms）`);
          setTimeout(() => {
            downloadOnce(currentUrl, nextRetry, nextTimeout, redirectCount).then(settleResolve).catch(settleReject);
          }, backoff);
          return;
        }
        settleReject(err);
      };

      const handleSocket = (socket) => {
        const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
          const reqPath = urlObj.pathname + urlObj.search;
          const head = [
            `GET ${reqPath} HTTP/1.1`,
            `Host: ${targetHost}`,
            `User-Agent: ${this.ua}`,
            `Referer: ${this.origin}/`,
            ...(this.token ? [`Authorization: Bearer ${this.token}`] : []),
            'Connection: close', '', ''
          ].join('\r\n');
          tlsSocket.write(head);

          const chunks = [];
          tlsSocket.on('data', d => chunks.push(d));
          tlsSocket.on('end', () => {
            try {
              const raw = Buffer.concat(chunks);
              const rawStr = raw.toString('binary');
              const headerEnd = rawStr.indexOf('\r\n\r\n');
              if (headerEnd === -1) {
                retryOrReject(new Error('No HTTP headers in download response'));
                return;
              }

              const headerStr = rawStr.substring(0, headerEnd);
              const status = parseInt((headerStr.match(/HTTP\/\d\.\d (\d+)/) || [])[1] || 0);

              if (status >= 300 && status < 400) {
                const loc = (headerStr.match(/location:\s*(.+)/i) || [])[1];
                if (loc) {
                  const nextUrl = new URL(loc.trim(), currentUrl).toString();
                  this._dbg(`重定向: ${nextUrl.substring(0, 120)}`);
                  if (redirectCount >= cfg.maxRedirects) {
                    settleReject(new Error(`Download redirect overflow (${cfg.maxRedirects})`));
                    return;
                  }
                  downloadOnce(nextUrl, remainingRetry, currentTimeout, redirectCount + 1).then(settleResolve).catch(settleReject);
                  return;
                }
              }
              if (status !== 200) {
                retryOrReject(new Error(`Download failed: HTTP ${status}`));
                return;
              }

              const respHeaders = {};
              headerStr.split('\r\n').slice(1).forEach(line => {
                const idx = line.indexOf(':');
                if (idx > 0) respHeaders[line.substring(0, idx).toLowerCase().trim()] = line.substring(idx + 1).trim();
              });

              let body = raw.slice(headerEnd + 4);
              if (respHeaders['transfer-encoding']?.includes('chunked')) body = this._decodeChunked(body);

              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.writeFileSync(destPath, body);
              settleResolve({ size: body.length, path: destPath });
            } catch (err) {
              retryOrReject(err);
            }
          });
          tlsSocket.setTimeout(currentTimeout, () => {
            tlsSocket.destroy();
            retryOrReject(new Error('TLS timeout'));
          });
        });
        tlsSocket.on('error', e => retryOrReject(new Error(`Download TLS error: ${e.message}`)));
      };

      this._tunnel(targetHost, targetPort, currentTimeout, handleSocket, retryOrReject);
    });

    return downloadOnce(url, cfg.retry, cfg.timeout);
  }

  // ===========================================================================
  // 1. 注册
  // ===========================================================================
  async register(options = {}) {
    if (!TCaptchaCracker || !gptmail) {
      throw new Error('注册功能依赖 ./tcaptcha_crack 和 ./gptmail 模块，请确保文件存在');
    }

    this.log('[register] 开始全自动注册...');
    const password = options.password || this.password || this._genPassword();

    const email = options.email || await gptmail.generateEmail();
    this.log(`[register] 邮箱: ${email}`);

    const captchaConfig = await this._getCaptchaConfig(email);
    const captchaResult = await this._solveCaptcha(captchaConfig);

    const body = {
      email, password,
      inviteCode: options.inviteCode || '',
      language: options.language || 'zh',
      nickname: email.split('@')[0],
      signupOnNotFound: true
    };
    if (captchaResult) {
      body.tencentCaptcha = {
        appid: captchaResult.appid || captchaResult.aid || this.captchaAid,
        randstr: captchaResult.randstr,
        ticket: captchaResult.ticket
      };
    }

    const res = await this._request('/auth/signin_with_password', {
      host: this.authHost, method: 'POST', body: JSON.stringify(body), noAuth: true
    });
    this._dbg('signup resp', res.data.substring(0, 200));
    if (res.json?.code !== 'SUCCESS') {
      throw new Error(`注册请求失败: ${res.json?.code || res.data.substring(0, 120)}`);
    }
    this.log('[register] 验证邮件已发送，等待收件...');

    const verification = await this._waitForVerificationEmail(email, options.maxWait || 90000);
    if (verification.link) {
      const r1 = await this._confirmEmail(verification.link);
      if (r1.status >= 300 && r1.status < 400 && r1.location) {
        await this._confirmEmail(r1.location);
      }
    }

    this.email = email;
    this.password = password;
    this.log('[register] 注册成功');
    return { success: true, email, password };
  }

  async _getCaptchaConfig(email) {
    const res = await this._request('/auth/tencent_captcha_config', {
      host: this.authHost, method: 'POST', noAuth: true,
      body: JSON.stringify({ identifier: email, scene: 'email_login' })
    });
    if (res.json?.code === 'DISABLED' || res.json?.code === 'SKIPPED') return null;
    if (res.json?.code !== 'SUCCESS') throw new Error(`captcha config 失败: ${res.data.substring(0, 150)}`);
    return res.json;
  }

  async _solveCaptcha(captchaConfig) {
    if (!captchaConfig) return null;
    this.log('[register] 破解 TCaptcha...');
    const cracker = new TCaptchaCracker({
      aid: captchaConfig.captchaAppId || this.captchaAid,
      entryUrl: `${this.origin}/login`,
      aidEncrypted: captchaConfig.aidEncrypted || '',
      aidEncryptedType: captchaConfig.aidEncryptedType || 'cbc',
      debug: this.debug,
      useRotatingProxy: false
    });
    const result = await cracker.run();
    if (!result.ok) throw new Error(`验证码破解失败: ${result.errorMsg}`);
    return result;
  }

  async _waitForVerificationEmail(email, maxWait) {
    const cookies = await gptmail.getFullBrowserCookies(email);
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const result = await gptmail.getEmailsWithCookies(email, cookies);
      if (result?.success && result.data?.emails?.length > 0) {
        const mail = result.data.emails[0];
        const content = mail.html_content || mail.content || '';
        const link = (content.match(/href="(https?:\/\/[^"]*(?:verify|confirm)[^"]*)"/i) ||
          content.match(/href="(https?:\/\/[^"]*token=[^"]*)"/i) || [])[1];
        if (link) return { link, mail };
        const code = (content.match(/\b(\d{4,6})\b/) || [])[1];
        if (code) return { code, mail };
        return { mail, content };
      }
      await sleep(2000);
    }
    throw new Error(`验证邮件超时（${maxWait / 1000}s）`);
  }

  _confirmEmail(verifyLink) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(verifyLink);
      const targetHost = urlObj.hostname;
      const targetPort = urlObj.port || 443;
      const onSocket = (socket) => {
        const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
          tlsSocket.write(`GET ${urlObj.pathname + urlObj.search} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: ${this.ua}\r\nConnection: close\r\n\r\n`);
          const chunks = [];
          tlsSocket.on('data', d => chunks.push(d));
          tlsSocket.on('end', () => {
            const raw = Buffer.concat(chunks).toString('binary');
            const headerEnd = raw.indexOf('\r\n\r\n');
            const headerStr = raw.substring(0, headerEnd);
            const status = parseInt((headerStr.match(/HTTP\/\d\.\d (\d+)/) || [])[1] || 0);
            const location = (headerStr.match(/location:\s*(.+)/i) || [])[1]?.trim();
            resolve({ status, location });
          });
        });
        tlsSocket.on('error', e => reject(new Error(`Confirm TLS error: ${e.message}`)));
      };
      this._tunnel(targetHost, targetPort, 15000, onSocket, reject);
    });
  }

  _genPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const special = '@#$!';
    let pwd = '';
    for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    pwd += special[Math.floor(Math.random() * special.length)];
    pwd += Math.floor(Math.random() * 100);
    return pwd;
  }

  // ===========================================================================
  // 2. 登录
  // ===========================================================================
  async login(options = {}) {
    if (this.token && !options.force && isJwtUsable(this.token)) {
      this.log('[login] 已有有效 Token，跳过登录');
      return this.token;
    }
    if (this.token && !options.force && !isJwtUsable(this.token)) {
      this.log('[login] Token 已过期，重新登录刷新');
    }
    const email = options.email || this.email;
    const password = options.password || this.password;
    if (!email || !password) {
      if (this.token && !isJwtUsable(this.token)) {
        throw new Error('渠道四登录态已过期，且账号文件缺少邮箱或密码，无法自动刷新；请重新登录或重新注册渠道四账号');
      }
      throw new Error('login 需要 email 和 password');
    }

    this.log('[login] 登录中...');
    const captchaRes = await this._request('/auth/tencent_captcha_config', {
      method: 'POST', noAuth: true,
      body: JSON.stringify({ identifier: email, scene: 'email_login' })
    });

    let captchaPayload = {};
    if (captchaRes.json?.code === 'SUCCESS' && captchaRes.json?.captchaAppId) {
      if (!TCaptchaCracker) throw new Error('登录需要验证码，但 ./tcaptcha_crack 模块不可用');
      this.log('[login] 破解 TCaptcha...');
      const cracker = new TCaptchaCracker({
        aid: captchaRes.json.captchaAppId,
        entryUrl: `${this.origin}/login`,
        aidEncrypted: captchaRes.json.aidEncrypted || '',
        aidEncryptedType: captchaRes.json.aidEncryptedType || 'cbc',
        debug: this.debug,
        useRotatingProxy: false
      });
      const cr = await cracker.run();
      if (!cr.ok) throw new Error(`验证码破解失败: ${cr.errorMsg}`);
      captchaPayload = { tencentCaptcha: { appid: captchaRes.json.captchaAppId, randstr: cr.randstr, ticket: cr.ticket } };
    }

    const res = await this._request('/auth/signin_with_password', {
      method: 'POST', noAuth: true,
      body: JSON.stringify({ email, password, signupOnNotFound: false, ...captchaPayload })
    });
    this._dbg('login resp', res.data.substring(0, 200));
    if (res.json?.code !== 'SUCCESS') {
      throw new Error(`登录失败: ${res.json?.code || res.data.substring(0, 120)}`);
    }

    this.token = res.json.accessToken || res.json.token || res.json.data?.accessToken ||
      res.json.data?.token || res.json.data?.access_token;
    if (!this.token) {
      const setCookie = res.headers['set-cookie'] || '';
      const m = setCookie.match(/access[_-]token=([^;]+)/i);
      if (m) this.token = m[1];
    }
    if (!this.token) throw new Error(`登录成功但未拿到 Token: ${res.data.substring(0, 200)}`);

    this.log(`[login] Token: ${this.token.substring(0, 24)}...`);
    return this.token;
  }

  // ===========================================================================
  // 3. 积分
  // ===========================================================================
  async signIn() {
    const res = await this._request('/points/add', {
      method: 'POST', body: JSON.stringify({ data: { type: 'sign_in' } })
    });
    if (res.json?.code === 'SUCCESS') {
      this.log(`[points] 签到成功 +${res.json.data?.added ?? '?'}`);
      return { signedIn: true, added: res.json.data?.added, data: res.json.data };
    }
    this.log(`[points] 签到跳过: ${res.json?.code || '可能已签到'}`);
    return { signedIn: false, code: res.json?.code };
  }

  async getPoints() {
    const res = await this._request('/points/current_user_points', {
      method: 'POST', body: JSON.stringify({ data: {} })
    });
    if (res.json?.code !== 'SUCCESS') throw new Error(`查询积分失败: ${res.json?.code || res.data.substring(0, 120)}`);
    const d = res.json.data || {};
    return {
      points: d.points ?? d.available_limited ?? 0,
      availableLimited: d.available_limited ?? 0,
      availablePerm: d.available_perm ?? 0,
      hasSignedInToday: !!d.has_signed_in_today,
      summary: d.points_summary,
      buckets: d.limited_buckets,
      raw: d
    };
  }

  async getPointsConfig() {
    const res = await this._request('/points/config', {
      method: 'POST', body: JSON.stringify({ data: {} })
    });
    return res.json?.data?.configs || [];
  }

  async getModelPricings() {
    const res = await this._request('/points/mcp_model_pricings', {
      method: 'POST', body: JSON.stringify({ data: { isActive: true } })
    });
    return res.json?.models || res.json?.data || res.json;
  }

  // ===========================================================================
  // 4. Workspace
  // ===========================================================================
  async getWorkspace(options = {}) {
    if (this.workspaceId && !options.force) return this.workspaceId;

    const res = await this._request('/workspace/create_workspace', {
      method: 'POST', body: JSON.stringify({ name: options.name || `ws_${Date.now()}` })
    });
    if (res.json?.code === 'SUCCESS' || res.json?.success) {
      this.workspaceId = res.json.data?.id || res.json.data?.workspaceId || res.json.workspaceId;
    }
    if (!this.workspaceId) {
      const listRes = await this._request('/workspace/list', {
        method: 'POST', body: JSON.stringify({ data: {} })
      });
      if (listRes.json?.data?.length > 0) this.workspaceId = listRes.json.data[0].id;
    }
    if (!this.workspaceId) throw new Error(`无法获取 workspace: ${res.data.substring(0, 150)}`);

    this.log(`[workspace] ${this.workspaceId}`);
    return this.workspaceId;
  }

  // ===========================================================================
  // 5. 上传参考图
  // ===========================================================================
  async uploadImage(imagePath) {
    if (!imagePath) return null;
    const imgBuf = fs.readFileSync(imagePath);
    const md5 = crypto.createHash('md5').update(imgBuf).digest('hex');
    const ext = path.extname(imagePath).slice(1) || 'jpg';
    const fileName = path.basename(imagePath);

    const checkRes = await this._request('/res/check_upload_file', {
      method: 'POST',
      body: JSON.stringify({ contentMd5: md5, fileName, fileSize: imgBuf.length, fileType: ext })
    });
    if (checkRes.json?.data?.exists && checkRes.json?.data?.uri) {
      this.log(`[upload] 已存在: ${checkRes.json.data.uri}`);
      return checkRes.json.data.uri;
    }

    const uploadRes = await this._request('/res/upload_file', {
      method: 'POST', timeout: 60000,
      body: JSON.stringify({ fileBlob: imgBuf.toString('base64'), fileName, fileType: ext })
    });
    if (uploadRes.json?.code === 'SUCCESS' && uploadRes.json?.data?.uri) {
      this.log(`[upload] 成功: ${uploadRes.json.data.uri}`);
      return uploadRes.json.data.uri;
    }
    throw new Error(formatUpstreamError('上传失败', uploadRes));
  }

  _toReadFileUrl(uriOrUrl, host = this.authHost) {
    if (!uriOrUrl || !uriOrUrl.startsWith('hogi://')) return uriOrUrl;
    return `https://${host}/res/read_file?uri=${encodeURIComponent(uriOrUrl)}`;
  }

  // ===========================================================================
  // 6. 生成图片
  // ===========================================================================
  async generateImage(options = {}) {
    await this.getWorkspace({ force: true });
    const model = IMAGE_MODELS[options.model] || options.mcpMethodName || options.model || IMAGE_MODELS['gpt-image2'];
    const modelParam = options.modelParam !== undefined ? options.modelParam : IMAGE_MODEL_PARAMS[options.model];

    let refImages = [];
    let refBindings = [];
    if (options.referenceImages?.length) {
      const uris = [];
      for (const ref of options.referenceImages) {
        const uri = ref.startsWith('hogi://') || /^https?:\/\//.test(ref) ? ref : await this.uploadImage(ref);
        uris.push(uri);
      }
      refImages = uris;
      // GPT-Image2 网页端发送 imageRefBindings: []，其他模型才发送 binding 数组
      refBindings = options.imageRefBindings || (options.model === 'gpt-image2' ? [] : uris.map((uri, i) => ({ index: i + 1, kind: 'image', label: `Image_${i + 1}`, uri })));
    }

    const imageUri = options.model === 'gpt-image2' ? '' : (options.imageUri || (options.imageToImage && refImages[0] ? refImages[0] : ''));
    let prompt = options.prompt || '生成一张精美的图片';
    if (options.model === 'gpt-image2' && refImages.length) {
      // 网页端用 [Image:image/xxx.png] 格式，SDK 用 [Image1] 格式，两种都算已有 token
      const hasImageToken = /\[Image\d+\]/i.test(prompt) || /\[Image:image\//i.test(prompt);
      if (!hasImageToken) {
        const tokens = refImages.map((_, i) => `[Image${i + 1}]`).join(' 和 ');
        prompt = `${tokens} ${prompt}`;
      }
    }
    const assetId = crypto.randomUUID();
    const aspectRatio = options.aspectRatio || '1:1';
    const body = {
      workspaceId: this.workspaceId,
      assetId,
      aspectRatio,
      imageUri,
      mcpMethodName: model,
      prompt,
      resolution: options.resolution || '2K',
      referenceImages: refImages,
      imageRefBindings: refBindings,
      roleAssets: [],
      sceneAssets: [],
      itemAssets: [],
      styleUri: options.styleUri || ''
    };

    if (options.afterAssetId) body.afterAssetId = options.afterAssetId;

    if (modelParam !== undefined && modelParam !== null && modelParam !== '') {
      body.model = modelParam;
    }

    this.log(`[image] 提交任务 model=${model}${body.model ? `/${body.model}` : ''} aspectRatio=${body.aspectRatio} resolution=${body.resolution} size=${body.size || 'N/A'} refs=${refImages.length} prompt="${(body.prompt).substring(0, 40)}"`);
    this.log(`[image] 请求体: ${JSON.stringify(body)}`);
    const res = await this._request('/media/generate_image_asset/submit', {
      method: 'POST', body: JSON.stringify(body)
    });
    this.log(`[image] 提交返回: ${res.data.substring(0, 500)}`);
    if (!res.json?.success || !res.json?.taskId) throw new Error(`图片任务提交失败: ${res.data.substring(0, 300)}`);

    const taskId = res.json.taskId;
    this.log(`[image] taskId: ${taskId}`);

    const task = await this._pollTask(taskId, options);
    return this._finishTask(task, 'image', options);
  }

  // ===========================================================================
  // 7. 生成视频
  // ===========================================================================
  async generateVideo(options = {}) {
    await this.getWorkspace({ force: true });
    const model = VIDEO_MODELS[options.model] || options.mcpMethodName || options.model || VIDEO_MODELS['gemini'];
    const modelParam = options.modelParam !== undefined ? options.modelParam : VIDEO_MODEL_PARAMS[options.model];

    let refImages = [];
    let refBindings = [];
    const refs = options.referenceImages || (options.image ? [options.image] : []);
    if (refs.length) {
      const uris = [];
      for (const ref of refs) {
        uris.push(ref.startsWith('hogi://') || /^https?:\/\//.test(ref) ? ref : await this.uploadImage(ref));
      }
      refImages = uris;
      if (options.imageRefBindings) {
        refBindings = options.imageRefBindings;
      } else if (options.primaryImageIndex !== undefined) {
        const idx = options.primaryImageIndex;
        refBindings = uris[idx] ? [{ index: idx + 1, kind: 'image', label: `Image_${idx + 1}`, uri: uris[idx] }] : [];
      } else {
        refBindings = uris.map((uri, i) => ({ index: i + 1, kind: 'image', label: `Image_${i + 1}`, uri }));
      }
    }

    const assetId = crypto.randomUUID();
    const body = {
      workspaceId: this.workspaceId,
      assetId,
      aspectRatio: options.aspectRatio || '16:9',
      duration: options.duration || 10,
      mcpMethodName: model,
      prompt: options.prompt || '生成一段精美的视频',
      resolution: options.resolution || '720p',
      referenceImages: refImages,
      imageRefBindings: refBindings
    };

    if (options.afterAssetId) body.afterAssetId = options.afterAssetId;

    if (modelParam !== undefined && modelParam !== null && modelParam !== '') {
      body.model = modelParam;
    }

    this.log(`[video] 提交任务 model=${model}${body.model ? `/${body.model}` : ''} prompt="${(body.prompt).substring(0, 40)}"`);
    const res = await this._request('/media/generate_video_asset/submit', {
      method: 'POST', body: JSON.stringify(body)
    });
    this._dbg('video submit', res.data.substring(0, 200));
    if (!res.json?.success || !res.json?.taskId) throw new Error(`视频任务提交失败: ${res.data.substring(0, 200)}`);

    const taskId = res.json.taskId;
    this.log(`[video] taskId: ${taskId}`);

    const task = await this._pollTask(taskId, options);
    return this._finishTask(task, 'video', options);
  }

  async generateImageToVideo(options = {}) {
    const refs = options.referenceImages || (options.image ? [options.image] : []);
    return this.generateVideo({
      duration: 4,
      model: 'gemini',
      primaryImageIndex: 0,
      ...options,
      referenceImages: refs
    });
  }

  // ---------------------------------------------------------------------------
  // 任务轮询
  // ---------------------------------------------------------------------------
  async _pollTask(taskId, options = {}) {
    const maxWait = options.maxWait || 600000;
    const interval = options.pollInterval || 5000;
    const requestTimeout = options.pollRequestTimeout || 60000;
    const maxTransientErrors = options.maxTransientErrors || 6;
    const start = Date.now();
    let transientErrors = 0;

    while (Date.now() - start < maxWait) {
      let res;
      try {
        res = await this._request(`/media/canvas_async_tasks/sync?workspaceId=${this.workspaceId}`, {
          method: 'GET',
          timeout: requestTimeout,
        });
        transientErrors = 0;
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (/TLS timeout|Proxy timeout|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN/i.test(msg)) {
          transientErrors += 1;
          if (transientErrors > maxTransientErrors) {
            throw new Error(`轮询任务状态失败：网络超时次数过多（${transientErrors} 次），请稍后重试`);
          }
          const backoff = Math.min(15000, interval * Math.max(1, transientErrors));
          this.log(`[task] 轮询超时，${backoff}ms 后重试（${transientErrors}/${maxTransientErrors}）`);
          await sleep(backoff);
          continue;
        }
        throw e;
      }

      const task = res.json?.tasks?.find(t => t.task_id === taskId);
      if (task) {
        if (task.status === 'completed' && task.output_uri) {
          this.log(`\n[task] 完成: ${task.output_uri}`);
          return task;
        }
        if (task.status === 'failed') {
          this.log(`[task] 失败完整返回: ${JSON.stringify(task)}`);
          const parts = [task.error_message, task.error_code, task.fail_reason, task.failure_reason]
            .filter(Boolean)
            .map(x => String(x).trim())
            .filter(Boolean);
          const suffix = parts.length ? parts.join(' / ') : '平台未返回具体失败原因，可能是提示词触发限制、模型临时不可用、账号额度不足或参考图不兼容';
          throw new Error(`生成失败: ${suffix} (taskId: ${taskId})`);
        }
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        if (options.onProgress) options.onProgress(task.progress || 0, elapsed);
        else process.stdout.write(`\r[task] 进度: ${task.progress || 0}% | ${elapsed}s`);
      }
      await sleep(interval);
    }
    throw new Error(`任务超时（${maxWait / 1000}s）`);
  }

  async _finishTask(task, kind, options) {
    const result = {
      success: true,
      taskId: task.task_id,
      outputUri: task.output_uri,
      cdnUrl: this.hogiToUrl(task.output_uri),
      downloadUrl: `https://${this.apiHost}/res/read_file?uri=${encodeURIComponent(task.output_uri)}`,
      submittedModel: options.model || '',
      submittedMcpMethodName: task.result_payload?.inputArgs?.mcpMethodName || options.mcpMethodName || '',
      submittedModelParam: task.result_payload?.inputArgs?.model || options.modelParam || '',
      task
    };
    if (options.fetchMeta) {
      result.meta = await this.getFileMeta(task.output_uri);
    }
    if (options.fetchRecord) {
      result.record = await this.getGenaiRecordByUri(task.output_uri);
    }
    if (kind === 'video' && options.fetchFirstFrame) {
      result.firstFrame = await this.getFirstFrame(task.output_uri, options.firstFrameOptions || {});
    }
    if (options.download) {
      const filename = options.filename || task.output_uri.split('/').pop();
      const destPath = path.join(options.outputDir || this.outputDir, filename);
      const dl = await this.download(task.output_uri, destPath, {
        retry: options.downloadRetry !== undefined ? options.downloadRetry : 2,
        timeout: options.downloadTimeout !== undefined ? options.downloadTimeout : 120000,
        backoffMs: options.downloadBackoffMs !== undefined ? options.downloadBackoffMs : 1500,
        timeoutStepMs: options.downloadTimeoutStepMs !== undefined ? options.downloadTimeoutStepMs : 15000,
      });
      result.localPath = dl.path;
      result.fileSize = dl.size;
      this.log(`[${kind}] 下载完成: ${destPath} (${(dl.size / 1024 / 1024).toFixed(2)} MB)`);
    }
    return result;
  }

  // ===========================================================================
  // 8. 下载
  // ===========================================================================
  // 支持 hogi:// URI、CDN URL 或完整 URL
  async download(uriOrUrl, destPath, options = {}) {
    let url;
    if (uriOrUrl.startsWith('hogi://')) {
      url = `https://${this.apiHost}/res/read_file?uri=${encodeURIComponent(uriOrUrl)}`;
    } else {
      url = uriOrUrl;
    }
    if (!destPath) {
      const filename = uriOrUrl.split('/').pop().split('?')[0];
      destPath = path.join(this.outputDir, filename);
    }
    const timeout = options.timeout !== undefined ? options.timeout : 120000;
    const retry = options.retry !== undefined ? options.retry : 0;
    return this._downloadFile(url, destPath, {
      timeout,
      retry,
      backoffMs: options.backoffMs !== undefined ? options.backoffMs : 1000,
      maxBackoffMs: options.maxBackoffMs !== undefined ? options.maxBackoffMs : 15000,
      timeoutStepMs: options.timeoutStepMs !== undefined ? options.timeoutStepMs : 15000,
      maxTimeoutMs: options.maxTimeoutMs !== undefined ? options.maxTimeoutMs : 300000,
    });
  }

  // 查询文件元数据（不需要鉴权）
  async getFileMeta(uri) {
    const res = await this._request(`/res/file_meta?uri=${encodeURIComponent(uri)}`, { method: 'GET', noAuth: true });
    return res.json;
  }

  getDownloadUrl(uriOrUrl, options = {}) {
    const host = options.host || this.apiHost;
    return this._toReadFileUrl(uriOrUrl, host);
  }

  async getGenaiRecordByUri(uri) {
    const res = await this._request(`/genai/image-record/by-uri?uri=${encodeURIComponent(uri)}`, { method: 'GET' });
    return res.json;
  }

  async getImageRecordByUri(uri) {
    return this.getGenaiRecordByUri(uri);
  }

  async getFirstFrame(uri, options = {}) {
    const timeMs = options.timeMs !== undefined ? options.timeMs : 67;
    const mode = options.mode || 'json';
    const res = await this._request(`/res/first_frame?uri=${encodeURIComponent(uri)}&timeMs=${encodeURIComponent(String(timeMs))}&mode=${encodeURIComponent(mode)}`, { method: 'GET', noAuth: true });
    return res.json;
  }

  // hogi://image/xxx → https://cdn/image/xxx
  hogiToUrl(uri) {
    if (!uri || !uri.startsWith('hogi://')) return uri;
    const m = uri.match(/^hogi:\/\/(\w+)\/(.+)$/);
    if (!m) return uri;
    return `${this.cdnBase}/${m[1]}/${m[2]}`;
  }

  // ===========================================================================
  // 9. 账号持久化（供 CLI 复用 token / 凭证）
  // ===========================================================================
  // 导出可序列化的账号信息
  toAccount() {
    return {
      email: this.email,
      password: this.password,
      token: this.token,
      savedAt: new Date().toISOString()
    };
  }

  // 写入账号文件（默认 ./oiioii_account.json）
  saveAccount(file) {
    const dest = file || OiiOiiClient.accountFile;
    fs.writeFileSync(dest, JSON.stringify(this.toAccount(), null, 2), 'utf-8');
    this._dbg(`账号已保存: ${dest}`);
    return dest;
  }

  // 读取账号文件并合并到当前实例
  loadAccount(file) {
    const src = file || OiiOiiClient.accountFile;
    if (!fs.existsSync(src)) return null;
    const acc = JSON.parse(fs.readFileSync(src, 'utf-8'));
    this.email = this.email || acc.email;
    this.password = this.password || acc.password;
    this.token = this.token || acc.token;
    return acc;
  }

  // 从账号文件创建实例
  static fromAccount(file, options = {}) {
    const src = file || OiiOiiClient.accountFile;
    const acc = fs.existsSync(src) ? JSON.parse(fs.readFileSync(src, 'utf-8')) : {};
    return new OiiOiiClient({ ...acc, ...options });
  }

  // 可用模型清单
  static listModels() {
    return {
      image: { ...IMAGE_MODELS },
      imageModelParams: { ...IMAGE_MODEL_PARAMS },
      video: { ...VIDEO_MODELS },
      videoModelParams: { ...VIDEO_MODEL_PARAMS }
    };
  }
}

OiiOiiClient.accountFile = path.join(process.cwd(), 'oiioii_account.json');

module.exports = { OiiOiiClient, VIDEO_MODELS, IMAGE_MODELS, sleep };
