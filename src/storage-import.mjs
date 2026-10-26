// No generation API is imported here. This stage can only store existing audio.
export class StorageError extends Error {
  constructor(code, httpStatus) {
    super(`저장 처리 실패 (${code}${httpStatus ? `, HTTP ${httpStatus}` : ''}). 새 음악을 생성하지 않았습니다.`);
    this.name = 'StorageError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest.interactionId !== 'string' || !manifest.interactionId.trim() || manifest.interactionId.length > 512
    || manifest.model !== 'lyria-3.5' || !Number.isFinite(Date.parse(manifest.generatedAt))
    || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 8) throw new StorageError('local_error');
  for (const [index, file] of manifest.files.entries()) {
    if (file.index !== index + 1 || !(file.bytes instanceof Uint8Array) || !file.bytes.byteLength
      || file.bytes.byteLength > 67108864 || !['audio/mpeg', 'audio/mp3', 'audio/wav'].includes(file.mime)
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new StorageError('local_error');
  }
  if (manifest.files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > 67108864) throw new StorageError('local_error');
}

export async function importGeneratedAudio({ manifest, backend, onProgress = () => {} }) {
  validateManifest(manifest);
  // Check every original before making the first remote write.
  for (const file of manifest.files) {
    if (await sha256(file.bytes) !== file.sha256) throw new StorageError('content_mismatch');
  }
  const song = await backend.register({
    p_interaction_id: manifest.interactionId, p_generated_at: manifest.generatedAt,
    p_files: manifest.files.map(file => ({ file_index: file.index, mime_type: file.mime, byte_length: file.bytes.byteLength, sha256: file.sha256 })),
  });
  if (!song?.id) throw new StorageError('invalid_response');
  if (song.storage_status === 'stored') return { songId: song.id, result: 'already_stored', files: manifest.files.length };
  const claim = await backend.claim(song.id);
  if (!claim) return { songId: song.id, result: 'busy', files: manifest.files.length };
  if (claim.id !== song.id || !claim.storage_claim) throw new StorageError('invalid_response');
  onProgress('기존 오디오 저장을 시작합니다. 음악 생성 호출은 없습니다.');
  try {
    const rows = await backend.files(song.id);
    if (!Array.isArray(rows) || rows.length !== manifest.files.length) throw new StorageError('invalid_response');
    for (const file of manifest.files) {
      const row = rows.find(row => row.file_index === file.index);
      const suffix = file.mime === 'audio/wav' ? 'wav' : 'mp3';
      const path = `${song.id}/original/${file.index}-${file.sha256}.${suffix}`;
      if (!row || row.sha256 !== file.sha256 || row.byte_length !== file.bytes.byteLength || row.mime_type !== file.mime
        || row.bucket_id !== 'nosayeon-audio' || row.storage_path !== path) throw new StorageError('content_mismatch');
      // A partial upload or a previous worker may have left an object. Never
      // overwrite it. Check its bytes, then resume only the missing objects.
      let stored = await backend.download(path);
      if (stored === null) {
        await backend.upload(path, file.bytes, file.mime);
        stored = await backend.download(path);
      }
      if (!stored || stored.byteLength !== file.bytes.byteLength || await sha256(stored) !== file.sha256) throw new StorageError('content_mismatch');
    }
    const completed = await backend.finish(song.id, claim.storage_claim);
    if (completed?.id !== song.id || completed.storage_status !== 'stored') throw new StorageError('invalid_response');
    return { songId: song.id, result: 'stored', files: manifest.files.length };
  } catch (error) {
    const safe = error instanceof StorageError ? error : new StorageError('local_error');
    try { await backend.fail(song.id, claim.storage_claim, safe.code, safe.httpStatus); }
    catch { /* Preserve the original error. An expired lease is reclaimable. */ }
    throw safe;
  }
}
