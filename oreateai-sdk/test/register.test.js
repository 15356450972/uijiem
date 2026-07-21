import assert from 'node:assert/strict';
import test from 'node:test';
import { createPassword, isValidPassword, registerAccount } from '../src/register.js';

test('generated passwords satisfy the current OreateAI policy', () => {
  for (let index = 0; index < 1000; index += 1) {
    const password = createPassword();
    assert.equal(isValidPassword(password), true);
    assert.ok(password.length >= 8 && password.length <= 16);
  }
});

test('registration keeps ticket, risk proof and signup inside one browser transaction', async () => {
  const calls = [];
  const client = {
    importBrowserCookies: (cookies) => calls.push(['cookies', cookies.map((cookie) => ({ ...cookie }))]),
    visitVerificationLink: async () => calls.push('visit'),
    checkEmailVerified: async (context) => {
      calls.push(['check', context]);
      return { isLogin: true, isNeedRetry: false };
    },
  };
  const browserProvider = {
    register: async ({ email, password, onTicket, onRisk, onSubmit }) => {
      calls.push(['browser:start', { email, password }]);
      onTicket();
      calls.push('browser:ticket');
      onRisk();
      calls.push('browser:risk');
      onSubmit();
      calls.push('browser:submit');
      return {
        ticket: { ticketID: 'browser-ticket' },
        encryptedPassword: 'browser-encrypted-password',
        signup: { isRegister: true },
        cookies: [{ name: 'OUID', value: 'browser-session', domain: '.oreateai.com', path: '/' }],
      };
    },
  };

  const result = await registerAccount({
    password: 'Fresh-Aa1!',
    mailboxFactory: async () => ({ email: 'fresh@example.test' }),
    verificationLinkWaiter: async () => 'https://www.oreateai.com/verify/fresh',
    clientFactory: () => client,
    jtProvider: browserProvider,
    pollInterval: 0,
  });

  assert.equal(result.status, 'registered');
  assert.equal(calls.some((call) => call === 'bootstrap'), false);
  assert.deepEqual(calls.slice(1, 5), ['browser:ticket', 'browser:risk', 'browser:submit', ['cookies', [{ name: 'OUID', value: 'browser-session', domain: '.oreateai.com', path: '/' }]]]);
  const check = calls.find((call) => Array.isArray(call) && call[0] === 'check')[1];
  assert.equal(check.ticketID, 'browser-ticket');
  assert.equal(check.encryptedPassword, 'browser-encrypted-password');
});

test('registration uses Microsoft OAuth credentials with the apple mail provider', async () => {
  let receivedMailbox = null;
  const result = await registerAccount({
    mailboxCredentials: {
      email: 'channel8@example.com',
      client_id: 'client-123',
      refresh_token: 'refresh-456',
    },
    password: 'Fresh-Aa1!',
    verificationLinkWaiter: async (mailbox) => {
      receivedMailbox = mailbox;
      return 'https://www.oreateai.com/verify?email=channel8%40example.com&tokenID=token';
    },
    clientFactory: () => ({
      visitVerificationLink: async () => {},
      checkEmailVerified: async () => ({ isLogin: true, isNeedRetry: false }),
    }),
    jtProvider: {
      register: async () => ({
        ticket: { ticketID: 'browser-ticket' },
        encryptedPassword: 'browser-encrypted-password',
        signup: { isRegister: true },
        cookies: [],
      }),
    },
    pollInterval: 0,
  });

  assert.equal(result.status, 'registered');
  assert.equal(receivedMailbox.email, 'channel8@example.com');
  assert.equal(receivedMailbox.clientId, 'client-123');
  assert.equal(receivedMailbox.refreshToken, 'refresh-456');
  assert.equal(receivedMailbox.apiUrl, 'https://apple.882263.xyz/api/mail-new');
});

test('registration rejects an incomplete browser transaction before email verification', async () => {
  await assert.rejects(
    () => registerAccount({
      email: 'fresh@example.test',
      password: 'Fresh-Aa1!',
      clientFactory: () => ({}),
      jtProvider: { register: async () => ({ ticket: {}, signup: {} }) },
    }),
    /incomplete verification context/,
  );
});