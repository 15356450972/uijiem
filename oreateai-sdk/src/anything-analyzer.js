import { randomUUID } from 'node:crypto';
import { encryptPassword } from './crypto.js';
import { HttpResponseError, sleep } from './http.js';
import { createCallbackJtProvider } from './jt.js';

const TARGET_URL = 'https://www.oreateai.com/home/vertical/aiVideo/zh';
const BOOTSTRAP_URL = 'https://www.oreateai.com/robots.txt';
const MCP_PROTOCOL_VERSION = '2025-03-26';

const parseResponse = async (response) => {
  const text = await response.text();
  if (!response.ok) throw new Error(`anything-analyzer MCP HTTP ${response.status}`);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]')
      .at(-1);
    if (!data) throw new Error('anything-analyzer MCP returned an empty event stream');
    return JSON.parse(data);
  }
  return text ? JSON.parse(text) : null;
};

const resultText = (response, label) => {
  if (response?.error) throw new Error(`${label} failed: ${response.error.message || 'unknown MCP error'}`);
  if (response?.result?.isError) {
    const message = response.result.content?.find((item) => item.type === 'text')?.text || 'unknown tool error';
    throw new Error(`${label} failed: ${message}`);
  }
  const text = response?.result?.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${label} returned no text result`);
  return JSON.parse(text);
};

class AnythingAnalyzerMcpClient {
  #url;
  #token;
  #sessionId;
  #requestId = 0;
  #timeout;

  constructor({ url, token, timeout }) {
    this.#url = url;
    this.#token = token;
    this.#timeout = timeout;
  }

  async #send(body, { initialize = false, method = 'POST' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await fetch(this.#url, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
          ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
      if (initialize) {
        this.#sessionId = response.headers.get('mcp-session-id');
        if (!this.#sessionId) throw new Error('anything-analyzer MCP did not establish a session');
      }
      return await parseResponse(response);
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`anything-analyzer MCP timed out after ${this.#timeout}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async connect() {
    const response = await this.#send({
      jsonrpc: '2.0',
      id: ++this.#requestId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'oreateai-sdk', version: '0.1.0' },
      },
    }, { initialize: true });
    if (response?.error) throw new Error(`anything-analyzer MCP initialization failed: ${response.error.message}`);
    await this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async callTool(name, args = {}) {
    const response = await this.#send({
      jsonrpc: '2.0',
      id: ++this.#requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return resultText(response, name);
  }

  async close() {
    if (!this.#sessionId) return;
    try {
      await this.#send(undefined, { method: 'DELETE' });
    } finally {
      this.#sessionId = null;
    }
  }
}

const evaluate = (client, expression, { awaitPromise = false, timeout = 10_000 } = {}) =>
  client.callTool('cdp_send_command', {
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise, returnByValue: true, timeout },
  });

const waitForRuntime = async (client, { timeout, pollInterval }) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await evaluate(client, `({
        ready: document.readyState === 'complete',
        hasRuntime: Boolean(globalThis.paris_2146?.sendBantiReport)
      })`);
      const state = response?.result?.value;
      if (state?.ready && state?.hasRuntime) return;
    } catch {
      // Navigation and CDP reattachment can briefly make Runtime unavailable.
    }
    await sleep(pollInterval);
  }
  throw new Error(`OreateAI Banti runtime was not ready after ${timeout}ms`);
};

const syncApiCookiesToBrowser = async (client, cookies) => {
  if (!Array.isArray(cookies) || cookies.length === 0) return;
  await client.callTool('cdp_send_command', { method: 'Network.clearBrowserCookies', params: {} });
  await client.callTool('cdp_send_command', {
    method: 'Network.setCookies',
    params: { cookies },
  });
};

const readOreateCookies = async (client) => {
  const cookieResult = await client.callTool('cdp_send_command', {
    method: 'Network.getAllCookies',
    params: {},
  });
  return (cookieResult?.cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'oreateai.com' || domain.endsWith('.oreateai.com');
  });
};

const readRuntimeRequestHeaders = async (client) => {
  const response = await evaluate(client, `(() => {
    const data = navigator.userAgentData;
    const quote = (value) => '"' + String(value).replaceAll('"', '\\"') + '"';
    const brands = data?.brands?.map(({ brand, version }) => quote(brand) + ';v=' + quote(version)).join(', ');
    return {
      'User-Agent': navigator.userAgent,
      ...(brands ? { 'sec-ch-ua': brands } : {}),
      ...(data ? {
        'sec-ch-ua-mobile': data.mobile ? '?1' : '?0',
        'sec-ch-ua-platform': quote(data.platform),
      } : {}),
    };
  })()`);
  const headers = response?.result?.value;
  if (!headers || typeof headers['User-Agent'] !== 'string') {
    throw new Error('OreateAI runtime returned no request fingerprint');
  }
  return headers;
};

const requestJt = async (client, timeout) => {
  const expression = `new Promise((resolve, reject) => {
    const runtime = globalThis.paris_2146;
    if (!runtime?.sendBantiReport) {
      reject(new Error('Banti runtime is unavailable'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('Banti callback timed out')), ${timeout});
    runtime.sendBantiReport({ subid: '' }, (first, second) => {
      clearTimeout(timer);
      const result = second ?? first;
      const jt = result?.htj?.jt;
      if (typeof jt !== 'string' || !jt.startsWith('31$')) {
        reject(new Error('Banti callback returned no valid jt'));
        return;
      }
      resolve(jt);
    });
  })`;
  const response = await evaluate(client, expression, { awaitPromise: true, timeout: timeout + 1_000 });
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'unknown runtime exception';
    throw new Error(`Banti runtime evaluation failed: ${String(detail).slice(0, 300)}`);
  }
  const jt = response?.result?.value;
  if (typeof jt !== 'string' || !jt.startsWith('31$')) throw new Error('Banti runtime returned an invalid jt');
  return jt;
};

const requestRuntimeCredential = async (client, timeout) => {
  const jt = await requestJt(client, timeout);
  const requestHeaders = await readRuntimeRequestHeaders(client);
  const cookies = await readOreateCookies(client);
  return { jt, cookies, requestHeaders };
};

const browserJsonRequest = async (client, path, { method = 'GET', body } = {}) => {
  const expression = `fetch(${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)},
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Cache-Control': 'no-cache, no-store',
      'Client-Type': 'pc',
      Locale: 'zh-CN',
      Pragma: 'no-cache',
      ...(${JSON.stringify(method === 'POST')} ? {
        'Content-Type': 'application/json',
      } : {}),
    },
    ...(${JSON.stringify(method === 'POST')} ? { body: JSON.stringify(${JSON.stringify(body)}) } : {}),
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    return {
      httpStatus: response.status,
      siteCode: payload?.status?.code ?? null,
      data: payload?.data ?? null,
    };
  })`;
  const response = await evaluate(client, expression, { awaitPromise: true, timeout: 30_000 });
  const value = response?.result?.value;
  if (!value || !Number.isInteger(value.httpStatus)) throw new Error(`${path} returned no response`);
  if (value.httpStatus < 200 || value.httpStatus >= 300 || (value.siteCode !== null && value.siteCode !== 0)) {
    throw new HttpResponseError(`${path} rejected`, {
      label: path,
      httpStatus: value.httpStatus,
      siteCode: value.siteCode,
    });
  }
  return value.data ?? {};
};

const protocolSignup = async (
  client,
  {
    email,
    password,
    runtimeTimeout,
    onTicket = () => {},
    onRisk = () => {},
    onSubmit = () => {},
  },
) => {
  onTicket();
  const ticket = requireTicket(await browserJsonRequest(client, '/passport/api/getticket'));
  const encryptedPassword = encryptPassword(password, ticket.pk);
  onRisk();
  const jt = await requestJt(client, runtimeTimeout);
  onSubmit();
  const signup = await browserJsonRequest(client, '/passport/api/emailsignupin', {
    method: 'POST',
    body: {
      fr: 'main',
      email,
      ticketID: ticket.ticketID,
      password: encryptedPassword,
      jt,
    },
  });
  return {
    ticket: { ticketID: ticket.ticketID },
    encryptedPassword,
    signup,
  };
};

class BrowserTransactionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserTransactionError';
  }
}

const requireSessionId = (value) => {
  if (typeof value?.id !== 'string' || value.id.length === 0) {
    throw new BrowserTransactionError('MCP session creation returned an invalid descriptor');
  }
  return value.id;
};

const requireTicket = (value) => {
  if (typeof value?.ticketID !== 'string' || value.ticketID.length === 0 || typeof value.pk !== 'string' || value.pk.length === 0) {
    throw new BrowserTransactionError('getticket returned an invalid descriptor');
  }
  return value;
};

const createBrowserSession = async ({ url, token, requestTimeout, pageTimeout, pollInterval, cookies, clientFactory = (options) => new AnythingAnalyzerMcpClient(options) }) => {
  const client = clientFactory({ url, token, timeout: requestTimeout });
  let analyzerSessionId;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (analyzerSessionId) {
      await client.callTool('stop_private_cdp', { sessionId: analyzerSessionId }).catch(() => {});
      await client.callTool('delete_session', { sessionId: analyzerSessionId }).catch(() => {});
    }
    await client.close().catch(() => {});
  };

  try {
    await client.connect();
    const analyzerSession = await client.callTool('create_session', {
      name: `oreateai-runtime-${randomUUID()}`,
      targetUrl: BOOTSTRAP_URL,
    });
    analyzerSessionId = requireSessionId(analyzerSession);
    await client.callTool('start_private_cdp', { sessionId: analyzerSessionId });
    await syncApiCookiesToBrowser(client, cookies);
    await client.callTool('navigate', { url: TARGET_URL });
    await waitForRuntime(client, { timeout: pageTimeout, pollInterval });
    return { client, analyzerSessionId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export const createAnythingAnalyzerJtProvider = ({
  url = process.env.ANYTHING_ANALYZER_MCP_URL || 'http://localhost:23816/mcp',
  token = process.env.ANYTHING_ANALYZER_MCP_TOKEN,
  requestTimeout = 30_000,
  pageTimeout = 45_000,
  runtimeTimeout = 10_000,
  pollInterval = 500,
  clientFactory,
} = {}) => {
  const generate = createCallbackJtProvider(async (context) => {
    const session = await createBrowserSession({
      url,
      token,
      requestTimeout,
      pageTimeout,
      pollInterval,
      cookies: context?.cookies,
      clientFactory,
    });
    try {
      const credential = await requestRuntimeCredential(session.client, runtimeTimeout);
      return { ...credential, ttl: 15_000, dispose: session.cleanup };
    } catch (error) {
      await session.cleanup();
      throw error;
    }
  });

  return {
    ...generate,
    async probe() {
      const session = await createBrowserSession({
        url,
        token,
        requestTimeout,
        pageTimeout,
        pollInterval,
        cookies: [],
        clientFactory,
      });
      try {
        requireTicket(await browserJsonRequest(session.client, '/passport/api/getticket', {}));
        return {
          privateSession: true,
          ticketReady: true,
          submitted: false,
        };
      } finally {
        await session.cleanup();
      }
    },
    async register({ email, password, onTicket = () => {}, onRisk = () => {}, onSubmit = () => {} }) {
      const session = await createBrowserSession({
        url,
        token,
        requestTimeout,
        pageTimeout,
        pollInterval,
        cookies: [],
        clientFactory,
      });
      try {
        const result = await protocolSignup(session.client, {
          email,
          password,
          runtimeTimeout,
          onTicket,
          onRisk,
          onSubmit,
        });
        const cookies = await readOreateCookies(session.client);
        return { ...result, cookies };
      } finally {
        await session.cleanup();
      }
    },
  };
};