#!/usr/bin/env node
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7890'));

const __dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const envFile = path.join(__dir, '.env.dola');
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

const DOLA_KEYS = ['COOKIE','USER_AGENT','DEVICE_ID','WEB_ID','TEA_UUID','WEB_TAB_ID','AID','VERSION_CODE','PC_VERSION','FP'];
for (const k of DOLA_KEYS) {
  if (process.env[`DOLA_${k}`] && !process.env[`DOUBAO_${k}`])
    process.env[`DOUBAO_${k}`] = process.env[`DOLA_${k}`];
}
process.env.DOUBAO_AID = process.env.DOUBAO_AID || '495671';
process.env.DOUBAO_VERSION_CODE = process.env.DOUBAO_VERSION_CODE || '20800';
process.env.DOUBAO_PC_VERSION = process.env.DOUBAO_PC_VERSION || '3.17.3';

const baseDir = path.resolve(__dir);
const clientPath = pathToFileURL(path.join(baseDir, 'src', 'client.mjs')).href;
const bootstrapPath = pathToFileURL(path.join(baseDir, 'src', 'bootstrap.mjs')).href;

const { setPlatform, ensureSignerReady, signedFetch, uuid } = await import(clientPath);
const { bootstrap } = await import(bootstrapPath);
await bootstrap({});
setPlatform('dola');
await ensureSignerReady();

const conversationId = process.argv[2] || '38413888349540369';
console.log('Polling conversation:', conversationId);

// Method 1: Simple format (from dola-video-poll.mjs)
console.log('\n--- Method 1: Simple format ---');
try {
  const result1 = await signedFetch('/im/chain/single', {
    method: 'POST',
    body: {
      conversation_id: conversationId,
      limit: 10,
      start_index: 0,
      fixup_need: true,
    },
  });
  console.log('Result keys:', Object.keys(result1).join(', '));
  console.log('Result (first 1000):', JSON.stringify(result1).slice(0, 1000));
} catch (e) {
  console.log('Error:', e.message);
}

// Method 2: Complex format (cmd: 3100)
console.log('\n--- Method 2: Complex format (cmd: 3100) ---');
try {
  const result2 = await signedFetch('/im/chain/single', {
    method: 'POST',
    body: {
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
    },
  });
  const messages = result2.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
  console.log('Messages count:', messages.length);
  for (const msg of messages) {
    if (msg.user_type !== 2) continue;
    const blocks = msg.content_block || [];
    console.log('Bot msg blocks:', blocks.length);
    for (const b of blocks) {
      console.log('  block_type:', b.block_type);
      if (b.block_type === 10000) {
        const text = b.content?.text_block?.text || '';
        console.log('  text:', text.slice(0, 300));
      }
      if (b.block_type === 2074) {
        console.log('  CREATION BLOCK FOUND!');
        const creations = b.content?.creation_block?.creations || [];
        for (const c of creations) {
          console.log('    type:', c.type, '| id:', c.id);
          if (c.type === 2 && c.video) {
            console.log('    VIDEO!');
            console.log('    download_url:', c.video.download_url?.slice(0, 120));
            console.log('    duration:', c.video.duration);
            console.log('    size:', c.video.width, 'x', c.video.height);
            if (c.video.video_model) {
              try {
                const model = JSON.parse(c.video.video_model);
                const v1 = model.video_list?.video_1;
                if (v1?.main_url) {
                  const url = Buffer.from(v1.main_url, 'base64').toString('utf8');
                  console.log('    720p URL:', url.slice(0, 120));
                }
              } catch {}
            }
          }
          if (c.type === 1 && c.image) {
            console.log('    IMAGE key:', c.image.key?.slice(0, 60));
          }
        }
      }
    }
  }
} catch (e) {
  console.log('Error:', e.message);
}

process.exit(0);

process.exit(0);
