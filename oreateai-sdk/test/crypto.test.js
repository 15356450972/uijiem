import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import test from 'node:test';
import { encryptPassword } from '../src/crypto.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

test('encryptPassword matches JSEncrypt PKCS#1 v1.5 shape', () => {
  const password = '授权测试-Aa1!';
  const ciphertext = encryptPassword(password, publicKey);
  assert.equal(Buffer.from(ciphertext, 'base64').length, 256);
  const encoded = privateDecrypt({
    key: privateKey,
    padding: constants.RSA_NO_PADDING,
  }, Buffer.from(ciphertext, 'base64'));
  assert.equal(encoded[0], 0);
  assert.equal(encoded[1], 2);
  const separator = encoded.indexOf(0, 2);
  assert.ok(separator >= 10);
  assert.equal(encoded.subarray(separator + 1).toString('utf8'), password);
});