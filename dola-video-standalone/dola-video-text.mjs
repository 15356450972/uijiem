#!/usr/bin/env node
// Generate a video via Dola /chat/completion with ability_type=17 (text-only, no image upload).
//
// Usage:
//   node dola-video-text.mjs "prompt" [ratio]

import * as fs from 'node:fs';
import { applyGlobalProxyFromEnv } from './src/proxy-env.mjs';

const DOLA_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const DOLA_BROWSER_PC_VERSION = '3.23.5';

function compareVersionParts(a, b) {
  const left = String(a || '').split('.').map(part => Number(part) || 0);
  const right = String(b || '').split('.').map(part => Number(part) || 0);
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeDolaRuntimeEnv() {
  const ua = String(process.env.DOLA_USER_AGENT || '').trim();
  if (!ua || /HeadlessChrome/i.test(ua)) {
    process.env.DOLA_USER_AGENT = DOLA_BROWSER_UA;
  }

  process.env.DOLA_AID = process.env.DOLA_AID || '495671';
  process.env.DOLA_VERSION_CODE = process.env.DOLA_VERSION_CODE || '20800';

  const currentPcVersion = String(process.env.DOLA_PC_VERSION || '').trim();
  if (!currentPcVersion || compareVersionParts(currentPcVersion, DOLA_BROWSER_PC_VERSION) < 0) {
    process.env.DOLA_PC_VERSION = DOLA_BROWSER_PC_VERSION;
  }
}

function ensureVideoIntent(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return '生成视频：';
  if (text.startsWith('生成视频：') || text.startsWith('生成视频:')) return text;
  return `生成视频：${text}`;
}

// 捕获 signer VM 的异步错误，不让它中断进程
process.on('uncaughtException', (err) => {
  if (err.message?.includes('undefined is not a function') || err.stack?.includes('bdms-sdk')) {
    return;
  }
  console.error('Uncaught:', err);
  process.exit(1);
});

// Load .env.dola
const envFile = '.env.dola';
if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, 'utf8');
  for (const line of envContent.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

applyGlobalProxyFromEnv();
normalizeDolaRuntimeEnv();

// Dola API runtime uses only DOLA_* values. No legacy credential aliases are read.

const { setPlatform, ensureSignerReady, env, buildSignedUrl,
        parseSseStream, uuid, uuidV1, signedFetchSse } = await import('./src/client.mjs');

setPlatform('dola');
await ensureSignerReady();

const rawPrompt = process.argv[2] || '生成一个穿围裙的女人在厨房里做饭，动漫风格的视频';
const prompt = ensureVideoIntent(rawPrompt);
const ratio = process.argv[3] || '16:9';

const DOLA_BOT_ID = '7339470689562525703';

console.log('\n=== Dola Video Generation (text-only) ===');
console.log(`Prompt: ${prompt}`);
console.log(`Ratio: ${ratio}`);

const body = {
  client_meta: {
    local_conversation_id: `local_${Date.now()}${Math.floor(Math.random() * 10000)}`,
    conversation_id: '',
    bot_id: DOLA_BOT_ID,
    last_section_id: '',
    last_message_index: null,
  },
  messages: [{
    local_message_id: uuidV1(),
    content_block: [{
      block_type: 10000,
      content: {
        text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' },
        pc_event_block: '',
      },
      block_id: uuid(),
      parent_id: '',
      meta_info: [],
      append_fields: [],
    }],
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
    unique_key: uuid(),
    start_seq: 0,
    need_create_conversation: true,
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
    ability_param: JSON.stringify({ model: 'Seedance 2.0 Fast', duration: 5 }),
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

console.log('\n--- Sending video generation request ---');

const chatUrl = await buildSignedUrl('/chat/completion', 'POST', {}, { flow: true });
console.log('URL (first 120):', chatUrl.slice(0, 120));
console.log('has a_bogus:', chatUrl.includes('a_bogus'));

let chatRes;
try {
  chatRes = await signedFetchSse('/chat/completion', {
    method: 'POST',
    flowQuery: true,
    referer: 'https://www.dola.com/chat/create-image',
    headers: {
      accept: '*/*',
      'last-event-id': 'undefined',
      'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      'sec-ch-ua-platform': '"macOS"',
    },
    timeoutMs: 60000,
    body,
  });
} catch(e) {
  if (e?.code === 'needs_auth' || /\[needs_auth\]/i.test(String(e?.message || e))) {
    console.error(`[needs_auth] ${e.message}`);
  } else {
    console.error('Fetch error:', e.message);
  }
  process.exit(1);
}

console.log('Status:', chatRes.status);
console.log('Content-Type:', chatRes.headers.get('content-type'));
if (!chatRes.ok || !chatRes.headers.get('content-type')?.includes('event-stream')) {
  const text = await chatRes.text();
  console.error('Error (first 300):', text.slice(0, 300));
  process.exit(1);
}

console.log('\n--- Reading SSE stream ---');
let fullText = '';
let videoUrl = '';
let conversationId = '';

for await (const evt of parseSseStream(chatRes)) {
  if (evt.event === 'STREAM_ERROR') {
    try {
      const d = JSON.parse(evt.data);
      console.error('\nSTREAM ERROR:', d.error_code, d.error_msg);
    } catch {}
    break;
  }
  if (evt.event === 'CHUNK_DELTA') {
    try {
      const d = JSON.parse(evt.data);
      if (d.text) { process.stdout.write(d.text); fullText += d.text; }
    } catch {}
  }
  if (evt.event === 'STREAM_MSG_NOTIFY') {
    try {
      const d = JSON.parse(evt.data);
      if (d.conversation_id) conversationId = d.conversation_id;
      const blocks = d.content?.content_block || [];
      for (const b of blocks) {
        const t = b.content?.text_block?.text;
        if (t) { process.stdout.write(t); fullText += t; }
        const vid = b.content?.video_block;
        if (vid?.url) videoUrl = vid.url;
      }
    } catch {}
  }
  if (evt.event === 'SSE_REPLY_END') break;
  // Log all events for debugging
  if (evt.event !== 'SSE_HEARTBEAT') {
    const preview = (evt.data || '').slice(0, 400);
    console.error(`\n[EVT] ${evt.event}: ${preview}`);
  }
}

console.log('\n');
if (conversationId) console.log('Conversation ID:', conversationId);
if (videoUrl) {
  console.log('Video URL:', videoUrl);
  // Download the video
  const outFile = 'output_video.mp4';
  console.log(`\nDownloading video to ${outFile}...`);
  const vidRes = await fetch(videoUrl);
  if (vidRes.ok) {
    const buf = Buffer.from(await vidRes.arrayBuffer());
    fs.writeFileSync(outFile, buf);
    console.log(`Done! Saved ${buf.length} bytes to ${outFile}`);
  } else {
    console.error('Download failed:', vidRes.status);
  }
} else {
  console.log('No video URL received.');
  if (fullText) console.log('Response text:', fullText.slice(0, 500));
}
