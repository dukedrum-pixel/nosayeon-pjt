import { sha256 } from './storage-import.mjs';

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
    try {
      const url = new URL(request.url);
      if (!['/api/result', '/api/audio'].includes(url.pathname)) return json({ status: 'error' }, 404);
      if (request.method !== 'GET') return json({ status: 'error' }, 405);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
      const id = url.searchParams.get('id');
      if (!SONG_ID.test(id ?? '') || !token) return json({ status: 'invalid_link' }, 401);
      const link = await backend.resultLink(id, await hashResultToken(token));
      if (!link || link.song_id !== id || link.revoked_at) return json({ status: 'invalid_link' }, 401);
      const issued = Date.parse(link.issued_at), expiry = Date.parse(link.expires_at);
      function expired() {
        const now = clock();
        if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expiry)
          || issued > now || expiry <= issued || expiry - issued > 7 * 86400000) throw new Error('invalid_link_record');
        return now >= expiry;
      }
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      if (link.songs?.storage_status !== 'stored') return json({ status: 'processing', canRestore: false }, 409);
      const files = await backend.files(id);
      if (!Array.isArray(files) || !files.length || files.length > 8) throw new Error('invalid_files');
      let total = 0;
      for (const [position, file] of files.entries()) {
        const suffix = file.mime_type === 'audio/wav' ? 'wav' : 'mp3';
        if (file.file_index !== position + 1 || !['audio/mpeg', 'audio/mp3', 'audio/wav'].includes(file.mime_type)
          || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.byte_length)
          || file.byte_length < 1 || file.byte_length > 67108864 || file.bucket_id !== 'nosayeon-audio'
          || file.storage_path !== `${id}/original/${file.file_index}-${file.sha256}.${suffix}`) throw new Error('invalid_files');
        total += file.byte_length;
      }
      if (total > 67108864) throw new Error('invalid_files');
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      if (url.pathname === '/api/result') {
        return json({ status: 'available', expiresAt: new Date(expiry).toISOString(), canRestore: false,
          files: files.map(file => ({ index: file.file_index, mime: file.mime_type, bytes: file.byte_length })) });
      }
      const index = url.searchParams.get('file');
      if (!/^[1-8]$/.test(index ?? '')) return json({ status: 'error' }, 400);
      const file = files.find(file => file.file_index === Number(index));
      if (!file) return json({ status: 'error' }, 404);
      const bytes = await backend.download(file.storage_path);
      if (!bytes || bytes.byteLength !== file.byte_length || await sha256(bytes) !== file.sha256) throw new Error('content_mismatch');
      // Storage latency must not allow a request to pass its expiry boundary.
      const current = await backend.resultLink(id, await hashResultToken(token));
      if (!current || current.revoked_at || current.song_id !== id) return json({ status: 'invalid_link' }, 401);
      if (current.expires_at !== link.expires_at || current.songs?.storage_status !== 'stored') throw new Error('link_changed');
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      return new Response(bytes, { headers: { ...headers, 'Content-Type': file.mime_type, 'Content-Length': String(bytes.byteLength) } });
    } catch {
      // Never reflect backend exceptions, tokens, paths, prompts or keys.
      return json({ status: 'error' }, 503);
    }
  };
}
