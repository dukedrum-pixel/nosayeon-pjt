import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanupSweepHandler, runCleanupSweep } from '../src/cleanup-sweep.mjs';
import { sha256, StorageError } from '../src/storage-import.mjs';

const token = 'a'.repeat(64), tokenHash = await sha256(new TextEncoder().encode(token));
const ids = [crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
const path = id => `${id}/original/1-${'a'.repeat(64)}.mp3`;
function setup() {
  const objects = new Set(ids.map(path)), claims = new Set(), records = [], calls = [];
  const backend = {
    authorizeCleanupJob: async hash => { calls.push(['authorize', hash]); return hash === tokenHash; },
    cleanupCandidates: async () => ids.map(song_id => ({ song_id })),
    claimCleanup: async id => { if (claims.has(id)) return null; claims.add(id); return crypto.randomUUID(); },
    files: async id => [{ file_index: 1, mime_type: 'audio/mpeg', byte_length: 1, sha256: 'a'.repeat(64), bucket_id: 'nosayeon-audio', storage_path: path(id) }],
    remove: async paths => { for (const p of paths) objects.delete(p); },
    objectExists: async p => objects.has(p),
    finishCleanup: async () => true, failCleanup: async () => true,
    recordCleanupRun: async summary => records.push({ ...summary }),
  };
  return { backend, objects, records, calls };
}
const request = (auth = token, method = 'POST') => new Request('https://example.invalid/functions/v1/cleanup-expired-audio', {
  method, headers: auth ? { Authorization: `Bearer ${auth}` } : {},
});

test('트리거 토큰 누락·변조는 대상 조회나 삭제 전에 차단한다', async () => {
  const { backend, objects, records, calls } = setup();
  const handle = createCleanupSweepHandler({ backend });
  for (const key of [null,'bad','b'.repeat(64)]) assert.equal((await handle(request(key))).status,401);
  assert.equal((await handle(request(token,'GET'))).status,405);
  assert.equal(objects.size,3); assert.equal(records.length,0);
  assert.equal(calls.length,1); assert.notEqual(calls[0][1],'b'.repeat(64));
});

test('인증 후 DB가 선택한 대상만 정리하고 응답·기록에 키·파일 경로·ID를 넣지 않는다', async () => {
  const { backend, objects, records, calls } = setup();
  const response = await createCleanupSweepHandler({ backend })(request());
  const summary = await response.json();
  assert.equal(response.status,200); assert.equal(summary.deleted,3); assert.equal(objects.size,0);
  assert.equal(summary.result,'completed'); assert.equal(records.length,1);
  assert.equal(calls[0][1],tokenHash);
  for (const secret of [token,...ids,'storage_path']) assert.equal(JSON.stringify(summary).includes(secret),false);
});

test('인증 응답이 정확한 true가 아니면 정리를 시작하지 않는다', async () => {
  for (const value of [null,false,'true',{},[]]) {
    const { backend,objects } = setup(); backend.authorizeCleanupJob=async()=>value;
    assert.equal((await createCleanupSweepHandler({backend})(request())).status,401);
    assert.equal(objects.size,3);
  }
});

test('오래된 후보나 다른 작업이 점유한 대상은 재검증하고 건너뛴다', async () => {
  const { backend, objects } = setup();
  const claim = backend.claimCleanup;
  backend.claimCleanup = async id => id === ids[0] ? null : claim(id);
  const summary = await runCleanupSweep({ backend });
  assert.equal(summary.skipped,1); assert.equal(summary.deleted,2); assert.equal(objects.has(path(ids[0])),true);
});

test('한 건이 실패해도 다른 건은 계속 정리하고 부분 실패 횟수만 기록한다', async () => {
  const { backend } = setup(); const remove = backend.remove;
  backend.remove = async paths => { if (paths[0] === path(ids[0])) throw new StorageError('http_error',503); return remove(paths); };
  const summary = await runCleanupSweep({ backend });
  assert.equal(summary.result,'partial'); assert.equal(summary.deleted,2); assert.equal(summary.failed,1);
});

test('실행 시간 예산을 넘으면 남은 대상을 점유하지 않고 다음 실행으로 미룬다', async () => {
  const { backend, objects } = setup(); let now = 0;
  backend.finishCleanup = async () => { now = 40001; return true; };
  const summary = await runCleanupSweep({ backend,clock:() => now });
  assert.equal(summary.result,'partial'); assert.equal(summary.scanned,3);
  assert.equal(summary.deleted,1); assert.equal(summary.deferred,2); assert.equal(objects.size,2);
});

test('손상된 후보 응답과 DB·기록 오류에서 원문을 반사하지 않는다', async () => {
  for (const rows of [null,[{song_id:'invalid'}],ids.map(()=>({song_id:ids[0]})),Array.from({length:21},()=>({song_id:crypto.randomUUID()}))]) {
    const { backend, objects } = setup(); backend.cleanupCandidates = async () => rows;
    const response = await createCleanupSweepHandler({ backend })(request());
    assert.equal(response.status,503); assert.equal(objects.size,3);
  }
  const { backend } = setup(); backend.recordCleanupRun = async () => { throw new Error('SECRET'); };
  const response = await createCleanupSweepHandler({ backend })(request());
  assert.equal(response.status,503); assert.equal(await response.text(),'{"error":"cleanup_unavailable"}');
});
