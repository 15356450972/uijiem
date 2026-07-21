import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createAnythingAnalyzerJtProvider } from '../src/anything-analyzer.js';

test('browser transaction rejects an invalid session descriptor and closes its MCP client', async () => {
  const calls = [];
  const client = {
    connect: async () => calls.push('connect'),
    callTool: async (name) => {
      calls.push(name);
      if (name === 'create_session') return {};
      throw new Error(`unexpected tool: ${name}`);
    },
    close: async () => calls.push('close'),
  };
  const provider = createAnythingAnalyzerJtProvider({
    clientFactory: () => client,
  });

  await assert.rejects(
    () => provider.register({ email: 'fresh@example.test', password: 'Fresh-Aa1!' }),
    (error) => error?.name === 'BrowserTransactionError',
  );
  assert.deepEqual(calls, ['connect', 'create_session', 'close']);
});

test('browser transaction probe fetches only a ticket and always clears its private session', async () => {
  const calls = [];
  let evaluation = 0;
  const client = {
    connect: async () => calls.push('connect'),
    callTool: async (name, args) => {
      calls.push(name);
      if (name === 'create_session') return { id: 'private-session' };
      if (name === 'start_private_cdp' || name === 'navigate') return { success: true };
      if (name === 'cdp_send_command') {
        evaluation += 1;
        if (evaluation === 1) {
          return { result: { value: { ready: true, hasRuntime: true } } };
        }
        assert.match(args.params.expression, /\/passport\/api\/getticket/);
        assert.doesNotMatch(args.params.expression, /emailsignupin/);
        return {
          result: {
            value: {
              httpStatus: 200,
              siteCode: 0,
              data: { ticketID: 'fresh-ticket', pk: 'runtime-public-key' },
            },
          },
        };
      }
      if (name === 'stop_private_cdp' || name === 'delete_session') return { success: true };
      throw new Error(`unexpected tool: ${name}`);
    },
    close: async () => calls.push('close'),
  };
  const provider = createAnythingAnalyzerJtProvider({
    clientFactory: () => client,
  });

  const result = await provider.probe();

  assert.deepEqual(result, {
    privateSession: true,
    ticketReady: true,
    submitted: false,
  });
  assert.deepEqual(calls, [
    'connect',
    'create_session',
    'start_private_cdp',
    'navigate',
    'cdp_send_command',
    'cdp_send_command',
    'stop_private_cdp',
    'delete_session',
    'close',
  ]);
});

test('browser transaction submits registration through the page protocol without DOM automation', async () => {
  const calls = [];
  let evaluation = 0;
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const client = {
    connect: async () => calls.push('connect'),
    callTool: async (name, args) => {
      calls.push(name);
      if (name === 'create_session') return { id: 'private-session' };
      if (name === 'start_private_cdp' || name === 'navigate') return { success: true };
      if (name === 'cdp_send_command') {
        if (args.method === 'Network.getAllCookies') return { cookies: [] };
        evaluation += 1;
        if (evaluation === 1) {
          return { result: { value: { ready: true, hasRuntime: true } } };
        }
        if (evaluation === 2) {
          assert.match(args.params.expression, /\/passport\/api\/getticket/);
          assert.doesNotMatch(args.params.expression, /emailsignupin/);
          return {
            result: {
              value: {
                httpStatus: 200,
                siteCode: 0,
                data: { ticketID: 'protocol-ticket', pk: publicKey },
              },
            },
          };
        }
        if (evaluation === 3) {
          assert.match(args.params.expression, /sendBantiReport/);
          assert.doesNotMatch(args.params.expression, /querySelector|\.click\(|InputEvent/);
          return { result: { value: '31$runtime-jt' } };
        }
        assert.equal(evaluation, 4);
        assert.match(args.params.expression, /\/passport\/api\/emailsignupin/);
        assert.match(args.params.expression, /protocol-ticket/);
        assert.match(args.params.expression, /31\$runtime-jt/);
        assert.doesNotMatch(args.params.expression, /querySelector|\.click\(|InputEvent/);
        return {
          result: {
            value: {
              httpStatus: 200,
              siteCode: 0,
              data: { isRegister: true },
            },
          },
        };
      }
      if (name === 'stop_private_cdp' || name === 'delete_session') return { success: true };
      throw new Error(`unexpected tool: ${name}`);
    },
    close: async () => calls.push('close'),
  };
  const provider = createAnythingAnalyzerJtProvider({
    clientFactory: () => client,
  });

  const result = await provider.register({
    email: 'fresh@example.test',
    password: 'Fresh-Aa1!',
  });

  assert.deepEqual(result.ticket, { ticketID: 'protocol-ticket' });
  assert.equal(result.encryptedPassword.length, 344);
  assert.deepEqual(result.signup, { isRegister: true });
  assert.deepEqual(result.cookies, []);
  assert.deepEqual(calls.slice(-3), ['stop_private_cdp', 'delete_session', 'close']);
});

test('browser transaction uses private CDP and clears it on setup failure', async () => {
  const calls = [];
  const client = {
    connect: async () => calls.push('connect'),
    callTool: async (name) => {
      calls.push(name);
      if (name === 'create_session') return { id: 'private-session' };
      if (name === 'start_private_cdp') throw new Error('private CDP unavailable');
      if (name === 'stop_private_cdp' || name === 'delete_session') return { success: true };
      throw new Error(`unexpected tool: ${name}`);
    },
    close: async () => calls.push('close'),
  };
  const provider = createAnythingAnalyzerJtProvider({
    clientFactory: () => client,
  });

  await assert.rejects(
    () => provider.register({ email: 'fresh@example.test', password: 'Fresh-Aa1!' }),
    /private CDP unavailable/,
  );
  assert.deepEqual(calls, ['connect', 'create_session', 'start_private_cdp', 'stop_private_cdp', 'delete_session', 'close']);
});