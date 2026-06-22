import { execFileSync } from 'node:child_process';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

function clean(value) {
  return String(value || '').trim();
}

function isDisabled(value) {
  return /^(none|off|direct|no)$/i.test(clean(value));
}

function firstProxyCandidate(env = process.env) {
  const candidates = [
    env.DOLA_PROXY,
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.ALL_PROXY,
    env.https_proxy,
    env.http_proxy,
    env.all_proxy,
  ];
  for (const item of candidates) {
    const value = clean(item);
    if (!value) continue;
    if (isDisabled(value)) return { value: '', source: 'explicit-disabled' };
    return { value, source: 'explicit' };
  }
  return { value: '', source: '' };
}

function parseScutilValue(text, key) {
  const match = text.match(new RegExp(`\\b${key}\\s*:\\s*(.+)`));
  return clean(match?.[1]);
}

function buildHttpProxyUrl(host, port) {
  const normalizedHost = clean(host).replace(/\/$/, '');
  const normalizedPort = clean(port);
  if (!normalizedHost || !normalizedPort) return '';
  if (/^[a-z]+:\/\//i.test(normalizedHost)) {
    if (/:[0-9]+$/i.test(normalizedHost)) return normalizedHost;
    return `${normalizedHost}:${normalizedPort}`;
  }
  return `http://${normalizedHost}:${normalizedPort}`;
}

function resolveMacSystemProxy() {
  if (process.platform !== 'darwin') return { value: '', source: '' };
  try {
    const output = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const httpsEnabled = parseScutilValue(output, 'HTTPSEnable') === '1';
    const httpsProxy = parseScutilValue(output, 'HTTPSProxy');
    const httpsPort = parseScutilValue(output, 'HTTPSPort');
    const httpEnabled = parseScutilValue(output, 'HTTPEnable') === '1';
    const httpProxy = parseScutilValue(output, 'HTTPProxy');
    const httpPort = parseScutilValue(output, 'HTTPPort');

    const proxyUrl = httpsEnabled
      ? buildHttpProxyUrl(httpsProxy, httpsPort)
      : buildHttpProxyUrl(httpProxy, httpPort);

    if (proxyUrl) return { value: proxyUrl, source: 'system' };
  } catch {}
  return { value: '', source: '' };
}

export function resolveProxyUrl(env = process.env) {
  const explicit = firstProxyCandidate(env);
  if (explicit.source) return explicit;
  return resolveMacSystemProxy();
}

export function applyGlobalProxyFromEnv(options = {}) {
  const label = clean(options.label) || 'proxy';
  const { value, source } = resolveProxyUrl(options.env || process.env);
  if (!value) {
    console.log(`[${label}] disabled (direct connection)`);
    return { enabled: false, url: '', source: source || 'none' };
  }
  try {
    setGlobalDispatcher(new ProxyAgent(value));
    if (!process.env.DOLA_PROXY && source === 'system') {
      process.env.DOLA_PROXY = value;
    }
    console.log(`[${label}] using ${value}${source ? ` (${source})` : ''}`);
    return { enabled: true, url: value, source };
  } catch (error) {
    console.warn(`[${label}] failed (${value}): ${error.message}`);
    return { enabled: false, url: value, source, error };
  }
}