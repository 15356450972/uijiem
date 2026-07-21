import { spawn } from 'node:child_process';

const normalizeRuntimeHeaders = (headers) => {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('Banti runtime returned invalid request headers');
  }
  const allowed = ['User-Agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
  return Object.fromEntries(allowed
    .filter((name) => typeof headers[name] === 'string' && headers[name].length > 0)
    .map((name) => [name, headers[name]]));
};

const normalizeRuntimeFields = (fields) => {
  if (fields === undefined) return {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Banti runtime returned invalid mirror fields');
  }
  const extra = fields.extra && typeof fields.extra === 'object' && !Array.isArray(fields.extra)
    ? Object.fromEntries(['email', 'vip', 'reg_ts', 'deviceID', 'bid']
      .filter((name) => ['string', 'number'].includes(typeof fields.extra[name]))
      .map((name) => [name, fields.extra[name]]))
    : {};
  return {
    ...(typeof fields.ua === 'string' && fields.ua ? { ua: fields.ua } : {}),
    ...(fields.js_env === 'h5' ? { js_env: 'h5' } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
};

const normalizePayload = (result) => {
  const payload = typeof result === 'string' ? { jt: result, cookies: [], requestHeaders: {}, runtimeFields: {} } : result;
  if (!payload || typeof payload.jt !== 'string' || !payload.jt.startsWith('31$')) {
    throw new Error('Banti runtime returned an invalid jt');
  }
  if (payload.cookies !== undefined && !Array.isArray(payload.cookies)) {
    throw new Error('Banti runtime returned an invalid cookie snapshot');
  }
  return {
    jt: payload.jt,
    cookies: [...(payload.cookies || [])],
    requestHeaders: normalizeRuntimeHeaders(payload.requestHeaders),
    runtimeFields: normalizeRuntimeFields(payload.runtimeFields),
  };
};

export const createRuntimeCredential = (result, { dispose, ttl = 0 } = {}) => {
  let payload = normalizePayload(result);
  let disposed = false;
  const disposeOnce = async () => {
    if (disposed) return;
    disposed = true;
    await dispose?.();
  };
  const clear = (active) => {
    if (!active) return;
    active.jt = '';
    active.cookies.splice(0, active.cookies.length);
    for (const name of Object.keys(active.requestHeaders)) delete active.requestHeaders[name];
    if (active.runtimeFields?.extra) {
      for (const name of Object.keys(active.runtimeFields.extra)) delete active.runtimeFields.extra[name];
    }
    for (const name of Object.keys(active.runtimeFields || {})) delete active.runtimeFields[name];
  };
  const expiryTimer = ttl > 0 ? setTimeout(() => {
    const active = payload;
    payload = null;
    clear(active);
    void disposeOnce().catch(() => {});
  }, ttl) : null;
  expiryTimer?.unref?.();

  return Object.freeze({
    async use(consumer) {
      if (!payload) throw new Error('Banti runtime credential has already been consumed or expired');
      if (typeof consumer !== 'function') throw new Error('runtime credential consumer is required');
      if (expiryTimer) clearTimeout(expiryTimer);
      const active = payload;
      payload = null;
      try {
        return await consumer(active);
      } finally {
        clear(active);
        await disposeOnce();
      }
    },
  });
};

export const createCallbackJtProvider = (generate) => ({
  async generate(context) {
    const result = await generate(context);
    return createRuntimeCredential(result, {
      dispose: typeof result?.dispose === 'function' ? result.dispose : undefined,
      ttl: Number.isFinite(result?.ttl) ? result.ttl : 0,
    });
  },
});

export const createCommandJtProvider = ({ command, args = [], timeout = 30_000, env = {} }) =>
  createCallbackJtProvider((context) => new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error('A live Banti runtime command is required; historical jt values are not accepted'));
      return;
    }
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    });
    const response = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);
    child.stdio[3].on('data', (chunk) => response.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Banti runtime timed out after ${timeout}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Banti runtime exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(response).toString('utf8')));
      } catch (error) {
        reject(new Error(`Invalid Banti runtime response: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ action: 'generate-jt', subid: '', context }));
  }));

export const unavailableJtProvider = () => createCallbackJtProvider(async () => {
  throw new Error('Registration requires a live Banti browser runtime; offline jt generation is intentionally unsupported');
});