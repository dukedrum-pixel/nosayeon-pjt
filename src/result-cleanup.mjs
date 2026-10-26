import { SONG_ID } from './result-access.mjs';
import { validateAudioFiles } from './audio-files.mjs';
import { StorageError } from './storage-import.mjs';

function failure(error) {
  return { result: 'failed', errorCode: error instanceof StorageError ? error.code
    : ['delete_unconfirmed', 'lease_lost', 'invalid_files'].includes(error?.message) ? error.message : 'cleanup_failed',
    httpStatus: error instanceof StorageError ? error.httpStatus ?? null : null };
}

export async function cleanupConsumedSong({ backend, songId }) {
  if (!SONG_ID.test(songId)) throw new Error('invalid_song');
  let claim;
  try { claim = await backend.claimCleanup(songId); } catch (error) { return failure(error); }
  if (!claim) return { result: 'not_claimed' };
  try {
    const files = validateAudioFiles(await backend.files(songId), songId);
    await backend.remove(files.map(file => file.storage_path));
    for (const file of files) if (await backend.objectExists(file.storage_path)) throw new Error('delete_unconfirmed');
    if (!await backend.finishCleanup(songId, claim)) throw new Error('lease_lost');
    return { result: 'deleted', files: files.length };
  } catch (error) {
    try { await backend.failCleanup(songId, claim); } catch { /* Durable pending/deleting state remains retryable. */ }
    return failure(error);
  }
}
