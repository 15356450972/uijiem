import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieJar, HttpResponseError, assertSuccess } from '../src/http.js';

const NOW = Date.parse('2026-07-12T00:00:00Z');

test('CookieJar merges browser cookies with domain, path, secure and expiry rules', () => {
  const jar = new CookieJar();
  jar.absorb({
    'set-cookie': [
      'host=api; Path=/passport; Secure; HttpOnly',
      'expired=gone; Path=/; Max-Age=0',
    ],
  }, 'https://www.oreateai.com/passport/bootstrap', NOW);
  jar.importBrowserCookies([
    { name: 'shared', value: 'browser', domain: '.oreateai.com', path: '/', secure: true, expires: (NOW / 1000) + 60 },
    { name: 'other', value: 'ignored', domain: '.example.com', path: '/' },
    { name: 'stale', value: 'ignored', domain: '.oreateai.com', path: '/', expires: (NOW / 1000) - 1 },
  ], NOW);

  assert.equal(
    jar.header('https://www.oreateai.com/passport/api/getticket', NOW),
    'host=api; shared=browser',
  );
  assert.equal(jar.header('https://api.oreateai.com/passport/api/getticket', NOW), 'shared=browser');
  assert.equal(jar.header('http://www.oreateai.com/passport/api/getticket', NOW), '');
  assert.equal(jar.header('https://www.oreateai.com/home', NOW), 'shared=browser');
  const browserCookies = jar.browserSnapshot(NOW);
  assert.equal(browserCookies.find((cookie) => cookie.name === 'host').url, 'https://www.oreateai.com/passport');
  assert.equal(browserCookies.find((cookie) => cookie.name === 'shared').domain, '.oreateai.com');
  assert.equal(jar.header('https://www.oreateai.com/home', NOW + 61_000), '');
});

test('assertSuccess exposes structured failure metadata without embedding response bodies', () => {
  assert.throws(
    () => assertSuccess({ status: 403, text: 'sensitive body', data: null }, '/signup'),
    (error) => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.httpStatus, 403);
      assert.equal(error.siteCode, null);
      assert.equal(error.message.includes('sensitive body'), false);
      return true;
    },
  );

  assert.throws(
    () => assertSuccess({
      status: 200,
      text: '',
      data: { status: { code: 1001, errMsg: 'site rejection' } },
    }, '/signup'),
    (error) => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.httpStatus, 200);
      assert.equal(error.siteCode, 1001);
      assert.equal(error.siteMessage, 'site rejection');
      assert.equal(error.message.includes('site rejection'), false);
      return true;
    },
  );
});

test('CookieJar replaces matching browser snapshot cookies without duplicating headers', () => {
  const jar = new CookieJar();
  jar.importBrowserCookies([
    { name: 'sid', value: 'old', domain: '.oreateai.com', path: '/' },
    { name: 'sid', value: 'fresh', domain: '.oreateai.com', path: '/' },
  ], NOW);

  assert.equal(jar.header('https://www.oreateai.com/', NOW), 'sid=fresh');
});