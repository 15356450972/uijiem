import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CookieJar, assertSuccess, request, sleep } from './http.js';

const BASE_URL = 'https://www.oreateai.com';
const CHAT_HOME_URL = `${BASE_URL}/home/chat/aiVideo`;
const TARGET_MODELS = new Set(['Seedance 2.0 Mini', 'Seedance 2.0', 'Seedance 2.0 Fast']);
const TARGET_SCENES = new Set(['text_or_image', 'reference']);
const CHUNK_SIZE = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);

const MIME_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
};

const asArray = (value) => Array.isArray(value) ? value : [];
const unique = (values) => [...new Set(values)];
const extensionOf = (filePath) => path.extname(filePath).slice(1).toLowerCase();
const baseNameOf = (filePath) => path.basename(filePath, path.extname(filePath));
const chatSessionUrl = (chatId) => `${CHAT_HOME_URL}/${encodeURIComponent(String(chatId || ''))}`;
const clientHintsFor = (userAgent = '') => {
  const major = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(userAgent)?.[1];
  const platform = /Windows/i.test(userAgent) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(userAgent) ? 'macOS'
      : /Linux/i.test(userAgent) ? 'Linux' : '';
  return {
    ...(major ? { 'sec-ch-ua': `"Not;A=Brand";v="8", "Chromium";v="${major}", "${/Edg\//.test(userAgent) ? 'Microsoft Edge' : 'Google Chrome'}";v="${major}"` } : {}),
    'sec-ch-ua-mobile': '?0',
    ...(platform ? { 'sec-ch-ua-platform': `"${platform}"` } : {}),
  };
};
const browserFetchHeaders = ({ locale, userAgent, referer, accept = 'application/json, text/plain, */*' }) => ({
  Accept: accept,
  'Accept-Language': locale === 'zh-CN' ? 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6' : `${locale},en;q=0.8`,
  'Cache-Control': accept === 'text/event-stream' ? 'no-cache' : 'no-cache, no-store',
  'Client-Type': 'pc',
  Connection: 'keep-alive',
  Locale: locale,
  Pragma: 'no-cache',
  Referer: referer,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': userAgent,
  ...clientHintsFor(userAgent),
});
const parseRestrictions = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw new Error('OreateAI scene restrictions are invalid JSON'); }
};

const localized = (value, locale = 'zh-CN') => {
  if (!value || typeof value !== 'object') return String(value || '');
  const key = locale === 'zh-CN' ? 'zh' : locale === 'zh-TW' ? 'zh-TW' : locale.split('-')[0];
  return value[key] || value.en || Object.values(value)[0] || '';
};

const normalizeSlotRules = (restrictions) => ({
  inputSlots: restrictions.inputSlots || {},
  inputGroups: asArray(restrictions.inputGroups),
  slotRules: asArray(restrictions.slotRules),
});

const combinationsFor = (model, sceneId) => {
  const source = sceneId === 'reference' ? model.pointCostReference : model.pointCostImage;
  return asArray(source).map((item) => ({
    duration: Number(item.duration),
    resolution: String(item.resolution),
    audio: item.audio === undefined ? null : Boolean(item.audio),
    aiType: Number(item.aiType),
    point: Number(item.point),
    ...(item.refDuration ? { refDuration: String(item.refDuration) } : {}),
  })).filter((item) => Number.isFinite(item.aiType));
};

export const buildVideoCapabilities = (modelsPayload, scenesPayload, { locale = 'zh-CN' } = {}) => {
  const models = asArray(modelsPayload?.data?.models ?? modelsPayload?.models)
    .filter((model) => TARGET_MODELS.has(model.modelName));
  const modelMap = new Map(models.map((model) => [model.modelName, model]));
  const scenes = asArray(scenesPayload?.data?.scenes ?? scenesPayload?.scenes)
    .filter((scene) => TARGET_SCENES.has(scene.sceneId));

  const result = [];
  for (const scene of scenes) {
    for (const factory of asArray(scene.factory)) {
      for (const sceneModel of asArray(factory.models)) {
        const model = modelMap.get(sceneModel.modelName);
        if (!model) continue;
        const combinations = combinationsFor(model, scene.sceneId);
        if (!combinations.length) continue;
        const restrictions = parseRestrictions(sceneModel.restrictions);
        result.push({
          modelName: model.modelName,
          scene: scene.sceneId,
          sceneName: localized(scene.sceneName, locale),
          description: localized(model.description, locale),
          icon: model.modelIcon || factory.modelIcon || '',
          ratios: unique(asArray(model.videoSize).map((item) => String(item.ratio)).filter(Boolean)),
          resolutions: unique(combinations.map((item) => item.resolution)),
          durations: unique(combinations.map((item) => item.duration)).sort((a, b) => a - b),
          audioValues: model.supportAudio ? [false, true] : [false],
          supportModifySize: Boolean(model.supportModifySize),
          promptMaxChars: Number(restrictions.promptMaxChars || 0) || null,
          restrictions: normalizeSlotRules(restrictions),
          combinations,
        });
      }
    }
  }

  return {
    models: unique(result.map((item) => item.modelName)),
    scenes: scenes.map((scene) => ({ id: scene.sceneId, name: localized(scene.sceneName, locale) })),
    capabilities: result,
  };
};

export const createUploadParts = (size, chunkSize = CHUNK_SIZE) => {
  const parts = [];
  for (let start = 0; start < size; start += chunkSize) {
    parts.push({ start, stop: Math.min(start + chunkSize, size) - 1, totalSize: size });
  }
  return parts;
};

const parseRange = (value) => {
  const match = /bytes=0-(\d+)/i.exec(String(value || ''));
  return match ? Number(match[1]) : -1;
};

const parseDurationRange = (value) => {
  const match = /^(\d+)-(\d+)$/.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const countAssets = (assets) => ({
  image: assets.filter((asset) => asset.kind === 'image').length,
  video: assets.filter((asset) => asset.kind === 'video').length,
});

const compareNumber = (actual, expression) => {
  const match = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(String(expression).trim());
  if (!match) return false;
  const expected = Number(match[2]);
  return ({ '>=': actual >= expected, '<=': actual <= expected, '==': actual === expected,
    '!=': actual !== expected, '>': actual > expected, '<': actual < expected })[match[1]];
};

const effectiveSlots = (restrictions, counts) => {
  const slots = structuredClone(restrictions.inputSlots || {});
  for (const rule of restrictions.slotRules || []) {
    const applies = Object.entries(rule.when || {}).every(([slot, expression]) => compareNumber(counts[slot] || 0, expression));
    if (!applies) continue;
    for (const [target, value] of Object.entries(rule.then || {})) {
      const [slot, field] = target.split('.');
      slots[slot] ||= {};
      slots[slot][field] = value;
    }
  }
  return slots;
};

const validateAssetCounts = (capability, assets) => {
  const counts = countAssets(assets);
  const slots = effectiveSlots(capability.restrictions, counts);
  for (const [slot, limits] of Object.entries(slots)) {
    const count = counts[slot] || 0;
    if (limits.min !== undefined && count < limits.min) throw new Error(`${slot} 素材至少需要 ${limits.min} 个`);
    if (limits.max !== undefined && count > limits.max) throw new Error(`${slot} 素材最多允许 ${limits.max} 个`);
  }
  for (const group of capability.restrictions.inputGroups || []) {
    const count = asArray(group.slots).reduce((sum, slot) => sum + (counts[slot] || 0), 0);
    if (group.min !== undefined && count < group.min) throw new Error(`参考素材至少需要 ${group.min} 个`);
    if (group.max !== undefined && count > group.max) throw new Error(`参考素材最多允许 ${group.max} 个`);
  }
  if (capability.scene === 'reference' && assets.length === 0) throw new Error('reference 场景至少需要一个本地素材');
};

export const inspectLocalAssets = async (items = []) => {
  const assets = [];
  for (const item of items) {
    const filePath = typeof item === 'string' ? item : item?.path;
    if (!filePath || !path.isAbsolute(filePath)) throw new Error('素材必须是绝对本地文件路径');
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) throw new Error(`素材不可读或为空：${filePath}`);
    await fsp.access(filePath, fs.constants.R_OK);
    const ext = extensionOf(filePath);
    const kind = IMAGE_EXTENSIONS.has(ext) ? 'image' : VIDEO_EXTENSIONS.has(ext) ? 'video' : null;
    if (!kind) throw new Error(`不支持的素材格式：.${ext || 'unknown'}`);
    const durationSec = Number(typeof item === 'object' ? item.durationSec : 0) || 0;
    assets.push({ path: filePath, ext, kind, size: stat.size, filename: baseNameOf(filePath), durationSec });
  }
  return assets;
};

const selectCombination = (capability, options, assets) => {
  const duration = Number(options.duration);
  const resolution = String(options.resolution);
  const audio = Boolean(options.audio);
  let candidates = capability.combinations.filter((item) => item.duration === duration && item.resolution === resolution);
  if (capability.scene !== 'reference') candidates = candidates.filter((item) => item.audio === null || item.audio === audio);
  if (capability.scene === 'reference') {
    const totalVideoDuration = Math.ceil(assets.filter((asset) => asset.kind === 'video')
      .reduce((sum, asset) => sum + asset.durationSec, 0));
    const slots = capability.restrictions.inputSlots || {};
    const videoLimits = slots.video || {};
    if (assets.some((asset) => asset.kind === 'video' && asset.durationSec <= 0)) {
      throw new Error('视频参考素材缺少 durationSec，无法按服务端限制校验');
    }
    if (videoLimits.totalDurationSecMin !== undefined && totalVideoDuration > 0 && totalVideoDuration < videoLimits.totalDurationSecMin) {
      throw new Error(`参考视频总时长不能少于 ${videoLimits.totalDurationSecMin} 秒`);
    }
    if (videoLimits.totalDurationSecMax !== undefined && totalVideoDuration > videoLimits.totalDurationSecMax) {
      throw new Error(`参考视频总时长不能超过 ${videoLimits.totalDurationSecMax} 秒`);
    }
    const ranged = candidates.filter((item) => {
      const range = parseDurationRange(item.refDuration);
      return range && totalVideoDuration >= range[0] && totalVideoDuration <= range[1];
    });
    candidates = ranged.length ? ranged : candidates;
  }
  const combination = candidates[0];
  if (!combination) throw new Error('模型参数组合不在 OreateAI 动态配置中');
  return combination;
};

export const validateVideoRequest = async (capabilitySet, options) => {
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const capability = capabilitySet.capabilities.find((item) => item.modelName === options.modelName && item.scene === options.scene);
  if (!capability) throw new Error('模型或场景不在 OreateAI 动态能力矩阵中');
  if (!capability.ratios.includes(String(options.ratio))) throw new Error('视频比例不受当前模型支持');
  if (capability.promptMaxChars && prompt.length > capability.promptMaxChars) throw new Error(`提示词不能超过 ${capability.promptMaxChars} 个字符`);
  if (!capability.audioValues.includes(Boolean(options.audio))) throw new Error('当前模型不支持所选音频参数');
  const assets = await inspectLocalAssets(options.assets || []);
  validateAssetCounts(capability, assets);
  if (options.scene === 'text_or_image' && assets.some((asset) => asset.kind !== 'image')) {
    throw new Error('text_or_image 场景只接受图片素材');
  }
  if (options.scene === 'text_or_image' && assets.length > 1) throw new Error('text_or_image 场景最多接受一张图片');
  const combination = selectCombination(capability, options, assets);
  return { prompt, capability, assets, combination };
};

const rawRequest = ({ url, method = 'GET', headers = {}, body, timeout = 30_000 }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const req = https.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port || 443,
    path: `${target.pathname}${target.search}`, method,
    headers: { ...headers, ...(payload ? { 'Content-Length': String(payload.length) } : {}) }, timeout,
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const retry = async (operation, attempts = 3, shouldRetry = () => true) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); } catch (error) {
      lastError = error;
      if (attempt < attempts && shouldRetry(error)) await sleep(300 * attempt);
      else break;
    }
  }
  throw lastError;
};

export const createSseParser = (onEvent) => {
  let buffer = '';
  const dispatch = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { throw new Error('OreateAI SSE 返回了无效 JSON'); }
    onEvent(payload);
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, index);
        const separator = /^\r\n\r\n/.test(buffer.slice(index)) ? 4 : 2;
        buffer = buffer.slice(index + separator);
        dispatch(block);
      }
    },
    end() { if (buffer.trim()) dispatch(buffer); buffer = ''; },
  };
};

export const extractVideoResult = (generatingEvent) => {
  let result = generatingEvent?.data?.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { throw new Error('OreateAI 视频结果不是有效 JSON'); }
  }
  const files = asArray(result?.metadata?.files);
  const video = files.find((item) => item?.file_type_ext === 'aiVideo' && /^https:\/\//.test(item.url || ''));
  if (!video) throw new Error('OreateAI 完成事件中没有有效 aiVideo 文件');
  return { url: video.url, file: video, metadata: result.metadata };
};

const isHistoryVideoUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'cdn.oreateai.com'
      && /^\/aivideo\/videodownload\/\d+\.mp4$/i.test(url.pathname);
  } catch {
    return false;
  }
};

export const inspectHistoryVideoOutcome = (historyPayload) => {
  const messages = asArray(historyPayload?.data?.messageList ?? historyPayload?.messageList);
  for (const message of [...messages].reverse()) {
    if (message?.role !== 'assistant' || Number(message?.type) !== 9 || typeof message?.content !== 'string') continue;
    const tags = message.content.match(/<video\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const match = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tag);
      const url = match?.[1] || match?.[2] || '';
      if (!isHistoryVideoUrl(url)) continue;
      return {
        status: 'completed',
        result: {
          url,
          file: { file_type_ext: 'aiVideo', url, source: 'history-message' },
          metadata: { source: 'history-message', messageId: String(message.messageID || '') },
        },
      };
    }
    const content = message.content.trim();
    if (content.length > 0 && content.length <= 500 && /\b(?:failed|failure|error)\b|失败|错误|异常/i.test(content)) {
      return { status: 'failed' };
    }
  }
  return { status: 'pending' };
};

export const extractHistoryVideoResult = (historyPayload) => {
  const outcome = inspectHistoryVideoOutcome(historyPayload);
  if (outcome.status === 'completed') return outcome.result;
  throw new Error('OreateAI 历史消息中没有有效 aiVideo 文件');
};

const uploadObject = async ({ asset, bucket, objectPath, token, onProgress }) => {
  const mime = MIME_TYPES[asset.ext] || 'application/octet-stream';
  const initUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(objectPath)}`;
  const initialized = await rawRequest({
    url: initUrl, method: 'POST', body: Buffer.from('{}'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': mime },
  });
  if (initialized.status < 200 || initialized.status >= 300 || !initialized.headers.location) {
    throw new Error(`GCS resumable 初始化失败（HTTP ${initialized.status}）`);
  }
  const location = initialized.headers.location;
  const file = await fsp.open(asset.path, 'r');
  try {
    if (asset.size < CHUNK_SIZE) {
      const body = await file.readFile();
      const response = await retry(() => rawRequest({ url: location, method: 'PUT', body, headers: { 'Content-Type': mime } }));
      if (response.status < 200 || response.status >= 300) throw new Error(`GCS 上传失败（HTTP ${response.status}）`);
      onProgress?.({ loaded: asset.size, total: asset.size });
      return;
    }
    for (const part of createUploadParts(asset.size)) {
      const { start, stop } = part;
      const body = Buffer.alloc(stop - start + 1);
      await file.read(body, 0, body.length, start);
      const response = await retry(async () => {
        const uploaded = await rawRequest({
          url: location, method: 'PUT', body,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${stop}/${asset.size}` },
        });
        const expectedFinal = stop === asset.size - 1;
        if ((expectedFinal && uploaded.status >= 200 && uploaded.status < 300) || (!expectedFinal && uploaded.status === 308)) return uploaded;
        if (uploaded.status >= 500 || uploaded.status === 408 || uploaded.status === 429) throw new Error(`GCS 分片暂时失败（HTTP ${uploaded.status}）`);
        throw new Error(`GCS 分片失败（HTTP ${uploaded.status}）`);
      });
      if (response.status === 308 && parseRange(response.headers.range) < stop) {
        throw new Error('GCS 未确认完整分片范围');
      }
      onProgress?.({ loaded: stop + 1, total: asset.size });
    }
  } finally {
    await file.close();
  }
};

const normalizeUploadTokens = (payload) => {
  const data = payload?.data ?? payload ?? {};
  if (data.KeyList && typeof data.KeyList === 'object') return data.KeyList;
  const keys = data.keyList || {};
  return Object.fromEntries(Object.entries(keys).map(([name, objectPath]) => [name, {
    bucket: data.bucket || '', objectPath, sessionkey: data.sessionkey || '',
  }]));
};

const assetAttachment = (asset, objectPath) => ({
  bos_url: objectPath, bosUrl: objectPath, docId: undefined,
  doc_title: asset.filename, doc_type: asset.ext, size: asset.size,
  flag: 'upload', type: 'file', status: 1,
  ...(asset.durationSec > 0 ? { videoDurationSec: asset.durationSec } : {}),
});

const buildVideoConfig = ({ modelName, scene, ratio, resolution, duration, audio }, assets, uploaded, combination) => {
  const common = { modelName, ratio, resolution: String(resolution), duration: Number(duration), isAudio: Boolean(audio), aiType: combination.aiType, scene };
  if (scene === 'text_or_image') return { ...common, textOrImage: { image: uploaded[0]?.objectPath || '' } };
  const referenceImages = [];
  const referenceVideos = [];
  for (let index = 0; index < assets.length; index += 1) {
    (assets[index].kind === 'image' ? referenceImages : referenceVideos).push(uploaded[index].objectPath);
  }
  const totalVideoDuration = Math.ceil(assets.filter((asset) => asset.kind === 'video').reduce((sum, asset) => sum + asset.durationSec, 0));
  return { ...common, reference: {
    referenceImages, referenceVideos, refDuration: combination.refDuration || '',
    refTotalDuration: totalVideoDuration, keepOriginalSound: undefined,
  } };
};

const streamGeneration = ({ jar, headers, body, timeout, onEvent, signal }) => new Promise((resolve, reject) => {
  const url = new URL(`${BASE_URL}/oreate/sse/stream`);
  const payload = Buffer.from(JSON.stringify(body));
  let ended = false;
  let latestGenerating = null;
  let idleTimer;
  const resetIdle = (req) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => req.destroy(new Error('OreateAI SSE 40 秒内没有新事件')), 40_000);
  };
  const req = https.request({
    protocol: url.protocol, hostname: url.hostname, path: url.pathname, method: 'POST', timeout,
    headers: { ...headers, Cookie: jar.header(url.href), Accept: 'text/event-stream',
      'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
  }, (res) => {
    jar.absorb(res.headers, url.href);
    if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
      res.resume(); reject(new Error(`OreateAI SSE HTTP ${res.statusCode || 0}`)); return;
    }
    const parser = createSseParser((event) => {
      try {
        resetIdle(req);
        const name = event?.event;
        if (!['start', 'error', 'ban', 'hints', 'setattr', 'generating', 'end'].includes(name)) return;
        if (name === 'generating') latestGenerating = event;
        onEvent?.({ event: name, message: String(event?.data?.message || event?.data?.status || '').slice(0, 300) });
        if (name === 'error' || name === 'ban') {
          ended = true;
          req.destroy();
          reject(new Error(String(event?.data?.message || event?.data?.msg || `OreateAI ${name}`).slice(0, 500)));
        } else if (name === 'end') {
          ended = true;
          clearTimeout(idleTimer);
          resolve({ latestGenerating });
        }
      } catch (error) {
        ended = true;
        clearTimeout(idleTimer);
        req.destroy();
        reject(error);
      }
    });
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      try { parser.push(chunk); } catch (error) {
        ended = true;
        clearTimeout(idleTimer);
        req.destroy();
        reject(error);
      }
    });
    res.on('end', () => {
      clearTimeout(idleTimer);
      try { parser.end(); } catch (error) { reject(error); return; }
      if (!ended) reject(new Error('OreateAI SSE 在 end 事件前关闭'));
    });
    resetIdle(req);
  });
  req.on('timeout', () => req.destroy(new Error(`OreateAI SSE 超时（${timeout}ms）`)));
  req.on('error', (error) => { clearTimeout(idleTimer); if (!ended) reject(error); });
  signal?.addEventListener('abort', () => {
    ended = true;
    clearTimeout(idleTimer);
    req.destroy();
    reject(new Error('OreateAI SSE 已停止'));
  }, { once: true });
  req.write(payload);
  req.end();
});

const fetchHistoryVideoOutcome = async ({ call, chatId }) => {
  const query = new URLSearchParams({
    pn: '1',
    rn: '30',
    createTime: String(Math.floor(Date.now() / 1000)),
    chatID: String(chatId),
  });
  const history = await call(`/oreate/memory/getmessagelist?${query.toString()}`, {
    headers: { Referer: chatSessionUrl(chatId) },
  });
  return inspectHistoryVideoOutcome(history);
};

const historyFailureError = () => new Error('OreateAI 服务端视频生成失败');

const monitorHistoryVideoOutcome = async ({ call, chatId, isStopped, interval = 5000 }) => {
  while (!isStopped()) {
    try {
      const outcome = await fetchHistoryVideoOutcome({ call, chatId });
      if (outcome.status === 'completed') return outcome.result;
      if (outcome.status === 'failed') throw historyFailureError();
    } catch (error) {
      if (/服务端视频生成失败/.test(String(error?.message || error))) throw error;
    }
    await sleep(interval);
  }
  return null;
};

const recoverVideoResultFromHistory = async ({ call, chatId, onProgress }) => {
  onProgress?.({ stage: 'history_recovering', chatId });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const outcome = await fetchHistoryVideoOutcome({ call, chatId });
      if (outcome.status === 'completed') return outcome.result;
      if (outcome.status === 'failed') throw historyFailureError();
    } catch (error) {
      if (/服务端视频生成失败/.test(String(error?.message || error))) throw error;
    }
    if (attempt < 5) await sleep(1000 * attempt);
  }
  throw new Error('OreateAI 已完成但历史消息中没有有效视频结果');
};

export const downloadAndVerifyMp4 = async (url, outputPath, { timeout = 120_000 } = {}) => {
  if (!/^https:\/\//.test(url || '')) throw new Error('视频下载 URL 无效');
  const target = new URL(url);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.part-${process.pid}-${Date.now()}`;
  try {
    await new Promise((resolve, reject) => {
      const req = https.get(target, { timeout, headers: { Accept: 'video/mp4,application/octet-stream;q=0.9,*/*;q=0.8' } }, async (res) => {
        const status = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (status < 200 || status >= 300) { res.resume(); reject(new Error(`MP4 下载 HTTP ${status}`)); return; }
        if (contentType && !contentType.includes('video/mp4') && !contentType.includes('application/octet-stream')) {
          res.resume(); reject(new Error(`MP4 下载返回了意外类型：${contentType}`)); return;
        }
        try { await pipeline(res, fs.createWriteStream(tempPath, { flags: 'wx' })); resolve(); } catch (error) { reject(error); }
      });
      req.on('timeout', () => req.destroy(new Error(`MP4 下载超时（${timeout}ms）`)));
      req.on('error', reject);
    });
    const stat = await fsp.stat(tempPath);
    if (stat.size <= 16) throw new Error('MP4 文件为空或过小');
    const handle = await fsp.open(tempPath, 'r');
    const header = Buffer.alloc(32);
    await handle.read(header, 0, header.length, 0);
    await handle.close();
    if (header.indexOf(Buffer.from('ftyp')) < 0) throw new Error('下载文件缺少 MP4 ftyp 文件头');
    await fsp.rename(tempPath, outputPath);
    return { path: outputPath, size: stat.size, contentType: 'video/mp4' };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

const isTransientNetworkError = (error) => {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  if (error?.httpStatus && (error.httpStatus >= 500 || error.httpStatus === 408 || error.httpStatus === 429)) return true;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  return /socket disconnected before secure TLS connection was established|Client network socket disconnected|TLS connection|request timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);
};

export const createOreateVideoClient = ({
  cookies = [], userAgent, locale = 'zh-CN', timeout = 20_000, sseTimeout = 20 * 60_000, jtProvider,
} = {}) => {
  const jar = new CookieJar();
  jar.importBrowserCookies(cookies);
  const resolvedUserAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0';
  const commonHeaders = browserFetchHeaders({ locale, userAgent: resolvedUserAgent, referer: CHAT_HOME_URL });
  const call = async (pathname, { method = 'GET', body, headers = {} } = {}) => retry(async () => assertSuccess(await request({
    url: `${BASE_URL}${pathname}`, method, body, jar, timeout,
    headers: { ...commonHeaders, ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: BASE_URL } : {}), ...headers },
  }), pathname), 3, isTransientNetworkError);

  let capabilityCache = null;
  return {
    jar,
    async getCapabilities({ force = false } = {}) {
      if (capabilityCache && !force) return capabilityCache;
      const [models, scenes] = await Promise.all([
        call('/oreate/aivideo/getmodelconfigv3'), call('/oreate/aivideo/getsceneconfig'),
      ]);
      capabilityCache = buildVideoCapabilities(models, scenes, { locale });
      return capabilityCache;
    },
    async generate(options, { onProgress } = {}) {
      if (!jtProvider?.generate) throw new Error('OreateAI 视频生成需要实时浏览器风控运行时');
      const capabilities = await this.getCapabilities();
      const validated = await validateVideoRequest(capabilities, options);
      onProgress?.({ stage: 'validated', totalAssets: validated.assets.length });
      const tokenPayload = validated.assets.length ? await call('/oreate/convert/getuploadbostoken', {
        method: 'POST', body: { mFileList: validated.assets.map((asset) => ({ filename: asset.filename, fileExt: asset.ext, size: asset.size })) },
      }) : null;
      const tokenMap = normalizeUploadTokens(tokenPayload);
      const tokenEntries = Object.values(tokenMap);
      if (validated.assets.length && tokenEntries.length !== validated.assets.length) throw new Error('OreateAI 上传令牌数量与素材数量不一致');
      const uploaded = [];
      for (let index = 0; index < validated.assets.length; index += 1) {
        const asset = validated.assets[index];
        const token = tokenEntries[index];
        if (!token?.bucket || !token?.objectPath || !token?.sessionkey) throw new Error('OreateAI 上传令牌字段不完整');
        await uploadObject({ asset, bucket: token.bucket, objectPath: token.objectPath, token: token.sessionkey,
          onProgress: (progress) => onProgress?.({ stage: 'uploading', index, totalAssets: validated.assets.length, ...progress }) });
        uploaded.push({ objectPath: token.objectPath, attachment: assetAttachment(asset, token.objectPath) });
      }
      onProgress?.({ stage: 'chat_creating' });
      const chatPayload = await call('/oreate/create/chat', {
        method: 'POST',
        body: { type: 'aiVideo', docId: '', from: 'home' },
      });
      const chatId = chatPayload?.data?.chatId ?? chatPayload?.chatId;
      if (!chatId) throw new Error('OreateAI create/chat 未返回 chatId');
      const videoConfig = buildVideoConfig(options, validated.assets, uploaded, validated.combination);
      const businessBody = {
        clientType: 'pc', type: 'chat', chatType: 'aiVideo', chatTitle: 'Unnamed Session',
        chatId, focusId: chatId, from: 'home', isFirst: true,
        messages: [{ role: 'user', content: validated.prompt, attachments: uploaded.map((item) => item.attachment) }],
        videoConfig, extra: { doc_name: '', module_name: 'gpt4o' },
      };
      onProgress?.({ stage: 'risk_runtime' });
      const credential = await jtProvider.generate({ purpose: 'video-generation', chatId });
      return credential.use(async (runtime) => {
        jar.importBrowserCookies(runtime.cookies || []);
        const runtimeFields = runtime.runtimeFields || {};
        const body = {
          ...businessBody,
          jt: runtime.jt,
          ua: runtimeFields.ua || runtime.requestHeaders?.['User-Agent'] || commonHeaders['User-Agent'],
          js_env: runtimeFields.js_env || 'h5',
          extra: { ...(runtimeFields.extra || {}), ...businessBody.extra },
        };
        const headers = {
          ...browserFetchHeaders({ locale, userAgent: body.ua, referer: chatSessionUrl(chatId), accept: 'text/event-stream' }),
          ...runtime.requestHeaders,
          Origin: BASE_URL,
          Referer: chatSessionUrl(chatId),
          Accept: 'text/event-stream',
        };
        onProgress?.({ stage: 'generating', chatId });
        let historyMonitorStopped = false;
        const generationController = new AbortController();
        const generationPromise = streamGeneration({ jar, headers, body, timeout: sseTimeout,
          signal: generationController.signal,
          onEvent: (event) => onProgress?.({ stage: 'sse', ...event }) })
          .then((generation) => ({ source: 'sse', generation }));
        const historyPromise = monitorHistoryVideoOutcome({
          call,
          chatId,
          isStopped: () => historyMonitorStopped,
        }).then((result) => (result ? { source: 'history', result } : new Promise(() => {})));
        let settled;
        try {
          settled = await Promise.race([generationPromise, historyPromise]);
        } finally {
          historyMonitorStopped = true;
          generationController.abort();
        }
        if (settled.source === 'history') {
          return { ...settled.result, chatId, modelName: options.modelName, scene: options.scene };
        }
        let result;
        try {
          result = extractVideoResult(settled.generation.latestGenerating);
        } catch {
          result = await recoverVideoResultFromHistory({ call, chatId, onProgress });
        }
        return { ...result, chatId, modelName: options.modelName, scene: options.scene };
      });
    },
    download: downloadAndVerifyMp4,
  };
};