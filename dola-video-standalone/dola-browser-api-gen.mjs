#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function envFlag(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envText(name, fallback = '') {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}

function defaultGrabPaths() {
  return {
    envFile: path.resolve(__dir, '.env.dola'),
    profileDir: path.resolve(__dir, '.doubao_browsers', 'dola-account-profile'),
  };
}

function buildGrabOptions() {
  const defaults = defaultGrabPaths();
  const headless = envFlag('DOLA_API_GRAB_HEADLESS', false);
  const visible = envFlag('DOLA_API_GRAB_VISIBLE', !headless);
  return {
    visible,
    keepOpen: envFlag('DOLA_API_GRAB_KEEP_OPEN', false),
    sendHi: envFlag('DOLA_API_GRAB_SEND_HI', false),
    hiText: envText('DOLA_API_GRAB_HI_TEXT', '你好'),
    clearLogin: envFlag('DOLA_API_GRAB_CLEAR_LOGIN', false),
    waitMs: envNumber('DOLA_API_GRAB_WAIT_MS', 8000),
    proxy: envText('DOLA_API_GRAB_PROXY', process.env.DOLA_PROXY || ''),
    profile: envText('DOLA_PROFILE_DIR', defaults.profileDir),
    out: envText('DOLA_ENV_FILE', defaults.envFile),
    url: envText('DOLA_API_GRAB_URL', ''),
    chromePath: envText('CHROME_PATH', ''),
  };
}

function spawnInherited(command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: __dir,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error(`[browser-api-gen] failed to start ${path.basename(command)}: ${error.message}`);
      resolve(1);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        console.error(`[browser-api-gen] process exited via signal: ${signal}`);
        resolve(1);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

async function runGrabber(options) {
  const args = ['grab-account.mjs'];
  args.push(options.visible ? '--visible' : '--headless');
  args.push('--wait-ms', String(options.waitMs));
  args.push('--profile', options.profile);
  args.push('--out', options.out);
  if (options.keepOpen) args.push('--keep-open');
  if (options.sendHi) {
    args.push('--send-hi');
    if (options.hiText) args.push('--hi-text', options.hiText);
  }
  if (options.clearLogin) args.push('--close-login');
  if (options.proxy) args.push('--proxy', options.proxy);
  if (options.url) args.push('--url', options.url);
  if (options.chromePath) args.push('--chrome', options.chromePath);

  return await spawnInherited(process.execPath, args);
}

async function runGenerator(args, envOverrides = {}) {
  return await spawnInherited(process.execPath, ['dola-video-gen.mjs', ...args], envOverrides);
}

async function main() {
  const generatorArgs = process.argv.slice(2);
  if (!generatorArgs.length) {
    console.error('Usage: node dola-browser-api-gen.mjs <dola-video-gen args...>');
    process.exit(1);
  }

  const grabOptions = buildGrabOptions();
  console.log(`[browser-api-gen] grab profile: ${grabOptions.profile}`);
  console.log(`[browser-api-gen] grab env: ${grabOptions.out}`);
  console.log(`[browser-api-gen] browser mode: ${grabOptions.visible ? 'visible' : 'headless'}`);

  const grabExitCode = await runGrabber(grabOptions);
  if (grabExitCode !== 0) {
    process.exit(grabExitCode);
  }

  console.log('[browser-api-gen] browser parameters ready, switching to API generation');
  const exitCode = await runGenerator(generatorArgs, {
    DOLA_ENV_FILE: grabOptions.out,
    DOLA_PROFILE_DIR: grabOptions.profile,
  });
  process.exit(exitCode);
}

try {
  await main();
} catch (error) {
  console.error(`[browser-api-gen] failed: ${error.message}`);
  process.exit(1);
}