#!/usr/bin/env node
// Generate a video via Dola /chat/completion with ability_type=17 (text-only, no image upload).
//
// Usage:
//   node dola-video-text.mjs "prompt" [ratio]

import * as fs from 'node:fs';

// 捕获 signer VM 的异步错误，不让它中断进程
process.on('uncaughtException', (err) => {
  if (err.message?.includes('undefined is not a function') || err.stack?.includes('bdms-sdk')) {
    // signer 内部的异步错误，忽略
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

const DOLA_KEYS = ['COOKIE', 'USER_AGENT', 'DEVICE_ID', 'WEB_ID', 'TEA_UUID',
  'WEB_TAB_ID', 'AID', 'VERSION_CODE', 'PC_VERSION', 'FP'];
for (const k of DOLA_KEYS) {
  if (process.env[`DOLA_${k}`] && !process.env[`DOUBAO_${k}`]) {
    process.env[`DOUBAO_${k}`] = process.env[`DOLA_${k}`];
  }
}
process.env.DOUBAO_AID = process.env.DOUBAO_AID || '495671';
process.env.DOUBAO_VERSION_CODE = process.env.DOUBAO_VERSION_CODE || '20800';
process.env.DOUBAO_PC_VERSION = process.env.DOUBAO_PC_VERSION || '3.17.3';

const { setPlatform, ensureSignerReady, env, headersFor, buildSignedUrl,
        parseSseStream, uuid, signedFetchSse } = await import('./src/client.mjs');
const { bootstrap } = await import('./src/bootstrap.mjs');

await bootstrap({});
setPlatform('dola');
await ensureSignerReady();

const prompt = process.argv[2] || '生成一个穿围裙的女人在厨房里做饭，动漫风格的视频';
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
    local_message_id: uuid(),
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
    disable_sse_cache: false,
    select_text_action: '',
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
    recovery_option: {
      is_recovery: false,
      req_create_time_sec: Math.floor(Date.now() / 1000),
      append_sse_event_scene: 0,
    },
  },
  chat_ability: {
    ability_type: 17,
    ability_param: '{}',
  },
  ext: {
    answer_with_suggest: '0',
    fp: env.FP(),
    conversation_init_option: '{"need_ack_conversation":true}',
    commerce_credit_config_enable: '0',
    sub_conv_firstmet_type: '1',
  },
};

console.log('\n--- Sending video generation request ---');

const chatUrl = await buildSignedUrl('/chat/completion', 'POST', {}, { flow: true });
console.log('URL (first 120):', chatUrl.slice(0, 120));
console.log('has a_bogus:', chatUrl.includes('a_bogus'));

const chatHeaders = headersFor({ json: true, extra: { accept: 'text/event-stream' } });
const chatBody = JSON.stringify(body);

let chatRes;
try {
  chatRes = await fetch(chatUrl, {
    method: 'POST',
    headers: chatHeaders,
    body: chatBody,
  });
} catch(e) {
  console.error('Fetch error:', e.message);
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
    console.error(`\n[EVT] ${evt.event}: ${(evt.data || '').slice(0, 200)}`);
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
