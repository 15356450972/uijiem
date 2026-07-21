import { randomInt } from 'node:crypto';
import { encryptPassword } from './crypto.js';
import { createAppleMailbox, waitForAppleVerificationLink } from './apple-mail.js';
import { createOreateClient } from './oreateai.js';
import { sleep } from './http.js';
import { unavailableJtProvider } from './jt.js';

const DIGITS = '0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SPECIALS = '!@#$%^&*';
const PASSWORD_CHARS = `${DIGITS}${LETTERS}${SPECIALS}`;

const randomChar = (chars) => chars[randomInt(0, chars.length)];

export const isValidPassword = (password) => (
  typeof password === 'string'
  && /^(?=.*\d)(?=.*[A-Za-z])(?=.*[^A-Za-z0-9]).{8,16}$/.test(password)
);

export const createPassword = () => {
  const length = randomInt(8, 17);
  const chars = [randomChar(DIGITS), randomChar(LETTERS), randomChar(SPECIALS)];
  while (chars.length < length) chars.push(randomChar(PASSWORD_CHARS));
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const target = randomInt(0, index + 1);
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join('');
};

const completeVerification = async ({
  client,
  mailbox,
  accountEmail,
  password,
  signup,
  ticket,
  encryptedPassword,
  verificationLinkWaiter,
  mailTimeout,
  maxPolls,
  pollInterval,
  transition,
}) => {
  if (!mailbox) {
    return {
      status: 'waiting_for_external_verification',
      email: accountEmail,
      password,
      signup,
    };
  }

  transition('email:wait');
  const verificationUrl = await verificationLinkWaiter(mailbox, { timeout: mailTimeout });
  transition('email:verify');
  await client.visitVerificationLink(verificationUrl);

  const verificationContext = {
    email: accountEmail,
    ticketID: ticket.ticketID,
    encryptedPassword,
  };
  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    transition('verification:poll', { attempt });
    const status = await client.checkEmailVerified(verificationContext);
    if (status.isLogin === true) {
      transition('complete');
      return {
        status: 'registered',
        email: accountEmail,
        password,
        signup,
        session: status,
      };
    }
    if (status.isNeedRetry === false) throw new Error('verification terminated by site');
    await sleep(pollInterval);
  }
  throw new Error(`verification timeout after ${maxPolls} polls`);
};

const submitInBrowser = async ({
  provider,
  email,
  password,
  transition,
}) => {
  transition('session:browser');
  const result = await provider.register({
    email,
    password,
    onTicket: () => transition('ticket:request'),
    onRisk: () => transition('risk:request'),
    onSubmit: () => transition('signup:submit'),
  });
  if (!result?.ticket?.ticketID || !result.encryptedPassword || !result.signup) {
    throw new Error('browser registration returned incomplete verification context');
  }
  if (result.signup.isRegister !== true && result.signup.sendEmailCount === undefined) {
    throw new Error('registration did not enter email verification state');
  }
  return result;
};

const submitWithLegacyProvider = async ({
  client,
  provider,
  email,
  password,
  transition,
}) => {
  transition('session:bootstrap');
  await client.bootstrap();
  transition('ticket:request');
  const ticket = await client.getTicket();
  const encryptedPassword = encryptPassword(password, ticket.pk);

  transition('risk:request');
  const runtimeCredential = await provider.generate({
    origin: 'https://www.oreateai.com',
    path: '/passport/api/emailsignupin',
    method: 'POST',
    cookies: typeof client.exportBrowserCookies === 'function' ? client.exportBrowserCookies() : [],
  });
  if (!runtimeCredential || typeof runtimeCredential.use !== 'function') {
    throw new Error('jtProvider must return a one-time runtime credential');
  }

  let signup;
  await runtimeCredential.use(async ({ jt, cookies, requestHeaders }) => {
    if (cookies.length > 0) {
      if (typeof client.importBrowserCookies !== 'function') {
        throw new Error('OreateAI client cannot import the browser cookie snapshot');
      }
      client.importBrowserCookies(cookies);
    }
    transition('signup:submit');
    signup = await client.emailSignup({
      email,
      ticketID: ticket.ticketID,
      encryptedPassword,
      jt,
      requestHeaders,
    });
  });
  if (signup.isRegister !== true && signup.sendEmailCount === undefined) {
    throw new Error('registration did not enter email verification state');
  }
  return { ticket, encryptedPassword, signup, cookies: [] };
};

export const registerAccount = async ({
  email,
  mailboxCredentials = {},
  password = createPassword(),
  jtProvider = unavailableJtProvider(),
  mailboxFactory,
  verificationLinkWaiter = waitForAppleVerificationLink,
  clientFactory = createOreateClient,
  pollInterval = 2_000,
  maxPolls = 300,
  mailTimeout = 120_000,
  onState = () => {},
} = {}) => {
  const transition = (state, detail = {}) => onState({ state, ...detail });
  const mailbox = email
    ? null
    : await (mailboxFactory ? mailboxFactory() : createAppleMailbox(mailboxCredentials));
  const accountEmail = email || mailbox?.email;
  if (!accountEmail) throw new Error('email is required');

  const client = clientFactory();
  const browserProvider = typeof jtProvider.register === 'function' ? jtProvider : null;
  const registration = browserProvider
    ? await submitInBrowser({ provider: browserProvider, email: accountEmail, password, transition })
    : await submitWithLegacyProvider({ client, provider: jtProvider, email: accountEmail, password, transition });

  if (registration.cookies?.length > 0) {
    if (typeof client.importBrowserCookies !== 'function') {
      throw new Error('OreateAI client cannot import the browser cookie snapshot');
    }
    client.importBrowserCookies(registration.cookies);
  }

  return completeVerification({
    client,
    mailbox,
    accountEmail,
    password,
    signup: registration.signup,
    ticket: registration.ticket,
    encryptedPassword: registration.encryptedPassword,
    verificationLinkWaiter,
    mailTimeout,
    maxPolls,
    pollInterval,
    transition,
  });
};