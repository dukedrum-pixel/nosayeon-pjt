import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/storage-import.mjs';
import { loadVerifiedRun } from '../src/verified-run.mjs';

test('스파이크 파일 검사는 해시·Interaction·비교 성공을 확인하고 경로 이탈을 거부', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nosayeon-import-'));
  try {
    const bytes = new TextEncoder().encode('mock-mp3');
    const file = { file: 'original-1.mp3', bytes: bytes.length, sha256: await sha256(bytes), mime: 'audio/mpeg' };
    const baseline = { interaction_id: 'original-id', files: [file] };
    const report = { interaction_id: 'original-id', result: 'identical', original: [file], restored: [file] };
    const save = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
    await save('created.json', { id: 'original-id', status: 'in_progress' });
    await save('first-completed.json', { id: 'original-id', model: 'lyria-3.5', status: 'completed', created: '2026-10-26T14:06:27Z' });
    await save('baseline.json', baseline);
    await save('report.json', report);
    await writeFile(join(dir, file.file), bytes);
    assert.equal((await loadVerifiedRun(dir)).interactionId, 'original-id');
    await save('report.json', { ...report, result: 'different' });
    await assert.rejects(loadVerifiedRun(dir), /local_error/);
    await save('report.json', { ...report, interaction_id: 'another-id' });
    await assert.rejects(loadVerifiedRun(dir), /local_error/);
    await save('report.json', report);
    await save('baseline.json', { ...baseline, files: [{ ...file, file: '../outside.mp3' }] });
    await assert.rejects(loadVerifiedRun(dir), /local_error/);
    await save('baseline.json', baseline);
    await writeFile(join(dir, file.file), 'damaged');
    await assert.rejects(loadVerifiedRun(dir), /content_mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
