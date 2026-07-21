#!/usr/bin/env node
/**
 * Dola 视频结果轮询器（修复 712012002 "不支持编码类型"）
 *
 * 与 dola-video-gen.mjs poll 不同，这里使用 FLAT 请求体（与上游
 * doubao2api/dola-video/dola-video-poll.mjs 一致），不再嵌套
 * pull_singe_chain_uplink_body / downlink_body。
 *
 * 用法：
 *   node dola-video-poll-flat.mjs <conversation_id> [output.mp4]
 *
 * 环境变量：
 *   .env.dola 必须存在（含 DOLA_COOKIE、DOLA_MS_TOKEN 等）
 *   DOLA_PROXY=direct  禁用代理
 *   DOLA_MAX_POLL_TIME_MS  默认 720000 (12分钟)
 *   DOLA_POLL_INTERVAL_MS  默认 10000 (10秒)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyGlobalProxyFromEnv } from './src/proxy-env.mjs';

// ─── .env.dola ───
const __dir = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  process.env.DOLA_ENV_FILE,
  path.join(__dir, '.env.dola'),
  path.join(__dir, '..', 'doubao-cli', '.env.dola'),
  '.env.dola',
].filter(Boolean);
let envLoaded = false;
for (const envFile of envCandidates) {
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf8');
    for (const line of envContent.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
    envLoaded = true;
    break;
  }
}
if (!envLoaded) {
  console.error('[needs_auth] 未找到 .env.dola。请由用户手动配置 DOLA_COOKIE 和 DOLA_MS_TOKEN。');
  process.exit(1);
}

applyGlobalProxyFromEnv();

let sdkAsyncError = '';
function isBdmsSdkNoise(error) {
  const text = String(error?.stack || error?.message || error || '');
  return text.includes('bdms-sdk.js') || text.includes('_opt_tiger_compile_path') || text.includes('flow_web_monorepo');
}
process.on('uncaughtException', (error) => {
  if (!isBdmsSdkNoise(error)) throw error;
  sdkAsyncError = String(error?.message || 'bdms-sdk 异步异常');
  console.warn(`[sdk-warning] ${sdkAsyncError}`);
});
process.on('unhandledRejection', (reason) => {
  if (!isBdmsSdkNoise(reason)) throw reason;
  sdkAsyncError = String(reason?.message || reason || 'bdms-sdk 异步异常');
  console.warn(`[sdk-warning] ${sdkAsyncError}`);
});

// 真实浏览器伪装（与 gen 保持一致）
const DOLA_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
if (!process.env.DOLA_USER_AGENT || /HeadlessChrome/i.test(process.env.DOLA_USER_AGENT)) {
  process.env.DOLA_USER_AGENT = DOLA_BROWSER_UA;
}
process.env.DOLA_AID = process.env.DOLA_AID || '495671';
process.env.DOLA_VERSION_CODE = process.env.DOLA_VERSION_CODE || '20800';
process.env.DOLA_PC_VERSION = process.env.DOLA_PC_VERSION || '3.23.5';

// ─── 加载 client.mjs（getPlatformOrigin / signedFetch / setPlatform）───
const clientPath = pathToFileURL(path.join(__dir, 'src', 'client.mjs')).href;
const { signedFetch, setPlatform, ensureSignerReady, getPlatformOrigin } = await import(clientPath);

if (typeof setPlatform === 'function') setPlatform('dola');
await ensureSignerReady();

function envGet(name, fallback = '') {
  return process.env[`DOLA_${name}`] || fallback;
}

function browserImQuery() {
  return {
    version_code: envGet('VERSION_CODE', '20800'),
    language: 'zh',
    device_platform: 'web',
    aid: envGet('AID', '495671'),
    real_aid: envGet('AID', '495671'),
    pkg_type: 'release_version',
    device_id: envGet('DEVICE_ID'),
    pc_version: envGet('PC_VERSION', '3.23.5'),
    region: 'JP',
    sys_region: 'JP',
    samantha_web: '1',
    web_platform: 'browser',
    'use-olympus-account': '1',
    web_tab_id: envGet('WEB_TAB_ID'),
  };
}

// ─── 轮询主体（按浏览器抓包的 IM chain 协议请求）───
async function pollOnce(conversationId) {
  const result = await signedFetch('/im/chain/single', {
    raw: true,
    query: browserImQuery(),
    method: 'POST',
    referer: `${getPlatformOrigin()}/chat/${conversationId}`,
    headers: { 'agw-js-conv': 'str' },
    body: {
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
      sequence_id: randomUUID(),
      channel: 2,
      version: '1',
    },
  });
  return result;
}

function normalizeMessages(result) {
  return result?.downlink_body?.pull_singe_chain_downlink_body?.messages
    || result?.messages
    || [];
}

function parseBlocks(msg) {
  if (Array.isArray(msg?.content_block)) return msg.content_block;
  if (typeof msg?.content === 'string' && msg.content.trim().startsWith('[')) {
    try { return JSON.parse(msg.content); } catch {}
  }
  return [];
}

function extractMessageFailure(msg, blocks) {
  const ext = msg?.ext || {};
  const texts = [];
  for (const block of blocks || []) {
    const text = block?.content?.text_block?.text;
    if (text) texts.push(text);
  }
  const code = ext.ai_creation_res_code || '';
  const toolList = ext.ai_creation_tool_list || '';
  const failedTool = /"status"\s*:\s*5|"fail_code"/i.test(toolList);
  const textFailure = texts.find((text) => /无法|失败|错误|不支持|保护|换其他参考图|生成失败|侵权|违规|违法|违禁|无法返回|超过\s*\d+\s*秒|达到上限|已达上限|明天再来|降低配置|额度不足|cannot be generated|longer than/i.test(text));
  if (code || failedTool || textFailure) {
    return [textFailure, code ? `ai_creation_res_code=${code}` : '', failedTool ? 'tool_status=failed' : '']
      .filter(Boolean)
      .join('；');
  }
  return '';
}

function decodeBase64Url(value) {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parseVideoModel(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractVideoUrls(video) {
  const model = parseVideoModel(video?.video_model);
  const videoList = model?.video_list || {};
  const gears = Object.values(videoList).filter((item) => item && typeof item === 'object');
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
  const fallbackApi = typeof model?.fallback_api === 'string' ? model.fallback_api : '';
  return {
    url: unwatermarked || cici,
    unwatermarkedUrl: unwatermarked,
    ciciUrl: cici,
    fallbackApi,
    source: unwatermarked ? 'unwatermarked' : cici ? 'cici' : '',
    fileHash: decoded.find((item) => item.url === unwatermarked)?.gear?.file_hash || '',
    downloadFileHash: video?.download_filehash || '',
  };
}

function extractFromMessages(messages) {
  const candidates = [];
  // 诊断信息：记录所有出现过的 block_type，以及视频块里非视频/无链接的情况，
  // 便于在“没拿到视频”时返回明确报错，而不是静默失败。
  const seenBlockTypes = new Set();
  const issues = [];
  const failures = [];
  for (const msg of (messages || [])) {
    const blocks = parseBlocks(msg);
    const failure = extractMessageFailure(msg, blocks);
    if (failure) failures.push(failure);
    for (const block of blocks) {
      if (block?.block_type != null) seenBlockTypes.add(block.block_type);
      if (block?.block_type !== 2074) continue;
      const creations = block?.content?.creation_block?.creations || [];
      if (creations.length === 0) {
        issues.push('creation_block 存在但 creations 为空');
        continue;
      }
      for (const c of creations) {
        const v = c?.video || {};
        const urls = extractVideoUrls(v);
        const url = urls.url;
        if (url) {
          candidates.push({
            url,
            unwatermarkedUrl: urls.unwatermarkedUrl,
            ciciUrl: urls.ciciUrl,
            fallbackApi: urls.fallbackApi,
            source: urls.source,
            fileHash: urls.fileHash,
            downloadFileHash: urls.downloadFileHash,
            duration: v.duration,
            width: v.width,
            height: v.height,
            mime: v.mime_type || '',
          });
        } else if (c?.image || v?.mime_type?.startsWith?.('image')) {
          // 生成结果是图片而非视频
          issues.push('生成结果为图片(image)而非视频，未找到视频链接');
        } else {
          issues.push(`视频块存在但无可用链接 (creation keys: ${Object.keys(c || {}).join(',') || 'none'})`);
        }
      }
    }
  }
  return {
    candidates,
    diagnostics: {
      seenBlockTypes: [...seenBlockTypes],
      issues,
      failures: [...new Set(failures)],
      hasVideoBlock: seenBlockTypes.has(2074),
    },
  };
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const conversationId = process.argv[2];
  const outputPath = process.argv[3] || '';
  if (!conversationId) {
    console.error('Usage: node dola-video-poll-flat.mjs <conversation_id> [output.mp4]');
    process.exit(2);
  }

  const maxMs = Number(process.env.DOLA_MAX_POLL_TIME_MS) || 720_000;
  const intervalMs = Number(process.env.DOLA_POLL_INTERVAL_MS) || 10_000;
  const requestTimeoutMs = Number(process.env.DOLA_POLL_REQUEST_TIMEOUT_MS) || 15_000;
  const startTs = Date.now();

  console.log(`[poll] conversation_id=${conversationId}`);
  console.log(`[poll] maxMs=${maxMs}  intervalMs=${intervalMs}`);

  let attempt = 0;
  let firstError = '';
  let lastDiagnostics = null;
  while (Date.now() - startTs < maxMs) {
    attempt++;
    const elapsed = Math.round((Date.now() - startTs) / 1000);
    try {
      const result = await withTimeout(pollOnce(conversationId), requestTimeoutMs, 'pollOnce');

      if (result?.code && result.code !== 0) {
        const msg = result.msg || result.message || JSON.stringify(result).slice(0, 200);
        if (!firstError) firstError = `code=${result.code} ${msg}`;
        console.log(`  [${elapsed}s] code=${result.code} ${msg}`);
      } else {
        const messages = normalizeMessages(result);
        console.log(`  [${elapsed}s] ok, messages=${messages.length}`);
        const cands = extractFromMessages(messages);
        lastDiagnostics = cands.diagnostics;
        if (cands.candidates.length > 0) {
          const pick = cands.candidates[0];
          console.log(`\n[done] video url found:`);
          console.log(`  url:      ${pick.url}`);
          console.log(`  source:   ${pick.source || ''}`);
          if (pick.unwatermarkedUrl) console.log(`  unwatermarked: ${pick.unwatermarkedUrl}`);
          if (pick.ciciUrl) console.log(`  cici:     ${pick.ciciUrl}`);
          // 给上游 Python 解析器(_parse_generation_output)使用的规范行
          console.log(`videoUrl: ${pick.url}`);
          if (pick.unwatermarkedUrl) console.log(`unwatermarkedUrl: ${pick.unwatermarkedUrl}`);
          if (pick.ciciUrl) console.log(`ciciUrl: ${pick.ciciUrl}`);
          console.log(`  duration: ${pick.duration}`);
          console.log(`  size:     ${pick.width}x${pick.height}`);
          console.log(`  mime:     ${pick.mime}`);
          if (outputPath) {
            console.log(`\n[download] -> ${outputPath}`);
            const res = await withTimeout(fetch(pick.url), requestTimeoutMs, 'video download');
            if (!res.ok) {
              console.error(`  download failed: HTTP ${res.status}`);
              console.error(`[失败] 视频下载失败: HTTP ${res.status}`);
              process.exit(3);
            }
            const buf = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(outputPath, buf);
            console.log(`  wrote ${buf.length} bytes`);
            // 给上游 Python 解析器使用的规范行
            console.log(`保存到: ${outputPath}`);
          } else if (process.env.DOLA_POLL_OUTPUT_MODE !== 'stdout') {
            const dumpPath = `dola-poll-flat-${conversationId}.json`;
            fs.writeFileSync(dumpPath, JSON.stringify({ conversationId, candidates: cands }, null, 2));
            console.log(`\n[dump] ${dumpPath}`);
          }
          process.exit(0);
        }
        if (cands.diagnostics.failures.length > 0) {
          const reason = cands.diagnostics.failures.join('；');
          console.error(`[diagnostics] 失败: ${reason}`);
          console.error(`[失败] ${reason}`);
          process.exit(1);
        }
      }
    } catch (e) {
      if (e?.code === 'needs_auth' || /\[needs_auth\]/i.test(String(e?.message || e))) throw e;
      if (!firstError) firstError = e.message;
      console.log(`  [${elapsed}s] exception: ${e.message}`);
    }

    if (!firstError && sdkAsyncError) firstError = sdkAsyncError;
    await new Promise(r => setTimeout(r, intervalMs));
  }

  console.error(`\n[timeout] 未在 ${maxMs}ms 内获取到视频 (block_type=2074 creation_block)`);
  if (lastDiagnostics) {
    const seen = lastDiagnostics.seenBlockTypes || [];
    console.error(`[diagnostics] 出现过的 block_type: ${seen.length ? seen.join(', ') : '无'}`);
    console.error(`[diagnostics] 是否出现视频块(2074): ${lastDiagnostics.hasVideoBlock ? '是' : '否'}`);
    if (lastDiagnostics.failures && lastDiagnostics.failures.length) {
      for (const failure of lastDiagnostics.failures) console.error(`[diagnostics] 失败: ${failure}`);
    }
    if (lastDiagnostics.issues && lastDiagnostics.issues.length) {
      for (const issue of lastDiagnostics.issues) console.error(`[diagnostics] 问题: ${issue}`);
    } else if (!lastDiagnostics.hasVideoBlock) {
      console.error('[diagnostics] 服务端始终未返回视频块，可能仍在生成中或生成失败');
    }
  } else {
    console.error('[diagnostics] 整个轮询期间未成功拉取到任何消息');
  }
  if (firstError) console.error(`[first-error] ${firstError}`);
  // 给上游 Python 解析器使用的失败原因（取诊断里最有信息量的一条）
  {
    let reason = '';
    if (lastDiagnostics) {
      if (lastDiagnostics.failures && lastDiagnostics.failures.length) reason = lastDiagnostics.failures.join('；');
      else if (lastDiagnostics.issues && lastDiagnostics.issues.length) reason = lastDiagnostics.issues.join('；');
      else if (!lastDiagnostics.hasVideoBlock) reason = '服务端始终未返回视频块，可能仍在生成中或生成失败';
    }
    if (!reason) reason = firstError || '整个轮询期间未成功拉取到任何消息';
    console.error(`[失败] ${reason || `未在 ${maxMs}ms 内获取到视频`}`);
  }
  process.exit(1);
}

main().catch(e => {
  console.error(`[fatal] ${e.stack || e.message}`);
  process.exit(1);
});