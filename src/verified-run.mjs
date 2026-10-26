import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, StorageError, validateManifest } from './storage-import.mjs';

async function readBounded(path, limit) {
  if ((await stat(path)).size > limit) throw new StorageError('local_error');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new StorageError('local_error');
  return bytes;
}

export async function loadVerifiedRun(dir) {
  try {
    const baseline = JSON.parse(await readBounded(join(dir, 'baseline.json'), 65536));
    const report = JSON.parse(await readBounded(join(dir, 'report.json'), 65536));
    const created = JSON.parse(await readBounded(join(dir, 'created.json'), 96 * 1024 * 1024));
    const completed = JSON.parse(await readBounded(join(dir, 'first-completed.json'), 96 * 1024 * 1024));
    if (!baseline.interaction_id || baseline.interaction_id !== created.id || baseline.interaction_id !== report.interaction_id
      || baseline.interaction_id !== completed.id || completed.status !== 'completed' || completed.model !== 'lyria-3.5' || report.result !== 'identical'
      || !Array.isArray(baseline.files) || baseline.files.length < 1 || baseline.files.length > 8
      || report.original?.length !== baseline.files.length || report.restored?.length !== baseline.files.length) throw new StorageError('local_error');
    const files = [];
    let total = 0;
    for (const [index, file] of baseline.files.entries()) {
      if (file.file !== `original-${index + 1}.${file.mime === 'audio/wav' ? 'wav' : 'mp3'}`) throw new StorageError('local_error');
      for (const compared of [report.original[index], report.restored[index]]) {
        if (compared?.sha256 !== file.sha256 || compared?.bytes !== file.bytes || compared?.mime !== file.mime) throw new StorageError('content_mismatch');
      }
      const bytes = await readBounded(join(dir, file.file), 67108864);
      total += bytes.length;
      if (total > 67108864 || bytes.length !== file.bytes || await sha256(bytes) !== file.sha256) throw new StorageError('content_mismatch');
      files.push({ index: index + 1, mime: file.mime, sha256: file.sha256, bytes });
    }
    const manifest = { interactionId: baseline.interaction_id, model: completed.model, generatedAt: completed.created, files };
    validateManifest(manifest);
    return manifest;
  } catch (error) {
    throw error instanceof StorageError ? error : new StorageError('local_error');
  }
}
