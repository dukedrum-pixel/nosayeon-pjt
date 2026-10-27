import { hashResultToken, SONG_ID } from './identifiers.mjs';
import { publicResultOrigin } from './result-link.mjs';
import { validateNotificationKey, openResultToken } from './notification-secret.mjs';
import { GmailDeliveryError, validEmail } from './gmail-delivery.mjs';

export function notificationConfiguration(env = process.env) {
  if (env.RESULT_EMAIL_ENABLED !== 'true') return null;
  const origin = publicResultOrigin(env.RESULT_PUBLIC_ORIGIN);
  validateNotificationKey(env.RESULT_LINK_ENCRYPTION_KEY);
  return { origin, key: env.RESULT_LINK_ENCRYPTION_KEY };
}

// A claimed attempt is never reclaimed automatically, even after process death.
// Timeout / lost Gmail response / lost finish response all require reconciliation.
export async function deliverResultNotifications({ backend, mailer, configuration, limit = 10 }) {
  const summary = { status: 'disabled', checked: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
  if (!configuration) return summary;
  publicResultOrigin(configuration.origin); validateNotificationKey(configuration.key);
  if (!mailer?.sendResultLink || !validEmail(mailer.sender) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid_notification_configuration');
  const candidates = await backend.notificationCandidates(limit);
  if (!Array.isArray(candidates) || candidates.length > limit || candidates.some(row => !SONG_ID.test(row?.id ?? ''))) throw new Error('invalid_notification_candidates');
  summary.status = 'completed';
  for (const candidate of candidates) {
    summary.checked++;
    let job;
    try { job = await backend.beginResultNotification(candidate.id, configuration.origin, mailer.sender); }
    catch { summary.unknown++; continue; } // Claim may have committed. Do not repeat it.
    if (job?.result !== 'started') { summary.skipped++; continue; }
    let status = 'sent', providerMessageId = null, errorCode = null, sendingStarted = false;
    try {
      if (!SONG_ID.test(job.song_id ?? '') || !SONG_ID.test(job.operation_id ?? '')
        || !validEmail(job.recipient) || job.public_origin !== configuration.origin || job.sender !== mailer.sender) throw new GmailDeliveryError('failed', 'invalid_mail');
      const token = openResultToken({ sealedToken: job.sealed_token, key: configuration.key,
        songId: job.song_id, recipient: job.recipient, origin: configuration.origin });
      if (await hashResultToken(token) !== job.token_hash) throw new GmailDeliveryError('failed', 'invalid_mail');
      sendingStarted = true;
      const result = await mailer.sendResultLink({ recipient: job.recipient, operationId: job.operation_id,
        origin: configuration.origin, songId: job.song_id, token, expiresAt: job.expires_at, event: job.event });
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(result?.providerMessageId ?? '')) throw new GmailDeliveryError('unknown', 'mail_result_unknown');
      providerMessageId = result.providerMessageId;
    } catch (error) {
      status = error instanceof GmailDeliveryError ? error.state : sendingStarted ? 'unknown' : 'failed';
      errorCode = error instanceof GmailDeliveryError ? error.code : sendingStarted ? 'mail_result_unknown' : 'invalid_mail';
    }
    try {
      if (!await backend.finishResultNotification(candidate.id, job.operation_id, status, providerMessageId, errorCode)) { summary.unknown++; continue; }
      summary[status]++;
    } catch { summary.unknown++; }
  }
  return summary; // No recipients, tokens, ciphertext, URLs or raw provider data.
}
