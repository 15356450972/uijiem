// Cold-boot helper: derive every non-cookie field the API client needs from
// just `DOUBAO_COOKIE`.  Persists the result to `.doubao-state.json` so we
// don't burn handshake calls on every run.
//
// What we have to fabricate:
//   - device_id, web_id, tea_uuid   -- 19-digit ByteDance Tea SDK IDs.
//                                      The web app generates them locally
//                                      from `Date.now()` + jitter; the server
//                                      only checks they're stable per session.
//   - web_tab_id                    -- per-tab UUIDv4.
//   - aid / pc_version              -- read from the SSR-injected JSON in
//                                      https://www.doubao.com/chat/.
//   - UA / version_code / fp        -- safe constants (fp == cookie's
//                                      s_v_web_id which is a stable Tea ID).
//   - msToken                       -- gateway only checks shape (~106 chars
//                                      of base64url + "=="), not contents.
//                                      Verified on /chat/completion with no /
//                                      fake / real tokens — all three pass
//                                      auth.  No mssdk handshake needed.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = path.resolve(__dir, '..');
const STATE_FILE = '.doubao-state.json';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Match the 19-digit format of real Tea IDs (e.g. 7639890410651289098).  Top
// bit is forced to 0 to keep us inside the unsigned 63-bit range that decimal
// strings of length 19 can represent without overflow.  The high 41 bits hold
// `Date.now()` and the low 22 bits hold randomness, mirroring the SDK.
function generateTeaId() {
  const ms = BigInt(Date.now()) & 0x1ffffffffffn; // 41 bits
  const rand = BigInt(crypto.randomInt(0, 1 << 22));
  const id = (ms << 22n) | rand;
  return id.toString();
}

// Real msToken format: 106 base64url chars followed by "==".  The gateway only
// checks that something like this is present.
function generateMsToken() {
  return crypto.randomBytes(78).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_') + '==';
}

function getCookieValue(cookieHeader, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader);
  return m ? m[1] : null;
}

async function readJsonOrNull(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return null; }
}

// Pull `aid` and `pc_version` straight from the SSR JSON injected into
// https://www.doubao.com/chat/.  These are the only two values that actually
// change with a release; everything else is derivable locally.
async function fetchSsrConfig(cookie, ua) {
  const res = await fetch('https://www.doubao.com/chat/', {
    headers: { 'user-agent': ua, cookie, accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`SSR fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const aidMatch = /"aid"\s*:\s*(\d+)/.exec(html);
  const pcMatch  = /"pc_version"\s*:\s*"([\d.]+)"/.exec(html);
  return {
    aid: aidMatch ? aidMatch[1] : '497858',
    pcVersion: pcMatch ? pcMatch[1] : '3.23.5',
  };
}

// Returns a fully-populated state object.  Mutates process.env with the
// derived values so the rest of the codebase keeps reading them the same way.
export async function bootstrap({ cwd = DEFAULT_STATE_DIR, debug = false, refresh = false } = {}) {
  const cookie = process.env.DOUBAO_COOKIE;
  if (!cookie) throw new Error('DOUBAO_COOKIE is required.');

  const statePath = path.resolve(cwd, STATE_FILE);
  const cached = refresh ? null : await readJsonOrNull(statePath);
  const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 16);
  const sVWebId = getCookieValue(cookie, 's_v_web_id');

  let state = cached && cached.cookieHash === cookieHash ? cached : null;
  if (!state) {
    if (debug) console.error('[bootstrap] cold-start: minting device IDs + msToken');
    const ua = process.env.DOUBAO_USER_AGENT || DEFAULT_UA;
    const ssr = await fetchSsrConfig(cookie, ua)
      .catch((e) => {
        if (debug) console.error('[bootstrap] SSR fetch failed, falling back to defaults:', e.message);
        return { aid: '497858', pcVersion: '3.17.3' };
      });
    const deviceId = generateTeaId();

    state = {
      cookieHash,
      ua,
      aid: ssr.aid,
      versionCode: '20800',
      pcVersion: ssr.pcVersion,
      deviceId,
      webId: deviceId,
      teaUuid: deviceId,
      webTabId: crypto.randomUUID(),
      fp: sVWebId || '',
      msToken: generateMsToken(),
      mintedAt: Date.now(),
    };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
    if (debug) console.error('[bootstrap] state written to', statePath);
  } else if (debug) {
    console.error('[bootstrap] reusing cached state from', statePath);
  }

  // Rotate msToken every ~6 hours.  The gateway accepts any base64url-shaped
  // value, but periodically rotating it matches what the browser does and
  // looks more natural in the access logs.
  if (Date.now() - state.mintedAt > 6 * 60 * 60 * 1000) {
    state.msToken = generateMsToken();
    state.mintedAt = Date.now();
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  process.env.DOUBAO_USER_AGENT  = process.env.DOUBAO_USER_AGENT  || state.ua;
  process.env.DOUBAO_DEVICE_ID   = process.env.DOUBAO_DEVICE_ID   || state.deviceId;
  process.env.DOUBAO_WEB_ID      = process.env.DOUBAO_WEB_ID      || state.webId;
  process.env.DOUBAO_TEA_UUID    = process.env.DOUBAO_TEA_UUID    || state.teaUuid;
  process.env.DOUBAO_WEB_TAB_ID  = process.env.DOUBAO_WEB_TAB_ID  || state.webTabId;
  process.env.DOUBAO_AID         = process.env.DOUBAO_AID         || state.aid;
  process.env.DOUBAO_VERSION_CODE= process.env.DOUBAO_VERSION_CODE|| state.versionCode;
  process.env.DOUBAO_PC_VERSION  = process.env.DOUBAO_PC_VERSION  || state.pcVersion;
  process.env.DOUBAO_FP          = process.env.DOUBAO_FP          || state.fp;
  process.env.DOUBAO_MS_TOKEN    = process.env.DOUBAO_MS_TOKEN    || state.msToken;

  return state;
}
