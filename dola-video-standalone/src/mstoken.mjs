// msToken management for the Dola API client.
//
// Accepted sources are deliberately limited to credentials explicitly supplied
// by the user:
//   1. DOLA_MS_TOKEN
//   2. A local cache written by setUserProvidedMsToken() after an explicit user action
//
// This module never reads browser state, derives a token from Cookie, refreshes
// credentials, or performs network requests.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, '..', '.mstoken');
const USER_PROVIDED_SOURCE = 'user-provided';

let currentToken = null;

export function getMsToken() {
  return currentToken;
}

export function setUserProvidedMsToken(token) {
  const value = String(token || '').trim();
  if (!value) return;
  currentToken = value;
  saveExplicitToken(value);
}

function saveExplicitToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      token,
      source: USER_PROVIDED_SOURCE,
      timestamp: Date.now(),
    }));
  } catch {}
}

function loadExplicitToken() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const { token, source } = JSON.parse(raw);
    if (source === USER_PROVIDED_SOURCE && token) {
      return String(token).trim();
    }
  } catch {}
  return null;
}

export async function bootstrapMsToken({ envName = 'DOLA_MS_TOKEN' } = {}) {
  if (currentToken) return currentToken;

  const explicit = String(process.env[envName] || '').trim();
  if (explicit) {
    currentToken = explicit;
    return currentToken;
  }

  const cached = loadExplicitToken();
  if (cached) {
    currentToken = cached;
    return currentToken;
  }

  console.error(`[needs_auth] 缺少 ${envName}。请由用户手动配置 API 凭证。`);
  return null;
}