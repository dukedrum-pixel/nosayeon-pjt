import { randomUUID } from 'node:crypto';
import { googleJson, validAccessToken, verifyGoogleSender } from './gmail-auth.mjs';
import { buildResultNotificationMail } from './result-notification-mail.mjs';

// Deliberately accepts one plain address, never a list or a display-name header.
export const validEmail = value => typeof value === 'string' && value.length <= 254
  && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
  && !value.includes('..');
export const EMAIL_AUDIO_LIMIT = 18 * 1024 * 1024;

export class GmailDeliveryError extends Error {
  constructor(state, code) { super(code); this.state = state; this.code = code; }
}

export function createGmailDelivery({ sender, clientId, clientSecret, refreshToken, fetchImpl = fetch, timeoutMs = 30000 }) {
  if (!validEmail(sender) || !clientId || !clientSecret || !refreshToken || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('invalid_mail_configuration');
  async function authenticate() {
    try {
      // OAuth credentials are sent only to Google's token endpoint. No retries.
      const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('oauth_failed'); }
      const data = await googleJson(response);
      if (!validAccessToken(data.access_token)) throw new Error('oauth_failed');
      await verifyGoogleSender({ accessToken: data.access_token, sender, fetchImpl, timeoutMs });
      return data.access_token;
    } catch { throw new GmailDeliveryError('failed', 'mail_auth_failed'); }
  }
  async function deliverMime(mime, accessToken) {
    try {
      // Once this POST starts, a lost response is ambiguous. Never retry it.
      const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GmailDeliveryError(response.status >= 400 && response.status < 500 && response.status !== 408 ? 'failed' : 'unknown', 'mail_rejected');
      }
      const data = await googleJson(response);
      if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) throw new Error('invalid_response');
      return { providerMessageId: data.id };
    } catch (error) {
      if (error instanceof GmailDeliveryError) throw error;
      throw new GmailDeliveryError('unknown', 'mail_result_unknown');
    }
  }
  return {
    sender,
    async checkConnection() { await authenticate(); return { sender, status: 'verified' }; },
    async sendResultLink({ recipient, operationId, ...details }) {
      if (!validEmail(recipient) || !/^[a-f0-9-]{36}$/.test(operationId ?? '')) throw new GmailDeliveryError('failed', 'invalid_mail');
      let message;
      try { message = buildResultNotificationMail(details); }
      catch { throw new GmailDeliveryError('failed', 'invalid_mail'); }
      const accessToken = await authenticate();
      const boundary = `nosayeon_${randomUUID()}`;
      const base64 = value => Buffer.from(value).toString('base64').match(/.{1,76}/g).join('\r\n');
      const mime = [
        `From: ${sender}`, `To: ${recipient}`, `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${operationId}@${sender.split('@')[1]}>`,
        'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(message.text),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(message.html),
        `--${boundary}--`, '',
      ].join('\r\n');
      if (Date.parse(details.expiresAt) <= Date.now()) throw new GmailDeliveryError('failed', 'invalid_mail');
      return deliverMime(mime, accessToken);
    },
    async send({ recipient, bytes, operationId }) {
      if (!validEmail(recipient) || !bytes?.length || bytes.length > EMAIL_AUDIO_LIMIT || !/^[a-f0-9-]{36}$/.test(operationId)) throw new GmailDeliveryError('failed', 'invalid_mail');
      const accessToken = await authenticate();
      const boundary = `nosayeon_${randomUUID()}`;
      const base64 = data => Buffer.from(data).toString('base64').match(/.{1,76}/g).join('\r\n');
      const subject = Buffer.from('[노사연] 요청하신 음악 MP3를 보내드립니다.').toString('base64');
      const mime = [
        `From: ${sender}`, `To: ${recipient}`, `Subject: =?UTF-8?B?${subject}?=`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${operationId}@${sender.split('@')[1]}>`,
        'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
        base64('안녕하세요. 노사연입니다.\n요청하신 원본 음악을 MP3 파일로 첨부합니다.\n감사합니다.'),
        `--${boundary}`, 'Content-Type: audio/mpeg; name="nosayeon.mp3"',
        'Content-Disposition: attachment; filename="nosayeon.mp3"', 'Content-Transfer-Encoding: base64', '',
        base64(bytes), `--${boundary}--`, '',
      ].join('\r\n');
      return deliverMime(mime, accessToken);
    },
  };
}
