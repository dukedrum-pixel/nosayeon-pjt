import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SONG_ID, RESULT_TOKEN } from './identifiers.mjs';
import { publicResultOrigin } from './result-link.mjs';
import { validEmail } from './gmail-delivery.mjs';

function keyBytes(key) {
  const bytes = typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key) ? Buffer.from(key, 'base64url') : null;
  if (bytes?.length !== 32 || bytes.toString('base64url') !== key) throw new Error('invalid_notification_key');
  return bytes;
}
function associatedData({ songId, recipient, origin }) {
  if (!SONG_ID.test(songId ?? '') || !validEmail(recipient)) throw new Error('invalid_notification_setting');
  return Buffer.from(JSON.stringify(['nosayeon-result-token-v1', songId, recipient, publicResultOrigin(origin)]));
}
export function validateNotificationKey(key) { keyBytes(key); }
export function sealResultToken({ token, key, ...context }) {
  if (!RESULT_TOKEN.test(token ?? '')) throw new Error('invalid_result_token');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyBytes(key), nonce);
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function openResultToken({ sealedToken, key, ...context }) {
  try {
    if (typeof sealedToken !== 'string' || !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$/.test(sealedToken)) throw new Error();
    const [, nonce, tag, body] = sealedToken.split('.');
    if ([nonce, tag, body].some(part => Buffer.from(part, 'base64url').toString('base64url') !== part)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(associatedData(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const token = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    if (!RESULT_TOKEN.test(token)) throw new Error();
    return token;
  } catch { throw new Error('notification_secret_unavailable'); }
}
