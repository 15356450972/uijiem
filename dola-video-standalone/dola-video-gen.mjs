#!/usr/bin/env node
/**
 * Dola 视频生成 - 整合版
 *
 * 功能：
 *   1. 纯文本生成视频（text-to-video）
 *   2. 图片 + 文本生成视频（image-to-video）
 *   3. 轮询获取视频结果并下载
 *
 * 用法：
 *   # 纯文本生成视频
 *   node dola-video-gen.mjs text "生成一个小猫在玩球的视频" [ratio]
 *
 *   # 图片 + 文本生成视频
 *   node dola-video-gen.mjs image <image-path> [prompt] [ratio]
 *
 * 环境变量：
 *   需要 .env.dola 文件（放在 doubao-cli 目录或当前目录），包含 DOLA_COOKIE 等
 *   可选 DOLA_PROXY=http://127.0.0.1:7890 设置代理
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { refreshDolaCookie, detectNeedsRefresh } from './src/cookie-refresh.mjs';

// ─── 代理设置（Node.js 原生 fetch 不走系统代理，需要手动设置） ───
// 设置 DOLA_PROXY=none (或 off/direct) 可禁用代理走直连
const explicitProxy = process.env.DOLA_PROXY
  || process.env.HTTPS_PROXY
  || process.env.HTTP_PROXY
  || process.env.ALL_PROXY
  || '';
const PROXY_URL = explicitProxy;

const PROXY_DISABLED = !PROXY_URL || /^(none|off|direct|no)$/i.test(String(PROXY_URL).trim());

if (PROXY_DISABLED) {
  console.log('[proxy] disabled (direct connection)');
} else {
  try {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log(`[proxy] using ${PROXY_URL}`);
  } catch (e) {
    console.warn(`[proxy] failed to set proxy (${PROXY_URL}): ${e.message}`);
  }
}

// ─── 加载环境变量 ───

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
      process.env[key] = val;
    }
    envLoaded = true;
    break;
  }
}
if (!envLoaded) {
  console.error('[!] .env.dola not found. Create it with DOLA_COOKIE=...');
  process.exit(1);
}

// 将 DOLA_ 前缀映射到 DOUBAO_
const DOLA_KEYS = ['COOKIE', 'USER_AGENT', 'DEVICE_ID', 'WEB_ID', 'TEA_UUID',
  'WEB_TAB_ID', 'AID', 'VERSION_CODE', 'PC_VERSION', 'FP'];
for (const k of DOLA_KEYS) {
  if (process.env[`DOLA_${k}`] && !process.env[`DOUBAO_${k}`])
    process.env[`DOUBAO_${k}`] = process.env[`DOLA_${k}`];
}
process.env.DOUBAO_AID = process.env.DOUBAO_AID || '495671';
process.env.DOUBAO_VERSION_CODE = process.env.DOUBAO_VERSION_CODE || '20800';
process.env.DOUBAO_PC_VERSION = process.env.DOUBAO_PC_VERSION || '3.17.3';

// 捕获 signer VM 的异步错误
process.on('uncaughtException', (err) => {
  if (err.stack?.includes('bdms-sdk')) return;
  console.error('Uncaught:', err);
  process.exit(1);
});

// ─── 导入 SDK 模块 ───

import { pathToFileURL, fileURLToPath } from 'node:url';

const baseDir = path.resolve(__dir);
const clientPath = pathToFileURL(path.join(baseDir, 'src', 'client.mjs')).href;
const bootstrapPath = pathToFileURL(path.join(baseDir, 'src', 'bootstrap.mjs')).href;

const { setPlatform, ensureSignerReady, env, headersFor, buildSignedUrl,
  signedFetch, getPlatformOrigin, uuid, uuidV1 } = await import(clientPath);
const { bootstrap } = await import(bootstrapPath);

async function loadUploadImage() {
  const uploadPath = pathToFileURL(path.join(baseDir, 'src', 'upload.mjs')).href;
  const { uploadImage } = await import(uploadPath);
  return uploadImage;
}

await bootstrap({});
setPlatform('dola');

// ─── 常量 ───

const POLL_INTERVAL_MS = 10000;
const MAX_POLL_TIME_MS = Number(process.env.DOLA_MAX_POLL_TIME_MS || 12 * 60 * 1000);
const SSE_READ_TIMEOUT_MS = 30 * 1000;

// ─── 构建 Samantha 视频生成请求体 ───
// 使用 /samantha/chat/completion 接口，content_type=2020, skill_type=17

// Dola 按提示词内容路由：缺少明确的"视频"关键词时会返回图片(creation type 1)
// 而不是视频(creation type 2)。这里强制补上视频意图前缀（与 Python 版一致）。
function ensureVideoIntent(prompt) {
  const text = (prompt || '').trim();
  if (!text) return '生成视频：';
  if (text.startsWith('生成视频：') || text.startsWith('生成视频:')) return text;
  return `生成视频：${text}`;
}

function createMessageIds() {
  return {
    localMessageId: uuidV1(),
    localConversationId: `local_${Date.now()}${Math.floor(Math.random() * 10000)}`,
    attachmentBlockId: uuid(),
    textBlockId: uuid(),
    uniqueKey: uuid(),
  };
}

async function preHandleUploadedImages(refImages, messageIds) {
  const images = Array.isArray(refImages) ? refImages.filter(Boolean) : [];
  if (images.length === 0) return [];

  const results = [];
  for (const img of images) {
    const identifier = img.identifier || uuidV1();
    const result = await signedFetch('/alice/message/pre_handle_v2_without_conv', {
      referer: `${getPlatformOrigin()}/chat/create-image`,
      headers: { 'agw-js-conv': 'str' },
      body: {
        uplink_entity: {
          entity_type: 2,
          entity_content: {
            image: { key: img.uri },
          },
          identifier,
        },
        bot_id: '7339470689562525703',
        local_message_id: messageIds.localMessageId,
      },
    });
    results.push({ image: img, identifier, preGenerateId: result?.data?.pre_generate_id || '' });
  }
  return results;
}

function buildSamanthaVideoBody({ prompt, ratio, duration, model, refImages, conversation, messageIds }) {
  prompt = ensureVideoIntent(prompt);
  const durationSec = Number(duration) || 5;
  const modelMap = {
    'seedance-2.0': 'seedance_v2.0',
    'seedance-1.5': 'seedance_v1.5',
    'seedance-lite': 'seedance_lite',
  };
  const modelName = modelMap[model] || model || 'seedance_v2.0';
  const ids = messageIds || createMessageIds();
  const contentBlocks = [];
  const existingConversationId = conversation?.conversationId || '';
  const localConversationId = conversation?.localConversationId || ids.localConversationId;
  const sectionId = conversation?.sectionId || '';

  // 图片附件（支持多图参考）
  const images = Array.isArray(refImages) ? refImages.filter(Boolean) : [];
  if (images.length > 0) {
    contentBlocks.push({
      block_type: 10052,
      content: {
        attachment_block: {
          attachments: images.map((img) => ({
            type: 1,
            identifier: img.identifier || uuidV1(),
            image: {
              name: img.name || 'image.png',
              uri: img.uri,
              image_ori: {
                url: '',
                width: img.width || 800,
                height: img.height || 600,
                format: '',
                url_formats: {},
              },
            },
            parse_state: 0,
            review_state: 1,
            upload_status: 1,
            progress: 100,
            src: '',
          })),
        },
        pc_event_block: '',
      },
      block_id: ids.attachmentBlockId,
      parent_id: '',
      meta_info: [],
      append_fields: [],
    });
  }

  // 文本
  contentBlocks.push({
    block_type: 10000,
    content: {
      text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' },
      pc_event_block: '',
    },
    block_id: ids.textBlockId,
    parent_id: '',
    meta_info: [],
    append_fields: [],
  });

  return {
    client_meta: {
      local_conversation_id: localConversationId,
      conversation_id: existingConversationId,
      bot_id: '7339470689562525703',
      last_section_id: sectionId,
      last_message_index: null,
    },
    messages: [{
      local_message_id: ids.localMessageId,
      content_block: contentBlocks,
      message_status: 0,
    }],
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: ids.uniqueKey,
      start_seq: 0,
      need_create_conversation: !existingConversationId,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false,
      is_old_user: false,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
    },
    user_context: [],
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify({ model: modelName, duration: durationSec, ratio }),
    },
    ext: {
      answer_with_suggest: '0',
      fp: env.FP(),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  };
}

// ─── 发送视频生成请求并流式等待 SSE 结果 ───
// 关键：视频结果通过同一个 SSE 连接异步推送（1-3 分钟后），不能提前关闭连接

async function readWithTimeout(reader, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE read timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendVideoRequest(body) {
  // 使用 /chat/completion + chat_ability.ability_type=17 触发视频生成
  // SSE 流在返回初始文本后关闭，视频结果通过轮询 /im/chain/single 获取
  const url = await buildSignedUrl('/chat/completion', 'POST', {}, { flow: true });
  console.log(`  [debug] URL: ${url.slice(0, 120)}...`);
  const headers = headersFor({
    json: true,
    extra: {
      accept: 'text/event-stream',
    },
  });

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, 60000);

  console.log(`  [debug] HTTP status: ${res.status}`);
  console.log(`  [debug] Content-Type: ${res.headers.get('content-type')}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  let conversationId = '';
  let sectionId = '';
  let fullText = '';
  let videoUrl = '';
  let initialTextDone = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const startTime = Date.now();
  const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max wait

  console.log(`  [stream] 开始流式读取 SSE（最长等待 ${SSE_TIMEOUT_MS / 1000}s）...`);

  while (true) {
    if (Date.now() - startTime > SSE_TIMEOUT_MS) {
      console.log(`\n  [stream] 超时 ${SSE_TIMEOUT_MS / 1000}s，停止等待`);
      break;
    }

    let chunk;
    try {
      chunk = await readWithTimeout(reader, SSE_READ_TIMEOUT_MS);
    } catch (e) {
      console.log(`\n  [stream] ${e.message}，切换到轮询`);
      break;
    }

    const { done, value } = chunk;
    if (done) {
      console.log(`\n  [stream] SSE 连接已关闭`);
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE blocks (separated by double newline)
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const block of parts) {
      if (!block.trim()) continue;
      let evtName = '';
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) evtName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5);
      }
      if (!evtName || !dataStr) continue;
      dataStr = dataStr.trim();

      if (evtName === 'SSE_ACK') {
        try {
          const d = JSON.parse(dataStr);
          conversationId = d.ack_client_meta?.conversation_id || conversationId;
          sectionId = d.ack_client_meta?.section_id || sectionId;
          console.log(`  [stream] ACK: conv=${conversationId}`);
        } catch {}
      }

      if (evtName === 'STREAM_MSG_NOTIFY') {
        try {
          const d = JSON.parse(dataStr);
          if (d.conversation_id) conversationId = d.conversation_id;
          const contentBlocks = d.content?.content_block || [];
          for (const b of contentBlocks) {
            const t = b.content?.text_block?.text;
            if (t) fullText = t; // MSG_NOTIFY gives full text, not incremental
            // Check for video_block
            const vid = b.content?.video_block;
            if (vid?.url) {
              videoUrl = vid.url;
              console.log(`\n  [stream] 收到 video_block URL!`);
            }
            // Check for creation_block with video
            const creation = b.content?.creation_block;
            if (creation) {
              const creationUrl = extractVideoFromCreation(creation);
              if (creationUrl) videoUrl = creationUrl;
            }
          }
        } catch {}
      }

      if (evtName === 'STREAM_CHUNK') {
        try {
          const d = JSON.parse(dataStr);
          for (const op of (d.patch_op || [])) {
            if (op.patch_object === 1) {
              for (const b of (op.patch_value?.content_block || [])) {
                const t = b.content?.text_block?.text;
                if (t) fullText += t;
                const vid = b.content?.video_block;
                if (vid?.url) {
                  videoUrl = vid.url;
                  console.log(`\n  [stream] 收到 video_block URL (chunk)!`);
                }
                const creation = b.content?.creation_block;
                if (creation) {
                  const creationUrl = extractVideoFromCreation(creation);
                  if (creationUrl) videoUrl = creationUrl;
                }
              }
            }
          }
        } catch {}
      }

      if (evtName === 'STREAM_COMPLETE' || evtName === 'SSE_DONE') {
        if (!initialTextDone) {
          initialTextDone = true;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`  [stream] 初始回复完成 (${elapsed}s): ${fullText.slice(0, 100)}`);
          if (videoUrl) break;
          console.log(`  [stream] 等待视频结果推送...`);
        } else {
          // Second STREAM_COMPLETE likely means video result arrived
          console.log(`  [stream] 第二次 COMPLETE，检查视频...`);
        }
      }
    }

    if (videoUrl) break;

    // Print progress every 30s
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 30 === 0) {
      process.stdout.write(`  [stream] ${elapsed}s 等待中...\r`);
    }
  }

  // Also check fullText for embedded video URLs
  if (!videoUrl && fullText) {
    const m = fullText.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/);
    if (m) videoUrl = m[1];
    const m2 = fullText.match(/https?:\/\/[^\s"<>]+\.mp4[^\s"<>]*/);
    if (!videoUrl && m2) videoUrl = m2[0];
  }

  console.log(`  [debug] conversationId: ${conversationId}`);
  console.log(`  [debug] videoUrl: ${videoUrl || '(none)'}`);
  console.log(`  [debug] fullText: ${fullText.slice(0, 200)}`);

  return { videoUrl, conversationId, sectionId, fullText };
}

function extractVideoFromCreation(creation) {
  if (!creation || typeof creation !== 'object') return null;
  // creation_block may contain video_url, download_url, etc.
  if (creation.video_url) return creation.video_url;
  if (creation.download_url) return creation.download_url;
  // Deep search for mp4 URLs
  const str = JSON.stringify(creation);
  const m = str.match(/https?:\/\/[^"\\]+\.mp4[^"\\]*/);
  return m ? m[0] : null;
}

// ─── 轮询视频结果 (via /im/chain/single) ───

function findVideoInMessage(message) {
  if (!message || typeof message !== 'object') return null;

  // Primary: check content_block for block_type 2074 (creation_block)
  const blocks = message.content_block || [];
  for (const block of blocks) {
    if (block.block_type === 2074) {
      const creations = block.content?.creation_block?.creations || [];
      for (const creation of creations) {
        if (creation.type === 2 && creation.video) {
          const downloadUrl = creation.video.download_url || '';
          let videoUrl = downloadUrl;
          // Try video_model for higher quality URL
          if (creation.video.video_model) {
            try {
              const model = JSON.parse(creation.video.video_model);
              const v1 = model.video_list?.video_1;
              if (v1?.main_url) {
                videoUrl = Buffer.from(v1.main_url, 'base64').toString('utf8');
              }
            } catch {}
          }
          if (videoUrl || downloadUrl) {
            return { videoUrl: videoUrl || downloadUrl, downloadUrl, duration: creation.video.duration };
          }
        }
      }
    }
  }

  // Fallback: deep search for video URLs in the entire message
  const found = [];
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [key, val] of Object.entries(node)) {
      if (typeof val === 'string') {
        if (val.startsWith('http')) {
          const looksLikeMedia =
            /\.mp4(\?|$)/i.test(val) ||
            /\.m3u8(\?|$)/i.test(val) ||
            /video_url|download_url|play_url|main_url/i.test(key);
          if (looksLikeMedia) found.push({ key, url: val });
        }
        const videoTagMatch = val.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/);
        if (videoTagMatch) found.push({ key: 'video_tag', url: videoTagMatch[1] });
        if (val.length > 4 && (val[0] === '{' || val[0] === '[')) {
          try { visit(JSON.parse(val)); } catch {}
        }
      } else if (val && typeof val === 'object') {
        visit(val);
      }
    }
  };
  visit(message);
  if (found.length > 0) {
    found.sort((a, b) => {
      const score = (u) => /\.mp4/i.test(u.url) ? 0 : /\.m3u8/i.test(u.url) ? 1 : 2;
      return score(a) - score(b);
    });
    return { downloadUrl: found[0].url, videoUrl: found[0].url };
  }
  return null;
}

async function pollFetch(pathOrUrl, body) {
  const url = new URL(pathOrUrl, 'https://www.dola.com');
  const params = {
    version_code: env.VERSION_CODE(),
    language: 'zh',
    device_platform: 'web',
    aid: env.AID(),
    real_aid: env.AID(),
    pkg_type: 'release_version',
    device_id: env.DEVICE_ID(),
    pc_version: env.PC_VERSION(),
    web_id: env.WEB_ID(),
    tea_uuid: env.TEA_UUID(),
    region: 'JP',
    sys_region: 'JP',
    samantha_web: '1',
    'use-olympus-account': '1',
    web_tab_id: env.WEB_TAB_ID(),
    msToken: env.MS_TOKEN(),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetchWithTimeout(url.href, {
    method: 'POST',
    headers: headersFor({ json: true }),
    body: JSON.stringify(body),
  }, 30000);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (!json) throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  return json;
}

async function pollVideoResult(conversationId) {
  console.log(`\n[轮询] 等待视频生成 (最长 ${MAX_POLL_TIME_MS / 1000}s, 每 ${POLL_INTERVAL_MS / 1000}s 查一次)...`);
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`  [${elapsed}s] polling...`);

    try {
      const result = await pollFetch('/im/chain/single', {
          cmd: 3100,
          uplink_body: {
            pull_singe_chain_uplink_body: {
              conversation_id: conversationId,
              anchor_index: 0,
              conversation_type: 3,
              direction: 0,
              limit: 50,
              ext: { pull_single_chain_scene: 'multi_device_red_dot_sync' },
              filter: { index_list: [] },
              evaluate_ab_params: '',
              evaluate_common_params: '',
            },
          },
          sequence_id: uuid(),
          channel: 2,
          version: '1',
        });

      const statusCode = result.status_code;
      if (statusCode && statusCode !== 0) {
        console.log(` error: code=${statusCode} ${result.status_desc || ''}`);
        continue;
      }

      const messages = result.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
      for (const msg of messages) {
        if (msg.user_type !== 2) continue;
        const videoHit = findVideoInMessage(msg);
        if (videoHit) {
          console.log(`\n  视频已生成!`);
          return videoHit;
        }
      }
      console.log(` 还没好 (${messages.length} msgs)`);
    } catch (e) {
      console.log(` error: ${e.message}`);
    }
  }

  return null;
}

// ─── 下载视频 ───

async function downloadVideo(url, filename) {
  console.log(`\n[下载] ${url.slice(0, 100)}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const target = path.isAbsolute(filename) ? filename : path.join(__dir, filename);
  fs.writeFileSync(target, buf);
  const savedSize = fs.statSync(target).size;
  console.log(`  保存到: ${target} (${(savedSize / 1024 / 1024).toFixed(2)} MB)`);
  return target;
}

// ─── 查找 .env.dola 路径 ───

function findEnvDola() {
  for (const envFile of envCandidates) {
    if (fs.existsSync(envFile)) return envFile;
  }
  return path.join(__dir, '.env.dola');
}

// ─── 核心视频生成流程（可重试） ───

async function runVideoGeneration({ mode, prompt, ratio, duration, model, imagePaths }) {
  await ensureSignerReady();

  // Step 1: 如果是图片模式，先通过 ImageX 上传每张图获取 uri 作为 key
  let refImages = [];
  if (mode === 'image') {
    const paths = Array.isArray(imagePaths) ? imagePaths : [imagePaths];
    console.log(`\n[1/3] 上传图片 (ImageX) - 共 ${paths.length} 张...`);
    const uploadImage = await loadUploadImage();
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      console.log(`  [${i + 1}/${paths.length}] 上传: ${p}`);
      const imgResult = await uploadImage({
        imagePath: p,
        botId: '',
        conversationId: '',
        sectionId: '',
        sceneId: 4,
        debug: true,
      });
      refImages.push({
        uri: imgResult.uri,
        width: imgResult.width,
        height: imgResult.height,
        name: imgResult.name,
        identifier: imgResult.identifier,
      });
      console.log(`    成功: key=${imgResult.uri} (${imgResult.width}x${imgResult.height})`);
    }
  }

  // Step 2: 图片模式先调用预处理，和 Dola 网页端上传后发送链路一致
  const messageIds = createMessageIds();
  if (refImages.length > 0) {
    console.log(`\n[2/4] 预处理参考图 (pre_handle_v2_without_conv)...`);
    try {
      const preHandled = await preHandleUploadedImages(refImages, messageIds);
      refImages = refImages.map((img) => {
        const hit = preHandled.find(item => item.image === img || item.image.uri === img.uri);
        return hit ? { ...img, identifier: hit.identifier, preGenerateId: hit.preGenerateId } : img;
      });
      console.log(`  [pre_handle] 完成: ${preHandled.map(item => item.preGenerateId || '(none)').join(', ')}`);
    } catch (e) {
      console.warn(`  [pre_handle] 失败，继续发送视频: ${e.message}`);
    }
  }

  // Step 3: 发送视频生成请求并流式等待结果
  console.log(`\n[${mode === 'image' ? '3/4' : '1/3'}] 发送视频生成请求 (ability_type=17, 流式等待)...`);
  const body = buildSamanthaVideoBody({ prompt, ratio, duration, model, refImages, conversation: null, messageIds });
  const result = await sendVideoRequest(body);

  if (result.videoUrl) {
    console.log(`\n  视频URL已获取!`);
    console.log(`  conversation_id: ${result.conversationId || ''}`);
    console.log(`  videoUrl: ${result.videoUrl}`);
    const outFile = `video_${Date.now()}.mp4`;
    await downloadVideo(result.videoUrl, outFile);
    console.log('\n完成!');
    return true;
  }

  // 检查是否真的触发了视频生成
  const isVideoTriggered = /视频|video|Seedance|生成好后/i.test(result.fullText);
  const isImageOnly = /画面|图片|图像|image/i.test(result.fullText) && !isVideoTriggered;

  // 检测是否需要刷新 cookie（额度不足 / session 过期）
  if (isImageOnly || detectNeedsRefresh(result.fullText)) {
    console.log(`\n[检测] 可能额度不足或 cookie 过期，需要刷新`);
    return 'needs_refresh';
  }

  // Fallback: 如果 SSE 流中没拿到视频，尝试轮询
  if (result.conversationId) {
    if (isVideoTriggered) {
      console.log(`\n  视频生成已触发，等待结果...`);
      console.log(`  回复: ${result.fullText.slice(0, 150)}`);
    }
    console.log(`\n  轮询 /im/chain/single (conversation_id=${result.conversationId})...`);
    const videoResult = await pollVideoResult(result.conversationId);
    if (videoResult) {
      const finalUrl = videoResult.videoUrl || videoResult.downloadUrl;
      console.log(`  conversation_id: ${result.conversationId}`);
      console.log(`  videoUrl: ${finalUrl}`);
      if (videoResult.downloadUrl) console.log(`  downloadUrl: ${videoResult.downloadUrl}`);
      const outFile = `video_${Date.now()}.mp4`;
      await downloadVideo(finalUrl, outFile);
      if (videoResult.duration) console.log(`  视频时长: ${videoResult.duration}s`);
      console.log('\n完成!');
      return true;
    }
  }

  console.error('\n[失败] 未能获取视频');
  console.log(`  conversation_id: ${result.conversationId || '(none)'}`);
  console.log(`  fullText: ${result.fullText.slice(0, 200)}`);
  return false;
}

// ─── 主流程 ───

async function main() {
  const mode = process.argv[2] || 'text';
  let prompt, ratio, duration, model, imagePaths;

  // ── poll 模式：用已有 conversation_id 直接取回视频结果（不消耗新额度） ──
  if (mode === 'poll') {
    const conversationId = process.argv[3];
    if (!conversationId) {
      console.error('用法: node dola-video-gen.mjs poll <conversation_id>');
      process.exit(1);
    }
    console.log(`\n[poll 模式] 取回视频结果 (conversation_id=${conversationId})...`);
    const videoResult = await pollVideoResult(conversationId);
    if (videoResult) {
      const finalUrl = videoResult.videoUrl || videoResult.downloadUrl;
      console.log(`  conversation_id: ${conversationId}`);
      console.log(`  videoUrl: ${finalUrl}`);
      if (videoResult.downloadUrl) console.log(`  downloadUrl: ${videoResult.downloadUrl}`);
      const outFile = `video_${Date.now()}.mp4`;
      await downloadVideo(finalUrl, outFile);
      if (videoResult.duration) console.log(`  视频时长: ${videoResult.duration}s`);
      console.log('\n完成!');
      process.exit(0);
    }
    console.error('\n[失败] 轮询超时，视频仍未生成');
    process.exit(1);
  }

  if (mode === 'image') {
    const rawPaths = process.argv[3];
    if (!rawPaths) {
      console.error('用法: node dola-video-gen.mjs image <image-path[,image-path2,...]> [prompt] [ratio] [duration] [model]');
      process.exit(1);
    }
    // 支持逗号分隔的多张参考图
    imagePaths = rawPaths.split(',').map(s => s.trim()).filter(Boolean);
    prompt = process.argv[4] || '根据图片生成视频';
    ratio = process.argv[5] || '16:9';
    duration = Number(process.argv[6] || 5) || 5;
    model = process.argv[7] || 'seedance-2.0';
  } else {
    prompt = process.argv[3] || '生成一个小猫在玩球的视频';
    ratio = process.argv[4] || '16:9';
    duration = Number(process.argv[5] || 5) || 5;
    model = process.argv[6] || 'seedance-2.0';
  }

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Dola 视频生成 (Samantha 协议)     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  模式: ${mode === 'image' ? '图片生视频' : '文本生视频'}`);
  console.log(`  提示词: ${prompt}`);
  console.log(`  比例: ${ratio}`);
  console.log(`  时长: ${duration}s`);
  console.log(`  模型: ${model}`);
  if (imagePaths) console.log(`  参考图 (${imagePaths.length}): ${imagePaths.join(', ')}`);

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runVideoGeneration({ mode, prompt, ratio, duration, model, imagePaths });

    if (result === true) {
      process.exit(0);
    }

    if (result === 'needs_refresh' && attempt < MAX_RETRIES) {
      console.log(`\n[自动刷新] 尝试打开浏览器获取新 cookie (第 ${attempt + 1} 次)...`);
      try {
        const envFile = findEnvDola();
        await refreshDolaCookie(envFile, {
          headless: false,
          proxy: PROXY_URL !== 'http://127.0.0.1:7890' ? PROXY_URL : undefined,
          profileDir: path.join(__dir, '.doubao_browsers', 'dola-refresh-profile'),
        });
        // 删除缓存的 state 文件，强制 bootstrap 重新初始化
        const stateFile = path.join(__dir, '.doubao-state.json');
        if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
        console.log('[自动刷新] cookie 已更新，重新发起请求...\n');
        continue;
      } catch (refreshErr) {
        console.error(`[自动刷新] 失败: ${refreshErr.message}`);
        process.exit(1);
      }
    }

    // result === false 或重试次数用完
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n[错误]', e.message);
  process.exit(1);
});
