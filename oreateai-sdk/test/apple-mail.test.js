import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAppleMailbox,
  extractAppleVerificationLink,
  listAppleEmails,
  waitForAppleVerificationLink,
} from '../src/apple-mail.js';

const credentials = {
  email: 'channel8@example.com',
  client_id: 'client-123',
  refresh_token: 'refresh-456',
};

test('apple mailbox requires all Microsoft OAuth fields', () => {
  assert.throws(() => createAppleMailbox({ email: credentials.email }), /client_id is required/);
  assert.throws(
    () => createAppleMailbox({ email: credentials.email, client_id: credentials.client_id }),
    /refresh_token is required/,
  );
});

test('apple mailbox reads INBOX and Junk with credentials in POST body', async () => {
  const calls = [];
  const mailbox = createAppleMailbox(credentials, {
    requestFn: async (options) => {
      calls.push(options);
      return {
        status: 200,
        data: options.body.mailbox === 'INBOX'
          ? { subject: 'inbox', html: '<p>first</p>' }
          : [{ subject: 'junk', html: '<p>second</p>' }],
      };
    },
  });

  const messages = await listAppleEmails(mailbox);

  assert.deepEqual(messages.map(({ subject, mailbox: folder }) => [subject, folder]), [
    ['inbox', 'INBOX'],
    ['junk', 'Junk'],
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.method === 'POST'));
  assert.ok(calls.every((call) => !call.url.includes(credentials.refresh_token)));
  assert.deepEqual(calls.map((call) => call.body.mailbox).sort(), ['INBOX', 'Junk']);
  assert.ok(calls.every((call) => call.body.client_id === credentials.client_id));
  assert.ok(calls.every((call) => call.body.refresh_token === credentials.refresh_token));
});

test('apple mailbox still returns mail when one folder request fails', async () => {
  const mailbox = createAppleMailbox(credentials, {
    requestFn: async ({ body }) => {
      if (body.mailbox === 'INBOX') return { status: 500, data: { error: 'inbox unavailable' } };
      return { status: 200, data: { subject: 'verification', text: 'ready' } };
    },
  });

  const messages = await listAppleEmails(mailbox);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].mailbox, 'Junk');
});

test('verification parser extracts the matching OreateAI link from HTML', () => {
  const link = extractAppleVerificationLink({
    html: '<a href="https://www.oreateai.com/passport/verify?email=channel8%40example.com&amp;tokenID=123e4567-e89b-12d3-a456-426614174000">Verify</a>',
  }, { expectedEmail: credentials.email });

  assert.ok(link.startsWith('https://www.oreateai.com/passport/verify?'));
  assert.equal(new URL(link).searchParams.get('email'), credentials.email);
  assert.equal(new URL(link).searchParams.get('tokenID'), '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(
    extractAppleVerificationLink({
      html: '<a href="https://www.oreateai.com/passport/verify?email=other%40example.com&tokenID=wrong">Verify</a>',
    }, { expectedEmail: credentials.email }),
    '',
  );
});

test('verification waiter polls both folders and returns the current account link', async () => {
  let rounds = 0;
  const mailbox = createAppleMailbox(credentials, {
    requestFn: async ({ body }) => {
      if (body.mailbox === 'INBOX') {
        rounds += 1;
        return { status: 200, data: [] };
      }
      return {
        status: 200,
        data: rounds < 2 ? [] : {
          date: new Date().toISOString(),
          subject: 'Verify your email',
          html: 'https://www.oreateai.com/verify?email=channel8%40example.com&tokenID=token-current',
        },
      };
    },
  });

  const link = await waitForAppleVerificationLink(mailbox, {
    timeout: 500,
    interval: 0,
    after: Date.now() - 1_000,
  });

  assert.equal(new URL(link).searchParams.get('tokenID'), 'token-current');
  assert.ok(rounds >= 2);
});
