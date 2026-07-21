import { constants, publicEncrypt } from 'node:crypto';

export const encryptPassword = (password, publicKey) => {
  if (!password) throw new Error('password is required');
  if (!publicKey?.includes('BEGIN RSA PUBLIC KEY')) {
    throw new Error('invalid RSA public key');
  }

  const encrypted = publicEncrypt({
    key: publicKey,
    padding: constants.RSA_PKCS1_PADDING,
  }, Buffer.from(password, 'utf8'));

  if (encrypted.length !== 256) {
    throw new Error(`unexpected RSA ciphertext length: ${encrypted.length}`);
  }
  return encrypted.toString('base64');
};