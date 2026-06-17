// msToken management for Doubao CLI.
//
// The msToken must originate from mssdk.bytedance.com. Three sources, in
// priority order:
//   1. Cached token from .mstoken file (fastest, written by previous runs)
//   2. Extracted from the user's browser via Chrome DevTools MCP
//   3. Cookie-extracted fallback (rarely valid for chat)
//
// Once bootstrapped, the token is rotated automatically via the x-ms-token
// response header from doubao.com API calls.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, '..', '.mstoken');
const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

let _current = null;

export function getMsToken() { return _current; }

export function setMsToken(token) {
  if (!token) return;
  _current = token;
  saveToFile(token);
}

function saveToFile(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      token,
      timestamp: Date.now(),
    }));
  } catch {}
}

function loadFromFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const { token, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp < TOKEN_MAX_AGE_MS && token) {
      return token;
    }
  } catch {}
  return null;
}

function extractFromCookie() {
  const cookie = process.env.DOUBAO_COOKIE || '';
  const m = cookie.match(/msToken=([^;]+)/);
  return m ? m[1] : null;
}

/**
 * Bootstrap the msToken. Tries cached file first, then cookie.
 * For the initial token from mssdk.bytedance.com, run:
 *   node src/fetch-mstoken.mjs
 */
export async function bootstrapMsToken() {
  if (_current) return _current;

  // 1. Cached file
  const cached = loadFromFile();
  if (cached) {
    _current = cached;
    console.error('[mstoken] loaded from cache');
    return _current;
  }

  // 2. Cookie
  const fromCookie = extractFromCookie();
  if (fromCookie) {
    _current = fromCookie;
    console.error('[mstoken] extracted from cookie');
    return _current;
  }

  console.error('[mstoken] no token available. Run: node src/fetch-mstoken.mjs');
  return null;
}
