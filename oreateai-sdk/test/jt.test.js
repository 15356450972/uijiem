import assert from 'node:assert/strict';
import test from 'node:test';
import { createCallbackJtProvider, createCommandJtProvider, createRuntimeCredential } from '../src/jt.js';

test('runtime credential is single-use and clears scoped values after consumption', async () => {
  const credential = createRuntimeCredential({
    jt: '31$one-time',
    cookies: [{ name: 'sid', value: 'secret', domain: '.oreateai.com', path: '/' }],
    requestHeaders: {
      'User-Agent': 'runtime-agent',
      'sec-ch-ua-platform': '"macOS"',
      Authorization: 'must-not-cross-boundary',
    },
  });
  let scoped;
  await credential.use(async (payload) => {
    scoped = payload;
    assert.equal(payload.jt, '31$one-time');
    assert.equal(payload.cookies.length, 1);
    assert.equal(payload.requestHeaders['User-Agent'], 'runtime-agent');
    assert.equal(payload.requestHeaders.Authorization, undefined);
  });

  assert.equal(scoped.jt, '');
  assert.equal(scoped.cookies.length, 0);
  assert.deepEqual(scoped.requestHeaders, {});
  await assert.rejects(() => credential.use(async () => {}), /already been consumed/);
});

test('runtime credential disposes only after the consumer finishes', async () => {
  const order = [];
  const credential = createRuntimeCredential('31$scoped', {
    dispose: async () => order.push('dispose'),
  });
  await credential.use(async () => {
    order.push('submit:start');
    await Promise.resolve();
    order.push('submit:end');
  });
  assert.deepEqual(order, ['submit:start', 'submit:end', 'dispose']);
});

test('callback provider rejects missing or malformed runtime jt', async () => {
  const provider = createCallbackJtProvider(async () => ({ cookies: [] }));
  await assert.rejects(() => provider.generate({}), /invalid jt/);
});

test('command provider terminates a runtime that exceeds its deadline', async () => {
  const provider = createCommandJtProvider({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeout: 30,
  });
  await assert.rejects(() => provider.generate({}), /timed out/);
});