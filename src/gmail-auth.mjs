import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SCOPES = [GMAIL_SCOPE, 'openid', 'email'];

export class GmailAuthError extends Error {
  constructor(code = 'mail_auth_failed') { super(code); this.code = code; }
}

export async function googleJson(response) {
  try {
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 16384) throw new Error();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new GmailAuthError(); }
}

export function validAccessToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,8192}$/.test(value);
}

export async function verifyGoogleSender({ accessToken, sender, fetchImpl = fetch, timeoutMs = 30000 }) {
  try {
    if (!validAccessToken(accessToken)) throw new Error();
    const identity = await googleJson(await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    }));
    if (identity.email_verified !== true || typeof identity.email !== 'string'
      || identity.email.toLowerCase() !== sender.toLowerCase()) throw new GmailAuthError('mail_account_mismatch');
    return { sender: identity.email.toLowerCase() };
  } catch (error) {
    if (error instanceof GmailAuthError) throw error;
    throw new GmailAuthError();
  }
}

export async function privateJson(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error();
    return JSON.parse(await handle.readFile('utf8'));
  } catch { throw new GmailAuthError('invalid_private_file'); }
  finally { await handle?.close(); }
}

export async function loadGmailConfiguration(env = process.env) {
  const parts = [env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_REFRESH_TOKEN];
  if (env.GMAIL_CREDENTIALS_FILE) {
    if (parts.some(Boolean)) throw new GmailAuthError('mixed_mail_configuration');
    const saved = await privateJson(env.GMAIL_CREDENTIALS_FILE);
    if (saved.version !== 1 || ![saved.clientId, saved.clientSecret, saved.refreshToken, saved.sender].every(v => typeof v === 'string' && v.length > 0 && v.length <= 8192)
      || (env.GMAIL_SENDER && env.GMAIL_SENDER.toLowerCase() !== saved.sender.toLowerCase())) throw new GmailAuthError('invalid_mail_configuration');
    return { clientId: saved.clientId, clientSecret: saved.clientSecret, refreshToken: saved.refreshToken, sender: saved.sender };
  }
  if (!parts.some(Boolean)) return null;
  if (!parts.every(Boolean)) throw new GmailAuthError('incomplete_mail_configuration');
  return { clientId: parts[0], clientSecret: parts[1], refreshToken: parts[2], sender: env.GMAIL_SENDER || 'peter@humansyntax.kr' };
}
