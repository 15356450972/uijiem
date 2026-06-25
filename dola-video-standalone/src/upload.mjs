// Dola 图片上传模块
// 协议流程：prepare_upload → ApplyImageUpload → Upload to TOS → CommitImageUpload
//
// 依赖 client.mjs 的 signedFetch 来处理 msToken + a_bogus 签名

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { signedFetch, headersFor, getPlatformOrigin } from './client.mjs';

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s;

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function extFromMime(mime) {
  const normalized = String(mime || '').trim().toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/bmp') return '.bmp';
  const subtype = normalized.startsWith('image/') ? normalized.slice('image/'.length) : '';
  return subtype ? `.${subtype.replace(/[^a-z0-9.+-]/g, '')}` : '.png';
}

async function loadImageInput(imagePath) {
  const raw = String(imagePath || '').trim();
  if (!raw) throw new Error('imagePath is empty');

  const dataUrlMatch = raw.match(DATA_URL_RE);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1];
    const imageBytes = Buffer.from(dataUrlMatch[2], 'base64');
    return {
      imageBytes,
      ext: extFromMime(mime),
      name: `inline${extFromMime(mime)}`,
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    const res = await fetchWithTimeout(raw, {
      method: 'GET',
      headers: { 'accept': 'image/*,*/*;q=0.8' },
    }, 45000);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Download image failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const mime = (res.headers.get('content-type') || '').split(';', 1)[0].trim();
    const imageBytes = Buffer.from(await res.arrayBuffer());
    const urlPath = new URL(raw).pathname;
    const fallbackExt = extFromMime(mime);
    const baseName = path.basename(urlPath || '') || `remote${fallbackExt}`;
    const ext = path.extname(baseName) || fallbackExt;
    const name = path.extname(baseName) ? baseName : `${baseName}${ext}`;
    return { imageBytes, ext, name };
  }

  return {
    imageBytes: fs.readFileSync(raw),
    ext: path.extname(raw) || '.png',
    name: path.basename(raw),
  };
}

// AWS SigV4 签名实现（用于 ImageX API）
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSha256(Buffer.from('AWS4' + secretKey), dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function awsSigV4({ method, host, path: reqPath, query, body, accessKey, secretKey, sessionToken, region = 'us-east-1', service = 'imagex' }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);

  const signedHeaderNames = ['x-amz-date', 'x-amz-security-token'];
  signedHeaderNames.sort();
  const headerMap = {
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
  };

  const canonicalHeaders = signedHeaderNames.map(h => `${h}:${headerMap[h]}\n`).join('');
  const signedHeadersStr = signedHeaderNames.join(';');

  // Canonical query string: params sorted by key name
  let canonicalQs = '';
  if (query) {
    const sorted = Object.entries(query).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    canonicalQs = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  const payloadHash = sha256Hex(body || '');

  const canonicalRequest = [
    method,
    reqPath || '/',
    canonicalQs,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  return {
    authorization,
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
  };
}

// 从 ImageX host 推导 region（与 Python 版 _imagex_region_for_host 一致）
// 例如 imagex-ap-southeast-1.bytevcloudapi.com -> ap-southeast-1
function imagexRegionForHost(host) {
  const marker = 'imagex-';
  const suffix = '.bytevcloudapi.com';
  if (host && host.startsWith(marker) && host.endsWith(suffix)) {
    const region = host.slice(marker.length, -suffix.length);
    if (region) return region;
  }
  return 'us-east-1';
}

// Step 1: prepare_upload — 获取 STS 临时凭证
export async function prepareUpload({ tenantId = '5', sceneId = '4', resourceType = 2 } = {}) {
  const result = await signedFetch('/alice/resource/prepare_upload', {
    body: { tenant_id: String(tenantId), scene_id: String(sceneId), resource_type: resourceType },
  });

  if (result.code !== 0) {
    throw new Error(`prepare_upload failed: code=${result.code} msg=${result.msg}`);
  }

  return result.data;
}

// Step 2: ApplyImageUpload — 获取上传地址
export async function applyImageUpload({ serviceId, fileSize, ext = '.png', authToken, imagexHost }) {
  const { access_key, secret_key, session_token } = authToken;
  const uploadHost = imagexHost || 'image-upload-sg.ciciai.com';
  const region = imagexRegionForHost(uploadHost);
  const randomSuffix = crypto.randomBytes(5).toString('hex');

  const queryParams = {
    Action: 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: serviceId,
    FileSize: String(fileSize),
    FileExtension: ext,
    s: randomSuffix,
  };

  const sigHeaders = awsSigV4({
    method: 'GET',
    host: uploadHost,
    path: '/',
    query: queryParams,
    accessKey: access_key,
    secretKey: secret_key,
    sessionToken: session_token,
    region,
  });

  const qs = new URLSearchParams(queryParams).toString();
  const url = `https://${uploadHost}/?${qs}`;

  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      ...sigHeaders,
      'accept': '*/*',
      'origin': getPlatformOrigin(),
      'referer': getPlatformOrigin() + '/',
    },
  }, 30000);

  const data = await res.json();
  if (!data.Result?.UploadAddress) {
    throw new Error(`ApplyImageUpload failed: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const addr = data.Result.UploadAddress;
  const storeInfo = addr.StoreInfos[0];

  return {
    uri: storeInfo.StoreUri,
    auth: storeInfo.Auth,
    uploadId: storeInfo.UploadID,
    uploadHost: addr.UploadHosts[0],
    uploadHosts: addr.UploadHosts || [addr.UploadHosts[0]],
    sessionKey: addr.SessionKey,
  };
}

// Step 3: Upload to TOS — 上传图片字节
export async function uploadToTos({ uploadHost, uri, auth, bytes }) {
  const url = `https://${uploadHost}/upload/v1/${uri}`;

  // CRC32 计算（浏览器端会带 content-crc32 头）
  const crc32 = crc32Buf(bytes);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'authorization': auth,
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${path.basename(uri)}"`,
      'content-crc32': crc32,
      'origin': getPlatformOrigin(),
      'referer': getPlatformOrigin() + '/',
    },
    body: bytes,
  }, 45000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TOS upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  return await res.json();
}

// CRC32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32Buf(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16);
}

// Step 4: CommitImageUpload — 提交上传
export async function commitImageUpload({ serviceId, sessionKey, authToken, imagexHost }) {
  const { access_key, secret_key, session_token } = authToken;
  const uploadHost = imagexHost || 'image-upload-sg.ciciai.com';
  const region = imagexRegionForHost(uploadHost);

  const queryParams = {
    Action: 'CommitImageUpload',
    Version: '2018-08-01',
    ServiceId: serviceId,
  };

  const bodyStr = JSON.stringify({ SessionKey: sessionKey });

  const sigHeaders = awsSigV4({
    method: 'POST',
    host: uploadHost,
    path: '/',
    query: queryParams,
    body: bodyStr,
    accessKey: access_key,
    secretKey: secret_key,
    sessionToken: session_token,
    region,
  });

  const qs = new URLSearchParams(queryParams).toString();
  const url = `https://${uploadHost}/?${qs}`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      ...sigHeaders,
      'content-type': 'application/json',
      'accept': '*/*',
      'origin': getPlatformOrigin(),
      'referer': getPlatformOrigin() + '/',
    },
    body: bodyStr,
  }, 30000);

  const data = await res.json();
  if (!data.Result) {
    throw new Error(`CommitImageUpload failed: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const img = data.Result.PluginResult?.[0] || {};
  return {
    uri: img.ImageUri || data.Result.UploadAddress?.StoreInfos?.[0]?.StoreUri || '',
    width: img.ImageWidth || 0,
    height: img.ImageHeight || 0,
    md5: img.ImageMd5 || '',
    format: img.ImageFormat || '',
  };
}

// 完整的图片上传流程（4 步合一）
export async function uploadImage({ imagePath, botId, conversationId = '', sectionId = '', sceneId = 4, debug = false }) {
  const { imageBytes, ext, name } = await loadImageInput(imagePath);

  if (debug) console.log(`[upload] file: ${name} (${imageBytes.length} bytes)`);

  // Step 1
  if (debug) console.log('[upload] Step 1: prepare_upload...');
  const prep = await prepareUpload({ tenantId: '5', sceneId: String(sceneId), resourceType: 2 });
  if (debug) console.log(`  service_id: ${prep.service_id}, host: ${prep.upload_host}`);

  // Step 2
  if (debug) console.log('[upload] Step 2: ApplyImageUpload...');
  const apply = await applyImageUpload({
    serviceId: prep.service_id,
    fileSize: imageBytes.length,
    ext,
    authToken: prep.upload_auth_token,
    imagexHost: prep.upload_host,
  });
  if (debug) console.log(`  uri: ${apply.uri}`);
  if (debug) console.log(`  uploadHost: ${apply.uploadHost}`);

  // Step 3: try each upload host until one succeeds
  // Add known working hosts as fallback
  const knownHosts = ['tos-sg16-share.vodupload.com', 'tos-my16-share.vodupload.com'];
  const allHosts = [...new Set([...apply.uploadHosts, ...knownHosts])];
  if (debug) console.log('[upload] Step 3: Upload to TOS...');
  let uploaded = false;
  for (const host of allHosts) {
    try {
      if (debug) console.log(`  trying host: ${host}`);
      await uploadToTos({
        uploadHost: host,
        uri: apply.uri,
        auth: apply.auth,
        bytes: imageBytes,
      });
      uploaded = true;
      if (debug) console.log('  done');
      break;
    } catch (e) {
      if (debug) console.log(`  failed: ${e.message}`);
    }
  }
  if (!uploaded) {
    throw new Error(`All upload hosts failed: ${allHosts.join(', ')}`);
  }

  // Step 4
  if (debug) console.log('[upload] Step 4: CommitImageUpload...');
  const commit = await commitImageUpload({
    serviceId: prep.service_id,
    sessionKey: apply.sessionKey,
    authToken: prep.upload_auth_token,
    imagexHost: prep.upload_host,
  });
  if (debug) console.log(`  uri: ${commit.uri}, size: ${commit.width}x${commit.height}`);

  const finalUri = commit.uri || apply.uri;

  return {
    uri: finalUri,
    width: commit.width || 800,
    height: commit.height || 600,
    name,
    identifier: crypto.randomUUID(),
    localMessageId: crypto.randomUUID(),
  };
}
