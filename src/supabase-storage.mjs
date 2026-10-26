import { StorageError } from './storage-import.mjs';

const LIMIT = 67108864;
const BUCKET = 'nosayeon-audio';

async function readLimited(response, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > limit) throw new StorageError('invalid_response');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createStorageBackend({ url, serviceRoleKey, fetchImpl = globalThis.fetch }) {
  let base;
  try { base = new URL(url); } catch { throw new StorageError('local_error'); }
  // Only a standard project origin may receive this backend credential.
  if (base.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(base.hostname)
    || base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || !serviceRoleKey?.trim()) throw new StorageError('local_error');
  async function request(path, { method = 'GET', json, bytes, mime, optionalObject = false } = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method, headers: {
          apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
          ...(bytes ? { 'Content-Type': mime, 'x-upsert': 'false' } : {}),
        },
        ...(json ? { body: JSON.stringify(json) } : {}), ...(bytes ? { body: bytes } : {}),
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        // Some Storage versions return HTTP 400 with a structured 404 for a
        // missing object. Inspect a small response internally; never log it.
        if (optionalObject && [400, 404].includes(response.status)) {
          const payload = new TextDecoder().decode(await readLimited(response, 16384));
          let info;
          try { info = JSON.parse(payload); } catch { /* Not a recognized missing object. */ }
          if (String(info?.statusCode) === '404' && info?.error === 'not_found') return null;
        } else { await response.body?.cancel(); }
        throw new StorageError('http_error', response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('network_error');
    }
  }
  async function jsonRequest(path, options) {
    const response = await request(path, options);
    try { return JSON.parse(new TextDecoder().decode(await readLimited(response, 1024 * 1024))); }
    catch { throw new StorageError('invalid_response'); }
  }
  function objectPath(path) {
    if (!/^[0-9a-f-]{36}\/original\/[1-8]-[a-f0-9]{64}\.(mp3|wav)$/.test(path)) throw new StorageError('local_error');
    return `/storage/v1/object/${BUCKET}/${path}`;
  }
  return {
    issueResultLink: (id, tokenHash) => {
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(tokenHash)) throw new StorageError('local_error');
      return jsonRequest('/rest/v1/rpc/issue_initial_result_link', { method: 'POST', json: { p_song_id: id, p_token_hash: tokenHash } });
    },
    resultLink: async (id, tokenHash) => {
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(tokenHash)) throw new StorageError('local_error');
      const rows = await jsonRequest(`/rest/v1/song_result_links?song_id=eq.${id}&token_hash=eq.${tokenHash}&select=song_id,issued_at,expires_at,revoked_at,songs!inner(storage_status)&limit=1`);
      if (!Array.isArray(rows)) throw new StorageError('invalid_response');
      return rows[0] ?? null;
    },
    register: args => jsonRequest('/rest/v1/rpc/register_generated_song', { method: 'POST', json: args }),
    claim: id => jsonRequest('/rest/v1/rpc/claim_song_storage', { method: 'POST', json: { p_song_id: id } }),
    files: id => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new StorageError('invalid_response');
      return jsonRequest(`/rest/v1/song_files?song_id=eq.${id}&order=file_index.asc&select=file_index,mime_type,byte_length,sha256,bucket_id,storage_path`);
    },
    download: async path => {
      const response = await request(objectPath(path), { optionalObject: true });
      if (response === null) return null;
      try { return await readLimited(response, LIMIT); }
      catch (error) { throw error instanceof StorageError ? error : new StorageError('network_error'); }
    },
    upload: async (path, bytes, mime) => {
      const response = await request(objectPath(path), { method: 'POST', bytes, mime });
      await response.body?.cancel();
    },
    finish: (id, claim) => jsonRequest('/rest/v1/rpc/finish_song_storage', { method: 'POST', json: { p_song_id: id, p_claim: claim } }),
    fail: (id, claim, code, status) => jsonRequest('/rest/v1/rpc/fail_song_storage', { method: 'POST', json: {
      p_song_id: id, p_claim: claim, p_error_code: code, p_http_status: status ?? null,
    } }),
  };
}
