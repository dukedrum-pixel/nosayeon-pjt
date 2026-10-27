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

export function createStorageBackend({ url, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new StorageError('local_error');
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
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
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
    if (!/^[0-9a-f-]{36}\/(?:revisions\/[1-9][0-9]{0,9}\/)?original\/[1-8]-[a-f0-9]{64}\.(mp3|wav)$/.test(path)) throw new StorageError('local_error');
    return `/storage/v1/object/${BUCKET}/${path}`;
  }
  return {
    requestReadiness: hash => jsonRequest('/rest/v1/rpc/song_request_readiness',{method:'POST',json:{p_ingress_hash:hash}}),
    submitRequest: (id,prompt,hash,sealed,ingress) => jsonRequest('/rest/v1/rpc/submit_song_request',{method:'POST',json:{p_id:id,p_prompt:prompt,p_token_hash:hash,p_sealed_token:sealed,p_ingress_hash:ingress}}),
    readRequest: (id,hash) => jsonRequest('/rest/v1/rpc/read_song_request',{method:'POST',json:{p_id:id,p_ingress_hash:hash}}),
    touchRequestWorker: () => jsonRequest('/rest/v1/rpc/touch_song_request_worker',{method:'POST',json:{}}),
    claimRequest: () => jsonRequest('/rest/v1/rpc/claim_song_request',{method:'POST',json:{}}),
    progressRequest: (id,status,interaction=null,songId=null) => jsonRequest('/rest/v1/rpc/progress_song_request',{method:'POST',json:{p_id:id,p_status:status,p_interaction_id:interaction,p_song_id:songId}}),
    requestNotification: async songId => (await jsonRequest(`/rest/v1/song_notification_outbox?song_id=eq.${songId}&select=id,status&order=created_at.desc&limit=1`))[0],
    configureSongEmail: ({ songId, tokenHash, recipient, sender, origin, sealedToken }) => jsonRequest('/rest/v1/rpc/configure_song_email', { method: 'POST',
      json: { p_song_id: songId, p_token_hash: tokenHash, p_recipient: recipient, p_sender: sender, p_public_origin: origin, p_sealed_token: sealedToken } }),
    notificationCandidates: limit => jsonRequest('/rest/v1/rpc/list_result_notification_candidates', { method: 'POST', json: { p_limit: limit } }),
    beginResultNotification: (id, origin, sender) => jsonRequest('/rest/v1/rpc/begin_result_notification', { method: 'POST', json: { p_id: id, p_public_origin: origin, p_sender: sender } }),
    finishResultNotification: (id, operationId, status, messageId, errorCode) => jsonRequest('/rest/v1/rpc/finish_result_notification', { method: 'POST',
      json: { p_id: id, p_operation_id: operationId, p_status: status, p_message_id: messageId, p_error_code: errorCode } }),
    notificationHistory: () => jsonRequest('/rest/v1/song_notification_outbox?select=id,song_id,delivery_version,event,status,created_at,started_at,completed_at,error_code&order=created_at.desc,id.desc&limit=50'),
    adminDashboard: () => jsonRequest('/rest/v1/rpc/read_admin_dashboard', { method: 'POST', json: {} }),
    adminSongs: (offset, id) => {
      if (!Number.isInteger(offset) || offset < 0 || offset > 9999999 || (id !== null && !/^[0-9a-f-]{36}$/.test(id))) throw new StorageError('local_error');
      return jsonRequest(`/rest/v1/songs?select=id,generated_at,created_at,generation_status,storage_status,last_error_code,song_files(file_index,mime_type,byte_length,sha256),song_result_links(delivery_version,expires_at,consumed_at,revoked_at,restore_status,notification_status)&order=created_at.desc,id.desc&limit=21&offset=${offset}${id ? `&id=eq.${id}` : ''}`);
    },
    adminHistory: () => jsonRequest('/rest/v1/admin_delivery_exports?select=id,song_id,file_index,channel,status,created_at,error_code&order=created_at.desc,id.desc&limit=50'),
    beginAdminEmail: (id, index, hash, length, recipient, sender, operationId) => jsonRequest('/rest/v1/rpc/begin_admin_email', { method: 'POST',
      json: { p_song_id: id, p_file_index: index, p_sha256: hash, p_byte_length: length, p_recipient: recipient, p_sender: sender, p_operation_id: operationId } }),
    finishAdminEmail: (id, status, messageId, code) => jsonRequest('/rest/v1/rpc/finish_admin_email', { method: 'POST',
      json: { p_id: id, p_status: status, p_message_id: messageId, p_error_code: code } }),
    prepareAdminDelivery: (id, index, hash, length, channel) => jsonRequest('/rest/v1/rpc/prepare_admin_delivery', { method: 'POST',
      json: { p_song_id: id, p_file_index: index, p_sha256: hash, p_byte_length: length, p_channel: channel } }),
    song: async id => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new StorageError('local_error');
      const rows = await jsonRequest(`/rest/v1/songs?id=eq.${id}&select=id,google_interaction_id,model,generated_at,storage_status&limit=1`);
      if (!Array.isArray(rows) || rows.length !== 1) throw new StorageError('invalid_response');
      return rows[0];
    },
    cleanupCandidates: () => jsonRequest('/rest/v1/rpc/list_result_cleanup_candidates', { method: 'POST', json: { p_limit: 20 } }),
    authorizeCleanupJob: hash => jsonRequest('/rest/v1/rpc/authorize_audio_cleanup_job', { method: 'POST', json: { p_token_hash: hash } }),
    recordCleanupRun: async summary => {
      const response = await request('/rest/v1/rpc/record_audio_cleanup_run', { method: 'POST', json: { p_summary: summary } });
      await response.body?.cancel();
    },
    issueResultLink: (id, tokenHash) => {
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(tokenHash)) throw new StorageError('local_error');
      return jsonRequest('/rest/v1/rpc/issue_initial_result_link', { method: 'POST', json: { p_song_id: id, p_token_hash: tokenHash } });
    },
    resultLink: async (id, tokenHash) => {
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(tokenHash)) throw new StorageError('local_error');
      const rows = await jsonRequest(`/rest/v1/song_result_links?song_id=eq.${id}&token_hash=eq.${tokenHash}&select=song_id,issued_at,expires_at,revoked_at,consumed_at,cleanup_status,delivery_version,restore_status,restore_lease_until,notification_status,page_issued,songs!inner(storage_status,generated_at)&limit=1`);
      if (!Array.isArray(rows)) throw new StorageError('invalid_response');
      return rows[0] ?? null;
    },
    register: args => jsonRequest('/rest/v1/rpc/register_generated_song', { method: 'POST', json: args }),
    claimDownload: (id, hash) => jsonRequest('/rest/v1/rpc/claim_result_download', { method: 'POST', json: { p_song_id: id, p_token_hash: hash } }),
    claimDownloadVersion: (id,hash,version) => jsonRequest('/rest/v1/rpc/claim_versioned_download',{method:'POST',json:{p_song_id:id,p_token_hash:hash,p_version:version}}),
    releaseDownload: (id, claim) => jsonRequest('/rest/v1/rpc/release_result_download', { method: 'POST', json: { p_song_id: id, p_claim: claim } }),
    consumeDownload: (id, claim) => jsonRequest('/rest/v1/rpc/consume_result_download', { method: 'POST', json: { p_song_id: id, p_claim: claim } }),
    claimCleanup: id => jsonRequest('/rest/v1/rpc/claim_result_cleanup', { method: 'POST', json: { p_song_id: id } }),
    finishCleanup: (id, claim) => jsonRequest('/rest/v1/rpc/finish_result_cleanup', { method: 'POST', json: { p_song_id: id, p_claim: claim } }),
    failCleanup: (id, claim) => jsonRequest('/rest/v1/rpc/fail_result_cleanup', { method: 'POST', json: { p_song_id: id, p_claim: claim } }),
    cleanupFiles: (id,claim)=>jsonRequest('/rest/v1/rpc/read_claimed_cleanup_files',{method:'POST',json:{p_song_id:id,p_claim:claim}}),
    beginRestore:(id,hash,version)=>jsonRequest('/rest/v1/rpc/begin_song_restore',{method:'POST',json:{p_song_id:id,p_token_hash:hash,p_version:version}}),
    restoreLease:(id,claim)=>jsonRequest('/rest/v1/rpc/check_song_restore',{method:'POST',json:{p_song_id:id,p_claim:claim}}),
    finishRestore:(id,claim)=>jsonRequest('/rest/v1/rpc/finish_song_restore',{method:'POST',json:{p_song_id:id,p_claim:claim}}),
    failRestore:(id,claim,code)=>jsonRequest('/rest/v1/rpc/fail_song_restore',{method:'POST',json:{p_song_id:id,p_claim:claim,p_error_code:code}}),
    remove: async paths => {
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8) throw new StorageError('local_error');
      for (const path of paths) objectPath(path);
      const response = await request(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', json: { prefixes: paths } });
      await response.body?.cancel();
    },
    objectExists: async path => {
      objectPath(path);
      const slash = path.lastIndexOf('/');
      const name = path.slice(slash + 1);
      // POST metadata lookup avoids stale CDN responses from object downloads.
      const rows = await jsonRequest(`/storage/v1/object/list/${BUCKET}`, { method: 'POST',
        json: { prefix: path.slice(0, slash), search: name, limit: 100, offset: 0 } });
      if (!Array.isArray(rows) || rows.length >= 100 || rows.some(row => typeof row?.name !== 'string')) throw new StorageError('invalid_response');
      return rows.some(row => row.name === name);
    },
    claim: id => jsonRequest('/rest/v1/rpc/claim_song_storage', { method: 'POST', json: { p_song_id: id } }),
    files: id => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new StorageError('invalid_response');
      return jsonRequest(`/rest/v1/song_files?song_id=eq.${id}&order=file_index.asc&select=file_index,mime_type,byte_length,sha256,bucket_id,storage_path,delivery_version`);
    },
    download: async (path, { fresh = false } = {}) => {
      const response = await request(objectPath(path) + (fresh ? `?cacheNonce=${crypto.randomUUID()}` : ''), { optionalObject: true });
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
