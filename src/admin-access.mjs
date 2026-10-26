import { timingSafeEqual } from 'node:crypto';
import { sha256 } from './storage-import.mjs';
import { SONG_ID } from './identifiers.mjs';
import { validEmail, EMAIL_AUDIO_LIMIT, GmailDeliveryError } from './gmail-delivery.mjs';

const LIMIT = 67108864;
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });

export function createAdminHandler({ backend, accessToken, mailer, sender = 'peter@humansyntax.kr', databaseCapacityBytes = null, storageCapacityBytes = null, clock = Date.now }) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(accessToken ?? '')) throw new Error('invalid_admin_configuration');
  for (const capacity of [databaseCapacityBytes, storageCapacityBytes]) {
    if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity <= 0)) throw new Error('invalid_admin_configuration');
  }
  const expected = Buffer.from(accessToken);
  let preparing = false;
  const authorized = request => {
    const supplied = Buffer.from((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
    return supplied.length === expected.length && request.headers.get('authorization')?.startsWith('Bearer ')
      && timingSafeEqual(supplied, expected);
  };
  async function handle(request) {
    if (!authorized(request)) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
        const metrics = await backend.adminDashboard();
        return json({ ...metrics, databaseCapacityBytes, storageCapacityBytes,
          integrations: { googleDrive: 'deferred', email: mailer ? 'configured' : 'not_configured', sender: mailer?.sender ?? sender, kakao: 'not_configured', payments: 'not_implemented' } });
      }
      if (url.pathname === '/api/admin/songs' && request.method === 'GET') {
        const offsetText = url.searchParams.get('offset') ?? '0';
        const id = url.searchParams.get('id');
        if (!/^\d{1,7}$/.test(offsetText) || (id !== null && !SONG_ID.test(id))) return json({ error: 'invalid_request' }, 400);
        const rows = await backend.adminSongs(Number(offsetText), id);
        return json({ songs: rows.slice(0, 20), hasMore: rows.length > 20 });
      }
      if (url.pathname === '/api/admin/history' && request.method === 'GET') {
        return json({ exports: await backend.adminHistory() });
      }
      const sending = url.pathname === '/api/admin/send-email';
      if (!['/api/admin/prepare', '/api/admin/send-email'].includes(url.pathname) || request.method !== 'POST') return json({ error: 'not_found' }, 404);
      const id = url.searchParams.get('id'), index = Number(url.searchParams.get('index'));
      const channel = url.searchParams.get('channel');
      if (!SONG_ID.test(id ?? '') || !Number.isInteger(index) || index < 1 || index > 8 || !['email', 'kakao'].includes(channel)) return json({ error: 'invalid_request' }, 400);
      const recipient = request.headers.get('x-delivery-to'), operationId = request.headers.get('idempotency-key');
      if (sending && (!validEmail(recipient) || !SONG_ID.test(operationId ?? '') || channel !== 'email')) return json({ error: 'invalid_request' }, 400);
      if (sending && !mailer) return json({ error: 'email_not_configured' }, 503);
      if (request.headers.get('content-type') !== 'application/octet-stream') return json({ error: 'invalid_type' }, 415);
      // One bounded upload per server. Authenticate before consuming any body.
      if (preparing) return json({ error: 'busy' }, 409);
      preparing = true;
      try {
        const song = await backend.song(id);
        const generated = Date.parse(song.generated_at);
        if (!Number.isFinite(generated) || generated > clock() || clock() >= generated + 50 * 86400000) return json({ error: 'retention_ended' }, 410);
        const files = await backend.files(id);
        const file = files.find(f => f.file_index === index);
        if (!file || !['audio/mpeg', 'audio/mp3'].includes(file.mime_type)) return json({ error: 'mp3_required' }, 400);
        if (!Number.isInteger(file.byte_length) || file.byte_length < 1 || file.byte_length > LIMIT || !/^[a-f0-9]{64}$/.test(file.sha256)) return json({ error: 'unavailable' }, 503);
        if (sending && file.byte_length > EMAIL_AUDIO_LIMIT) return json({ error: 'email_too_large' }, 413);
        const declared = request.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== file.byte_length)) return json({ error: 'content_mismatch' }, 422);
        const chunks = [];
        let length = 0;
        if (!request.body) return json({ error: 'content_mismatch' }, 422);
        for await (const chunk of request.body) {
          length += chunk.byteLength;
          if (length > file.byte_length) return json({ error: 'content_mismatch' }, 422);
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, length);
        if (request.signal.aborted || length !== file.byte_length || await sha256(bytes) !== file.sha256) return json({ error: 'content_mismatch' }, 422);
        if (sending) {
          const job = await backend.beginAdminEmail(id, index, file.sha256, length, recipient, mailer.sender, operationId);
          if (job.result !== 'started') return json({ error: job.result === 'retention_ended' ? 'retention_ended' : 'duplicate_or_conflict', status: job.status ?? null }, job.result === 'retention_ended' ? 410 : 409);
          let status = 'sent', providerMessageId = null, errorCode = null;
          try { ({ providerMessageId } = await mailer.send({ recipient, bytes, operationId })); }
          catch (error) {
            status = error instanceof GmailDeliveryError ? error.state : 'unknown';
            errorCode = error instanceof GmailDeliveryError ? error.code : 'mail_result_unknown';
          }
          let recorded = false;
          try { recorded = await backend.finishAdminEmail(job.id, status, providerMessageId, errorCode); }
          catch { /* The provider may already have accepted the message. */ }
          if (!recorded) return json({ error: 'mail_result_unknown', reference: job.id }, 503);
          return json({ status, reference: job.id, error: errorCode }, status === 'sent' ? 200 : 503);
        }
        // DB rechecks the immutable baseline and eligibility at commit time.
        // Prepared means only verified export, never successful mail/Kakao delivery.
        const record = await backend.prepareAdminDelivery(id, index, file.sha256, length, channel);
        if (record.result !== 'prepared') return json({ error: record.result === 'retention_ended' ? 'retention_ended' : 'content_mismatch' }, record.result === 'retention_ended' ? 410 : 422);
        return new Response(bytes, { headers: { ...headers, 'Content-Type': 'audio/mpeg',
          'Content-Disposition': `attachment; filename="nosayeon-${id}-${index}.mp3"`,
          'Content-Length': String(length), 'X-Preparation-Id': record.id } });
      } finally { preparing = false; }
    } catch { return json({ error: 'unavailable' }, 503); }
  }
  // HTTP adapter can reject unauthenticated uploads before attaching a stream.
  return Object.assign(handle, { authorized });
}
