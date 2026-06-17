#!/usr/bin/env node
/**
 * a_bogus 签名 RPC 服务
 *
 * 在本地启动一个 HTTP 服务，提供 a_bogus 签名能力给 Python 端调用。
 *
 * 启动：
 *   node signer-rpc.mjs --port 17890 --platform dola
 *
 * 接口：
 *   GET  /health                          → {"ok": true, "platform": "dola"}
 *   POST /sign  { url, method?, body? }   → {"url": "...&a_bogus=..."}
 *   GET  /mstoken                         → {"token": "..."}
 *   POST /reload  { platform? }           → {"ok": true}  (重新初始化签名器，可换平台)
 *
 * 该服务无鉴权，仅监听 127.0.0.1，由 unified_server 的子进程方式拉起。
 */

import http from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { port: 17890, platform: 'dola', host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--port') { out.port = parseInt(v, 10); i++; }
    else if (k === '--platform') { out.platform = v; i++; }
    else if (k === '--host') { out.host = v; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);

process.on('uncaughtException', (err) => {
  console.error('[signer-rpc] uncaught:', err);
});

const bdmsSignerPath = pathToFileURL(path.join(__dir, 'src', 'bdms-signer.mjs')).href;
const mstokenPath = pathToFileURL(path.join(__dir, 'src', 'mstoken.mjs')).href;

const { initSigner, addABogus, generateABogus, resetSigner, getLatestMsToken } =
  await import(bdmsSignerPath);
const { bootstrapMsToken, getMsToken, setMsToken } = await import(mstokenPath);

let currentPlatform = args.platform;

async function init(platform) {
  resetSigner();
  await initSigner('', { platform });
  await bootstrapMsToken();
  currentPlatform = platform;
  console.error(`[signer-rpc] initialized for platform=${platform}`);
}

await init(currentPlatform);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, platform: currentPlatform });
    }

    if (req.method === 'GET' && url.pathname === '/mstoken') {
      const tok = getMsToken() || getLatestMsToken() || null;
      return sendJson(res, 200, { token: tok });
    }

    if (req.method === 'POST' && url.pathname === '/mstoken') {
      const body = await readBody(req);
      if (body.token) setMsToken(body.token);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/sign') {
      const body = await readBody(req);
      if (!body.url) return sendJson(res, 400, { error: 'missing url' });
      const method = (body.method || 'POST').toUpperCase();
      const reqBody = body.body == null
        ? '{}'
        : (typeof body.body === 'string' ? body.body : JSON.stringify(body.body));
      const signed = addABogus(body.url, method, reqBody);
      const aBogus = generateABogus(body.url, method, reqBody);
      return sendJson(res, 200, {
        url: signed,
        a_bogus: aBogus,
        msToken: getMsToken() || getLatestMsToken() || null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/reload') {
      const body = await readBody(req);
      const platform = body.platform || currentPlatform;
      await init(platform);
      return sendJson(res, 200, { ok: true, platform });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[signer-rpc] error:', e);
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(args.port, args.host, () => {
  const addr = server.address();
  console.error(`[signer-rpc] listening on http://${addr.address}:${addr.port} platform=${currentPlatform}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
