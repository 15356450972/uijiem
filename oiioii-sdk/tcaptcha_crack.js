/**
 * TCaptcha 完整破解流程 - jsdom + NCC 方案
 * 
 * 流程：
 * 1. prehandle - 获取 sess、图片配置、pow_cfg、tdc_path
 * 2. 下载背景图 + 精灵图
 * 3. NCC 模板匹配求解缺口位置
 * 4. PoW 暴力搜索
 * 5. jsdom 执行 tdc.js 生成 collect/eks
 * 6. 提交 verify 获取 ticket/randstr
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const { NCCSolver } = require('./ncc_solver');
const { executeTDC, generateTrajectory, fetchUrl } = require('./tdc_executor');

// 旋转代理配置（通过本地代理 CONNECT 到旋转代理）
const ROTATING_PROXY = {
  localHost: '127.0.0.1',
  localPort: 7890,
  remoteHost: 'us.ipwo.net',
  remotePort: 7878,
  user: 'mengjun66_custom_zone_GLOBAL',
  pass: 'mengjun66'
};

class TCaptchaCracker {
  constructor(options = {}) {
    this.aid = options.aid || '199217712';
    this.entryUrl = options.entryUrl || 'https://www.oiioii.ai/login';
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
    this.baseUrl = 'https://turing.captcha.qcloud.com';
    this.maxRetries = options.maxRetries || 3;
    this.debug = options.debug || false;
    this.useRotatingProxy = options.useRotatingProxy !== undefined ? options.useRotatingProxy : false;

    // aidEncrypted 从 oiioii API 获取
    this.aidEncrypted = options.aidEncrypted || '';
    this.aidEncryptedType = options.aidEncryptedType || 'cbc';

    this.sess = null;
    this.sid = null;
    this.powCfg = null;
    this.tdcPath = null;
    this.bgUrl = null;
    this.fgUrl = null;
    this.fgElemList = null;
    this.subsid = 1;
  }

  // 链式代理：本地7894 -> CONNECT ipwo -> CONNECT 目标HTTPS -> TLS -> HTTP请求
  // 全程加超时：隧道任一阶段挂起超过 timeout 即销毁 socket 并 reject（坏 IP 自动放弃）
  _requestViaRotatingProxy(url, options = {}) {
    const tls = require('tls');
    const timeout = options.timeout || 15000;
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const rp = ROTATING_PROXY;
      const auth = Buffer.from(`${rp.user}:${rp.pass}`).toString('base64');
      const isHttps = urlObj.protocol === 'https:';
      const targetHost = urlObj.hostname;
      const targetPort = urlObj.port || (isHttps ? 443 : 80);

      let settled = false;
      let socket1Ref = null;
      let tlsSocketRef = null;

      const cleanup = () => {
        try { if (tlsSocketRef) tlsSocketRef.destroy(); } catch (e) {}
        try { if (socket1Ref) socket1Ref.destroy(); } catch (e) {}
        try { connectReq.destroy(); } catch (e) {}
      };
      const done = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { cleanup(); reject(err); }
        else resolve(result);
      };
      const timer = setTimeout(() => {
        done(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      // Step 1: CONNECT to rotating proxy via local proxy
      const connectReq = http.request({
        host: rp.localHost, port: rp.localPort,
        method: 'CONNECT', path: `${rp.remoteHost}:${rp.remotePort}`,
        timeout
      });

      connectReq.on('connect', (res1, socket1) => {
        socket1Ref = socket1;
        if (res1.statusCode !== 200) { done(new Error(`Step1 CONNECT failed: ${res1.statusCode}`)); return; }

        if (isHttps) {
          // Step 2: CONNECT to target HTTPS host via rotating proxy
          socket1.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);

          let connectBuf = '';
          const onData = (d) => {
            connectBuf += d.toString();
            if (connectBuf.includes('\r\n\r\n')) {
              socket1.removeListener('data', onData);
              if (!connectBuf.includes(' 200 ')) { done(new Error(`Step2 CONNECT failed: ${connectBuf.split('\r\n')[0]}`)); return; }

              // Step 3: TLS handshake + HTTP request
              const tlsSocket = tls.connect({ socket: socket1, servername: targetHost }, () => {
                this._sendHttpOnSocket(tlsSocket, urlObj, options, (r) => done(null, r), (e) => done(e));
              });
              tlsSocketRef = tlsSocket;
              tlsSocket.on('error', e => done(new Error(`TLS error: ${e.message}`)));
            }
          };
          socket1.on('data', onData);
          socket1.on('error', e => done(new Error(`Tunnel socket error: ${e.message}`)));
        } else {
          // HTTP target: send request directly through rotating proxy as forward proxy
          const method = options.method || 'GET';
          let reqStr = `${method} ${url} HTTP/1.1\r\nHost: ${targetHost}\r\nProxy-Authorization: Basic ${auth}\r\nUser-Agent: ${this.userAgent}\r\nReferer: ${this.entryUrl}\r\nAccept-Encoding: gzip, deflate\r\nConnection: close\r\n`;
          if (options.headers) {
            for (const [k, v] of Object.entries(options.headers)) reqStr += `${k}: ${v}\r\n`;
          }
          if (options.body) reqStr += `Content-Length: ${Buffer.byteLength(options.body)}\r\n`;
          reqStr += '\r\n';
          socket1.write(reqStr);
          if (options.body) socket1.write(options.body);
          this._readHttpResponse(socket1, (r) => done(null, r), (e) => done(e));
        }
      });

      connectReq.on('error', e => done(e));
      connectReq.on('timeout', () => done(new Error(`Step1 CONNECT timeout after ${timeout}ms`)));
      connectReq.end();
    });
  }

  _sendHttpOnSocket(socket, urlObj, options, resolve, reject) {
    const method = options.method || 'GET';
    const path = urlObj.pathname + urlObj.search;
    let reqStr = `${method} ${path} HTTP/1.1\r\nHost: ${urlObj.hostname}\r\nUser-Agent: ${this.userAgent}\r\nReferer: https://www.oiioii.ai/\r\nAccept-Encoding: gzip, deflate\r\nConnection: close\r\n`;
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) reqStr += `${k}: ${v}\r\n`;
    }
    if (options.body) reqStr += `Content-Length: ${Buffer.byteLength(options.body)}\r\n`;
    reqStr += '\r\n';
    socket.write(reqStr);
    if (options.body) socket.write(options.body);
    this._readHttpResponse(socket, resolve, reject);
  }

  _readHttpResponse(socket, resolve, reject) {
    const chunks = [];
    socket.on('data', d => chunks.push(d));
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const rawStr = raw.toString('binary');
      const headerEnd = rawStr.indexOf('\r\n\r\n');
      if (headerEnd === -1) { reject(new Error('No HTTP response headers')); return; }

      const headerStr = rawStr.substring(0, headerEnd);
      const statusMatch = headerStr.match(/HTTP\/\d\.\d (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;

      const respHeaders = {};
      headerStr.split('\r\n').slice(1).forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) respHeaders[line.substring(0, idx).toLowerCase().trim()] = line.substring(idx + 1).trim();
      });

      let buf = raw.slice(headerEnd + 4);

      if (respHeaders['transfer-encoding']?.includes('chunked')) {
        buf = this._decodeChunked(buf);
      }

      const enc = respHeaders['content-encoding'];
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf);
        else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
      } catch (e) { /* not compressed */ }

      resolve({ status, data: buf, headers: respHeaders });
    });
    socket.on('error', reject);
  }

  _decodeChunked(buf) {
    const parts = [];
    let pos = 0;
    const str = buf.toString('binary');
    while (pos < str.length) {
      const lineEnd = str.indexOf('\r\n', pos);
      if (lineEnd === -1) break;
      const size = parseInt(str.substring(pos, lineEnd), 16);
      if (size === 0) break;
      pos = lineEnd + 2;
      parts.push(Buffer.from(str.substring(pos, pos + size), 'binary'));
      pos += size + 2;
    }
    return Buffer.concat(parts);
  }

  async _requestWithRetry(url, options = {}, maxRetries = 5) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await this._requestViaRotatingProxy(url, options);
        if (result.status === 502 || result.status === 503) {
          if (i < maxRetries - 1) continue;
        }
        return result;
      } catch (e) {
        // 超时/隧道错误：换 IP 重试（每次新隧道 = 新出口 IP）
        lastErr = e;
        if (i === maxRetries - 1) throw e;
      }
    }
    throw lastErr || new Error('request failed after retries');
  }

  _request(url, options = {}) {
    if (this.useRotatingProxy) {
      return this._requestWithRetry(url, options);
    }
    return this._requestDirect(url, options);
  }

  // 本地直连请求（不走旋转代理）。用于静态资源（图片、tdc.js）：
  // 不带 session、不计频率限制、不绑 IP，直连最快且避免隧道卡死。
  _requestDirect(url, options = {}) {
    const timeout = options.timeout || 15000;
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const mod = urlObj.protocol === 'https:' ? https : http;
      const reqOpts = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        timeout,
        headers: {
          'User-Agent': this.userAgent,
          'Referer': 'https://www.oiioii.ai/',
          'Accept-Encoding': 'gzip, deflate',
          ...options.headers
        }
      };
      const req = mod.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = res.headers['content-encoding'];
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch (e) { /* not compressed */ }
          resolve({ status: res.statusCode, data: buf, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Direct request timeout after ${timeout}ms`)));
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  _requestText(url, options = {}) {
    return this._request(url, options).then(r => ({ ...r, data: r.data.toString('utf-8') }));
  }

  _parseJsonp(text) {
    const match = text.match(/\w+\((.+)\)$/s);
    if (!match) throw new Error('Invalid JSONP response');
    return JSON.parse(match[1]);
  }

  // Step 1: prehandle
  async prehandle() {
    const uaB64 = Buffer.from(this.userAgent).toString('base64');
    const callback = `_aq_${Date.now()}`;
    const params = new URLSearchParams({
      aid: this.aid,
      protocol: 'https',
      accver: '1',
      showtype: 'popup',
      ua: uaB64,
      noheader: '1',
      fb: '0',
      aged: '0',
      enableAged: '0',
      enableDarkMode: '0',
      grayscale: '1',
      clientype: '2',
      userLanguage: 'zh-cn',
      aidEncrypted: this.aidEncrypted,
      aidEncryptedType: this.aidEncryptedType,
      cap_cd: '',
      uid: '',
      lang: 'zh-cn',
      entry_url: this.entryUrl,
      elder_captcha: '0',
      js: '/tgJCap.f0ca357b.js',
      login_appid: '',
      wb: '2',
      subsid: String(this.subsid),
      callback,
      sess: ''
    });

    const url = `${this.baseUrl}/cap_union_prehandle?${params}`;
    console.log('[1/6] Prehandle...');
    const res = await this._requestText(url);
    if (this.debug) console.log(`  prehandle status: ${res.status}, body length: ${res.data.length}`);
    const json = this._parseJsonp(res.data);

    if (json.state !== 1) throw new Error(`Prehandle failed: ${JSON.stringify(json)}`);

    this.sess = json.sess;
    this.sid = json.sid;

    const commCfg = json.data.comm_captcha_cfg;
    this.powCfg = commCfg.pow_cfg;
    this.tdcPath = commCfg.tdc_path;

    const dynShow = json.data.dyn_show_info;
    this.bgUrl = dynShow.bg_elem_cfg.img_url;
    this.spriteUrl = dynShow.sprite_url;
    this.fgElemList = dynShow.fg_elem_list;

    console.log(`  sess: ${this.sess.substring(0, 30)}...`);
    console.log(`  tdc_path: ${this.tdcPath}`);
    console.log(`  fg_elems: ${this.fgElemList.length}`);

    if (this.debug) {
      fs.writeFileSync('./debug_prehandle.json', JSON.stringify(json, null, 2));
    }

    return json;
  }

  // Step 2: Download images
  // 图片是静态资源（不带 session/不计频率限制/不绑 IP），强制本地直连：
  // 直连最快，且避免旋转代理隧道传输大二进制时卡死。
  async downloadImages() {
    console.log('[2/6] Downloading images...');

    // 背景图 (img_index=1)
    const bgFullUrl = this.bgUrl.startsWith('http') ? this.bgUrl : `${this.baseUrl}${this.bgUrl}`;
    const bgRes = await this._requestDirect(bgFullUrl);
    const bgBuf = bgRes.data;

    // 精灵图 - 使用 prehandle 返回的 sprite_url
    const fgFullUrl = this.spriteUrl.startsWith('http') ? this.spriteUrl : `${this.baseUrl}${this.spriteUrl}`;
    const fgRes = await this._requestDirect(fgFullUrl);
    const fgBuf = fgRes.data;

    console.log(`  bg: ${bgBuf.length} bytes`);
    console.log(`  fg: ${fgBuf.length} bytes`);

    if (this.debug) {
      fs.writeFileSync('./debug_captcha_bg.png', bgBuf);
      fs.writeFileSync('./debug_captcha_sprite.png', fgBuf);
    }

    return { bgBuf, fgBuf };
  }

  // Step 3: NCC solve
  async solveGap(bgBuf, fgBuf) {
    console.log('[3/6] NCC solving gap position...');

    const pieceElem = this.fgElemList.find(e => e.move_cfg && e.move_cfg.data_type);
    if (!pieceElem) {
      throw new Error('Cannot find movable piece element in fg_elem_list');
    }

    const config = {
      sprite_pos: pieceElem.sprite_pos || [0, 0],
      size_2d: pieceElem.size_2d || [68, 68],
      init_pos: pieceElem.init_pos || [30, 161]
    };

    console.log(`  piece: sprite_pos=${config.sprite_pos}, size=${config.size_2d}, init=${config.init_pos}`);

    const solver = new NCCSolver();
    const result = await solver.solve(bgBuf, fgBuf, config);

    console.log(`  gap_x=${result.gapX}, dx=${result.dx}, confidence=${result.confidence.toFixed(4)}`);

    return { ...result, elemId: pieceElem.id || 1 };
  }

  // Step 4: Solve PoW
  solvePow() {
    console.log('[4/6] Solving PoW...');
    const { prefix, md5: targetMd5 } = this.powCfg;
    const startTime = Date.now();
    let nonce = 0;

    while (nonce < 1000000) {
      const candidate = prefix + nonce;
      const hash = crypto.createHash('md5').update(candidate).digest('hex');
      if (hash === targetMd5) {
        const elapsed = Date.now() - startTime;
        console.log(`  Found nonce=${nonce} in ${elapsed}ms`);
        return { powAnswer: candidate, powCalcTime: elapsed };
      }
      nonce++;
    }

    throw new Error('PoW not solved within 1M iterations');
  }

  // Step 5: Execute TDC
  async executeTDC(dx) {
    console.log('[5/6] Executing tdc.js in jsdom...');

    const tdcUrl = `${this.baseUrl}${this.tdcPath}`;
    console.log(`  Fetching: ${tdcUrl}`);
    const tdcSource = await fetchUrl(tdcUrl);
    console.log(`  tdc.js size: ${tdcSource.length}`);

    const duration = 800 + Math.floor(Math.random() * 1200);
    const trajectory = generateTrajectory(dx, duration);

    console.log(`  trajectory: ${trajectory.length} points, duration=${duration}ms`);

    const result = await executeTDC(tdcSource, trajectory, this.sid);

    console.log(`  collect length: ${(result.collect || '').length}`);
    console.log(`  eks: ${result.eks ? result.eks.substring(0, 40) + '...' : '(none)'}`);

    return { ...result, tlg: duration };
  }

  // Step 6: Submit verify
  async verify(solveResult, powResult, tdcResult) {
    console.log('[6/6] Submitting verify...');

    // 构造 ans - 正确的 JSON 数组格式
    const ans = JSON.stringify([{
      elem_id: solveResult.elemId,
      type: 'DynAnswerType_POS',
      data: `${solveResult.gapX},${solveResult.gapY}`
    }]);

    const callback = `_aq_${Date.now()}`;
    const params = new URLSearchParams({
      aid: this.aid,
      protocol: 'https',
      accver: '1',
      showtype: 'popup',
      ua: Buffer.from(this.userAgent).toString('base64'),
      noheader: '1',
      fb: '0',
      aged: '0',
      enableAged: '0',
      enableDarkMode: '0',
      grayscale: '1',
      clientype: '2',
      userLanguage: 'zh-cn',
      aidEncrypted: this.aidEncrypted,
      aidEncryptedType: this.aidEncryptedType,
      cap_cd: '',
      uid: '',
      lang: 'zh-cn',
      entry_url: this.entryUrl,
      elder_captcha: '0',
      js: '/tgJCap.f0ca357b.js',
      login_appid: '',
      wb: '2',
      subsid: String(this.subsid),
      callback,
      sess: this.sess
    });

    const body = new URLSearchParams({
      ans,
      sess: this.sess,
      pow_answer: powResult.powAnswer,
      pow_calc_time: String(powResult.powCalcTime),
      collect: tdcResult.collect || '',
      tlg: String(tdcResult.tlg),
      eks: tdcResult.eks || ''
    });

    const url = `${this.baseUrl}/cap_union_new_verify?${params}`;
    const res = await this._requestText(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    let json;
    try {
      json = this._parseJsonp(res.data);
    } catch (e) {
      try { json = JSON.parse(res.data); } catch (e2) {
        throw new Error(`Invalid verify response: ${res.data.substring(0, 200)}`);
      }
    }

    console.log(`  verify result: errorCode=${json.errorCode}, ticket=${json.ticket ? 'YES' : 'NO'}`);

    if (this.debug) {
      fs.writeFileSync('./debug_verify_response.json', JSON.stringify(json, null, 2));
    }

    return {
      ok: json.errorCode === 0 || !!json.ticket,
      ticket: json.ticket || '',
      randstr: json.randstr || '',
      errorCode: json.errorCode,
      errorMsg: json.errMsg || ''
    };
  }

  // 完整流程
  async run() {
    console.log('=== TCaptcha Cracker (jsdom + NCC) ===\n');

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`--- Attempt ${attempt}/${this.maxRetries} ---\n`);

        // 1. prehandle
        await this.prehandle();

        // 2. download images
        const { bgBuf, fgBuf } = await this.downloadImages();

        // 3. NCC solve
        const solveResult = await this.solveGap(bgBuf, fgBuf);

        if (solveResult.confidence < 0.3) {
          console.log(`  [WARN] Low confidence ${solveResult.confidence.toFixed(4)}, retrying...`);
          this.subsid++;
          continue;
        }

        // 4. PoW
        const powResult = this.solvePow();

        // 5. TDC
        const tdcResult = await this.executeTDC(solveResult.dx);

        // 6. Verify
        const result = await this.verify(solveResult, powResult, tdcResult);

        if (result.ok) {
          console.log('\n=== SUCCESS ===');
          console.log(`  ticket: ${result.ticket}`);
          console.log(`  randstr: ${result.randstr}`);
          return result;
        }

        console.log(`\n  [FAIL] errorCode=${result.errorCode}, msg=${result.errorMsg}`);
        this.subsid++;

      } catch (err) {
        console.error(`\n  [ERROR] ${err.message}`);
        if (this.debug) console.error(err.stack);
        this.subsid++;
      }
    }

    throw new Error(`Failed after ${this.maxRetries} attempts`);
  }
}

module.exports = { TCaptchaCracker };

// CLI
if (require.main === module) {
  const cracker = new TCaptchaCracker({
    aid: process.argv[2] || '194025396',
    entryUrl: process.argv[3] || 'https://console.pixmax.ai/',
    debug: true
  });

  cracker.run()
    .then(result => {
      console.log('\nFinal result:');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('\nFatal:', err.message);
      process.exit(1);
    });
}
