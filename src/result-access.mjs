import { sha256 } from './storage-import.mjs';
import { validateAudioFiles, readVerifiedAudio, buildAudioDownload } from './audio-files.mjs';

export const SONG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RESULT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export async function hashResultToken(token) {
  if (!RESULT_TOKEN.test(token)) throw new Error('invalid_token');
  return sha256(new TextEncoder().encode(token));
}

export function createResultHandler({ backend, clock = Date.now }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
  }
  return async function handle(request) {
    let downloadClaim = null, downloadSong = null;
    try {
      const url = new URL(request.url);
      if (!['/api/result', '/api/audio', '/api/download'].includes(url.pathname)) return json({ status: 'error' }, 404);
      if (request.method !== (url.pathname === '/api/download' ? 'POST' : 'GET')) return json({ status: 'error' }, 405);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
      const id = url.searchParams.get('id');
      if (!SONG_ID.test(id ?? '') || !token) return json({ status: 'invalid_link' }, 401);
      const link = await backend.resultLink(id, await hashResultToken(token));
      if (!link || link.song_id !== id || link.revoked_at) return json({ status: 'invalid_link' }, 401);
      if (link.consumed_at) return json({ status: 'consumed', canRestore: false }, 410);
      const issued = Date.parse(link.issued_at), expiry = Date.parse(link.expires_at);
      function expired() {
        const now = clock();
        if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expiry)
          || issued > now || expiry <= issued || expiry - issued > 7 * 86400000) throw new Error('invalid_link_record');
        return now >= expiry;
      }
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      if (link.songs?.storage_status !== 'stored') return json({ status: 'processing', canRestore: false }, 409);
      const files = validateAudioFiles(await backend.files(id), id);
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      if (url.pathname === '/api/result') {
        return json({ status: 'available', expiresAt: new Date(expiry).toISOString(), canRestore: false,
          files: files.map(file => ({ index: file.file_index, mime: file.mime_type, bytes: file.byte_length })) });
      }
      if (url.pathname === '/api/download') {
        if (request.signal.aborted) throw new Error('disconnected');
        downloadSong = id;
        downloadClaim = await backend.claimDownload(id, await hashResultToken(token));
        if (!downloadClaim) return json({ status: 'busy' }, 409);
        const contents = [];
        for (const file of files) {
          if (request.signal.aborted) throw new Error('disconnected');
          contents.push(await readVerifiedAudio(backend, file));
        }
        const bundle = buildAudioDownload(files, contents);
        const response = new Response(bundle.bytes, { headers: { ...headers,
          'Content-Type': bundle.mime, 'Content-Length': String(bundle.bytes.byteLength),
          'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        } });
        if (request.signal.aborted || expired()) throw new Error('unavailable');
        if (!await backend.consumeDownload(id, downloadClaim)) throw new Error('lease_lost');
        // After this commit, transport failure never restores the permission.
        // Durable pending cleanup survives crashes and is retried separately.
        downloadClaim = null;
        return response;
      }
      const index = url.searchParams.get('file');
      if (!/^[1-8]$/.test(index ?? '')) return json({ status: 'error' }, 400);
      const file = files.find(file => file.file_index === Number(index));
      if (!file) return json({ status: 'error' }, 404);
      const bytes = await readVerifiedAudio(backend, file);
      // Storage latency must not allow a request to pass its expiry boundary.
      const current = await backend.resultLink(id, await hashResultToken(token));
      if (!current || current.revoked_at || current.song_id !== id) return json({ status: 'invalid_link' }, 401);
      if (current.consumed_at) return json({ status: 'consumed', canRestore: false }, 410);
      if (current.expires_at !== link.expires_at || current.songs?.storage_status !== 'stored') throw new Error('link_changed');
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      return new Response(bytes, { headers: { ...headers, 'Content-Type': file.mime_type, 'Content-Length': String(bytes.byteLength) } });
    } catch {
      if (downloadClaim) {
        try { await backend.releaseDownload(downloadSong, downloadClaim); } catch { /* Lease expiry permits manual retry. */ }
      }
      // Never reflect backend exceptions, tokens, paths, prompts or keys.
      return json({ status: 'error' }, 503);
    }
  };
}
