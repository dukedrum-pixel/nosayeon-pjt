import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createResultHandler } from '../src/result-access.mjs';
import { createResultServer } from '../src/result-server.mjs';
import { cleanupConsumedSong } from '../src/result-cleanup.mjs';
import { sha256, importGeneratedAudio, StorageError } from '../src/storage-import.mjs';

const id = '11111111-1111-4111-8111-111111111111', token = 'a'.repeat(43);
const now = Date.parse('2026-10-27T00:00:00Z');
const original = new TextEncoder().encode('existing-original-audio');
const hash = await sha256(original);
const baseFile = { file_index: 1, byte_length: original.length, mime_type: 'audio/mpeg', sha256: hash,
  bucket_id: 'nosayeon-audio', storage_path: `${id}/original/1-${hash}.mp3` };
const request = (path = '/api/download', signal) => new Request(`http://127.0.0.1:4174${path}?id=${id}`, {
  method: path === '/api/download' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, signal,
});
function setup() {
  const state = { consumed: false, claim: null, released: 0, commits: 0, deleted: false, cleanup: 'none' };
  const objects = new Map([[baseFile.storage_path, original]]);
  const backend = {
    resultLink: async () => ({ song_id: id, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 100000).toISOString(),
      consumed_at: state.consumed ? new Date(now).toISOString() : null, songs: { storage_status: state.deleted ? 'deleted' : 'stored' } }),
    files: async () => [baseFile], download: async path => objects.get(path) ?? null,
    claimDownload: async () => { if (state.consumed || state.claim) return null; state.claim = crypto.randomUUID(); return state.claim; },
    releaseDownload: async (_, claim) => { if (!state.consumed && state.claim === claim) { state.claim = null; state.released++; return true; } return false; },
    consumeDownload: async (_, claim) => {
      if (state.consumed || state.claim !== claim) return false;
      state.consumed = true; state.claim = null; state.cleanup = 'pending'; state.commits++; return true;
    },
    claimCleanup: async () => { if (!state.consumed || !['pending', 'failed'].includes(state.cleanup)) return null; state.cleanup = 'deleting'; return 'cleanup-claim'; },
    remove: async paths => { for (const path of paths) objects.delete(path); },
    objectExists: async path => objects.has(path),
    finishCleanup: async () => { state.cleanup = 'deleted'; state.deleted = true; return true; },
    failCleanup: async () => { state.cleanup = 'failed'; return true; },
  };
  return { state, objects, backend, handle: createResultHandler({ backend, clock: () => now }) };
}

test('1회 다운로드는 완전한 원본을 반환한 뒤 재다운로드·재생을 차단한다', async () => {
  const { handle, state } = setup();
  const first = await handle(request());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Content-Disposition'), 'attachment; filename="nosayeon.mp3"');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), original);
  assert.equal(state.commits, 1);
  assert.equal((await handle(request())).status, 410);
  assert.equal((await (await handle(request('/api/result'))).json()).status, 'consumed');
  assert.equal((await handle(request('/api/audio'))).status, 410);
});

test('동시에 들어온 두 다운로드 중 한 요청만 사용 권한을 확정한다', async () => {
  const { handle, state } = setup();
  const replies = await Promise.all([handle(request()), handle(request())]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.equal(state.commits, 1);
});

test('원본 누락·해시 불일치로 준비에 실패하면 점유를 풀고 수동 재시도를 허용한다', async () => {
  const { handle, state, objects } = setup();
  objects.set(baseFile.storage_path, new Uint8Array(original.length));
  assert.equal((await handle(request())).status, 503);
  assert.equal(state.consumed, false); assert.equal(state.released, 1);
  objects.set(baseFile.storage_path, original);
  assert.equal((await handle(request())).status, 200);
});

test('연결이 준비 도중 끊기면 사용하지 않고, 확정 응답을 잃어도 사용권을 되살리지 않는다', async () => {
  const first = setup(), controller = new AbortController();
  first.backend.download = async () => { controller.abort(); return original; };
  assert.equal((await first.handle(request('/api/download', controller.signal))).status, 503);
  assert.equal(first.state.consumed, false); assert.equal(first.state.released, 1);
  const second = setup(), commit = second.backend.consumeDownload;
  second.backend.consumeDownload = async (...args) => { await commit(...args); throw new Error('SECRET response lost'); };
  assert.equal((await second.handle(request())).status, 503);
  assert.equal(second.state.consumed, true);
  assert.equal((await second.handle(request())).status, 410);
});

test('여러 원본을 ZIP 하나로 묶어 한 번에 전달하고 CRC·바이트를 독립 도구로 검증한다', async () => {
  const { backend, handle, objects } = setup();
  const second = { ...baseFile, file_index: 2, storage_path: `${id}/original/2-${hash}.mp3` };
  backend.files = async () => [baseFile, second]; objects.set(second.storage_path, original);
  const response = await handle(request()); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/zip');
  const archive = Buffer.from(await response.arrayBuffer());
  const result = JSON.parse(execFileSync('python3', ['-c',
    'import sys,io,zipfile,hashlib,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({"crc_error":z.testzip(),"files":{n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))'], { input: archive, encoding: 'utf8' }));
  assert.equal(result.crc_error, null);
  assert.deepEqual(result.files, { 'original-1.mp3': hash, 'original-2.mp3': hash });
});

test('일부 파일 삭제가 실패해도 소비 상태를 유지하며 삭제만 재개한다', async () => {
  const { backend, handle, state, objects } = setup();
  await handle(request());
  const remove = backend.remove;
  backend.remove = async paths => { objects.delete(paths[0]); throw new Error('storage response lost'); };
  assert.equal((await cleanupConsumedSong({ backend, songId: id })).result, 'failed');
  assert.equal(state.consumed, true); assert.equal(state.cleanup, 'failed');
  assert.equal((await handle(request())).status, 410);
  backend.remove = remove;
  assert.equal((await cleanupConsumedSong({ backend, songId: id })).result, 'deleted');
  assert.equal(state.deleted, true);
  assert.equal((await cleanupConsumedSong({ backend, songId: id })).result, 'not_claimed');
});

test('소비되지 않은 링크의 파일은 삭제하지 않으며 삭제 완료한 음악을 자동 재업로드하지 않는다', async () => {
  const { backend, objects } = setup();
  assert.equal((await cleanupConsumedSong({ backend, songId: id })).result, 'not_claimed');
  assert.equal(objects.size, 1);
  await assert.rejects(importGeneratedAudio({ manifest: { interactionId: 'existing', model: 'lyria-3.5', generatedAt: new Date(now).toISOString(),
    files: [{ index: 1, mime: 'audio/mpeg', bytes: original, sha256: hash }] }, backend: {
    register: async () => ({ id, storage_status: 'deleted' }), claim: async () => { throw new Error('must not claim'); },
  } }), error => error.code === 'storage_removed');
});

test('음원 CDN 응답이 남아 있어도 삭제 확인은 캐시되지 않는 Storage 메타데이터로 한다', async () => {
  const { backend, handle, state } = setup();
  await handle(request());
  backend.download = async () => original;
  assert.equal((await cleanupConsumedSong({ backend, songId: id })).result, 'deleted');
  assert.equal(state.deleted, true);
});

test('정리 점유 요청부터 실패해도 안전한 오류 코드를 반환하고 파일을 건드리지 않는다', async () => {
  const { backend, objects } = setup();
  backend.claimCleanup = async () => { throw new StorageError('network_error'); };
  assert.deepEqual(await cleanupConsumedSong({ backend, songId: id }), { result: 'failed', errorCode: 'network_error', httpStatus: null });
  assert.equal(objects.size, 1);
});

test('실제 HTTP 응답 종료 후 삭제 콜백을 한 번만 실행한다', async () => {
  const { handle } = setup(); let cleanupCalls = 0;
  const server = createResultServer({ handler: handle, afterDownloadResponse: async song => { assert.equal(song, id); cleanupCalls++; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/download?id=${id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleanupCalls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
