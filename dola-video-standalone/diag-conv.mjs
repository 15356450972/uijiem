#!/usr/bin/env node
// 一次性诊断：dump 指定会话的消息结构，确认视频块是否存在/是否被审核拦截
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// 加载 env
const envFile = path.join(__dir, '.env.dola');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  if (line.startsWith('#') || !line.trim()) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  process.env[key] = val;
}
const DOLA_KEYS = ['COOKIE', 'USER_AGENT', 'DEVICE_ID', 'WEB_ID', 'TEA_UUID',
  'WEB_TAB_ID', 'AID', 'VERSION_CODE', 'PC_VERSION', 'FP'];
for (const k of DOLA_KEYS) {
  if (process.env[`DOLA_${k}`] && !process.env[`DOUBAO_${k}`])
    process.env[`DOUBAO_${k}`] = process.env[`DOLA_${k}`];
}
process.env.DOUBAO_AID = process.env.DOUBAO_AID || '495671';
process.env.DOUBAO_VERSION_CODE = process.env.DOUBAO_VERSION_CODE || '20800';
process.env.DOUBAO_PC_VERSION = process.env.DOUBAO_PC_VERSION || '3.20.0';

const clientPath = pathToFileURL(path.join(__dir, 'src', 'client.mjs')).href;
const bootstrapPath = pathToFileURL(path.join(__dir, 'src', 'bootstrap.mjs')).href;
const { setPlatform, ensureSignerReady, signedFetch, uuid } = await import(clientPath);
const { bootstrap } = await import(bootstrapPath);
await bootstrap({});
setPlatform('dola');
await ensureSignerReady();

const conversationId = process.argv[2];
if (!conversationId) { console.error('用法: node diag-conv.mjs <conversation_id>'); process.exit(1); }

const result = await signedFetch('/im/chain/single', {
  method: 'POST',
  body: {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: conversationId,
        anchor_index: 0, conversation_type: 3, direction: 0, limit: 50,
        ext: { pull_single_chain_scene: 'multi_device_red_dot_sync' },
        filter: { index_list: [] }, evaluate_ab_params: '', evaluate_common_params: '',
      },
    },
    sequence_id: uuid(), channel: 2, version: '1',
  },
});

console.log('status_code:', result.status_code, result.status_desc || '');
const messages = result.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
console.log('消息数:', messages.length);
for (const msg of messages) {
  console.log(`\n── msg user_type=${msg.user_type} index=${msg.index ?? '?'} ──`);
  const blocks = msg.content_block || [];
  for (const b of blocks) {
    console.log(`  block_type=${b.block_type}`);
    const t = b.content?.text_block?.text;
    if (t) console.log(`    text: ${t.slice(0, 200)}`);
    if (b.block_type === 2074) {
      const creations = b.content?.creation_block?.creations || [];
      console.log(`    creations: ${creations.length}`);
      for (const c of creations) {
        console.log(`      type=${c.type} status=${c.status ?? '?'} has_video=${!!c.video} has_image=${!!c.image}`);
        if (c.video) console.log(`        video keys: ${Object.keys(c.video).join(',')}`);
      }
    }
  }
  // dump 任何可能的状态/错误字段
  for (const k of ['status', 'gen_status', 'error', 'review_status']) {
    if (msg[k] !== undefined) console.log(`  msg.${k}=`, msg[k]);
  }
}
// 把完整原始结构也写到文件，便于深查
fs.writeFileSync(path.join(__dir, 'diag-conv-dump.json'), JSON.stringify(result, null, 2));
console.log('\n完整结构已写入 diag-conv-dump.json');
process.exit(0);