import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultHandler, hashResultToken } from '../src/result-access.mjs';
import { sha256 } from '../src/storage-import.mjs';
import { createResultServer } from '../src/result-server.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(43);
const original = new TextEncoder().encode('existing-audio');
const digest = await sha256(original);
const now = Date.parse('2026-10-27T00:00:00Z');
const link = { song_id: id, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 10000).toISOString(), revoked_at: null, songs: { storage_status: 'stored' } };
const file = { file_index: 1, byte_length: original.length, mime_type: 'audio/mpeg', sha256: digest,
  bucket_id: 'nosayeon-audio', storage_path: `${id}/original/1-${digest}.mp3` };
const request = (path = '/api/result', auth = token) => new Request(`http://127.0.0.1:4174${path}${path.includes('?') ? '&' : '?'}id=${id}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
function setup(overrides = {}, clock = () => now) {
  const calls = [];
  const backend = { resultLink: async (songId, hash) => { calls.push({ songId, hash }); return hash === await hashResultToken(token) ? link : null; },
    files: async () => [file], download: async () => original, ...overrides };
  return { handle: createResultHandler({ backend, clock }), calls };
}

test('결과 조회는 토큰 해시만 저장소에 전달하고 비밀·실제 경로를 반환하지 않는다', async () => {
  const { handle, calls } = setup();
  const response = await handle(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.status, 'available');
  assert.equal(body.canRestore, false);
  assert.equal(body.files[0].bytes, original.length);
  assert.equal(calls[0].hash, await hashResultToken(token));
  assert.doesNotMatch(JSON.stringify(body), /token|storage_path|sha256|nosayeon-audio/);
});

test('누락·변조 토큰과 다른 곡 ID로는 파일을 조회하지 않는다', async () => {
  let reads = 0;
  const { handle } = setup({ files: async () => { reads++; return [file]; } });
  for (const auth of [null, 'bad', 'b'.repeat(43)]) assert.equal((await handle(request('/api/result', auth))).status, 401);
  assert.equal((await handle(new Request(`http://localhost/api/result?id=${id}&token=${token}`))).status, 401);
  const other = setup({ resultLink: async () => ({ ...link, song_id: crypto.randomUUID() }) });
  assert.equal((await other.handle(request())).status, 401);
  assert.equal(reads, 0);
});

test('만료 경계·취소 링크·잘못된 만료 기록은 음원 접근을 차단한다', async () => {
  for (const [row, status] of [
    [{ ...link, expires_at: new Date(now).toISOString() }, 410],
    [{ ...link, revoked_at: new Date(now).toISOString() }, 401],
    [{ ...link, expires_at: new Date(now + 8 * 86400000).toISOString() }, 503],
    [{ ...link, issued_at: 'invalid' }, 503],
  ]) {
    const { handle } = setup({ resultLink: async () => row, files: async () => { throw new Error('must not read'); } });
    assert.equal((await handle(request('/api/audio?file=1'))).status, status);
  }
});

test('오디오 재생은 해시 일치를 확인하고 저장·다운로드 사용 상태를 바꾸지 않는다', async () => {
  const { handle, calls } = setup();
  const response = await handle(request('/api/audio?file=1'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);
  assert.equal(calls.length, 2);
  assert.equal((await handle(request('/api/audio?file=9'))).status, 400);
});

test('음원 다운로드 중 만료·취소되면 받은 바이트를 사용자에게 내보내지 않는다', async () => {
  let time = now;
  const expired = setup({ download: async () => { time = now + 10000; return original; } }, () => time);
  assert.equal((await expired.handle(request('/api/audio?file=1'))).status, 410);
  let reads = 0;
  const revoked = setup({ resultLink: async () => ++reads === 1 ? link : { ...link, revoked_at: '2026-10-27T00:00:00Z' } });
  assert.equal((await revoked.handle(request('/api/audio?file=1'))).status, 401);
});

test('해시·경로 불일치와 백엔드 오류에서 원문·키·토큰을 노출하지 않는다', async () => {
  for (const overrides of [
    { download: async () => new Uint8Array(original.length) },
    { files: async () => [{ ...file, storage_path: '../outside' }] },
    { resultLink: async () => { throw new Error(`SECRET ${token}`); } },
  ]) {
    const { handle } = setup(overrides);
    const response = await handle(request('/api/audio?file=1'));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), '{"status":"error"}');
  }
});

test('로컬 서버는 웹 파일만 제공하고 다른 호스트·출처와 권한 없는 요청을 차단한다', async () => {
  const { handle } = setup();
  const server = createResultServer({ handler: handle });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/result.html`)).status, 200);
    for (const [path, mime] of [['result.css', 'text/css'], ['js/result-player.mjs', 'text/javascript']]) {
      const asset = await fetch(`${base}/${path}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('Content-Type'), `${mime}; charset=utf-8`);
    }
    assert.equal((await fetch(`${base}/api/result?id=${id}`)).status, 401);
    const authorized = await fetch(`${base}/api/result?id=${id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(authorized.status, 200);
    assert.equal((await fetch(`${base}/api/result?id=${id}`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    for (const path of ['/.env', '/src/supabase-storage.mjs', '/artifacts/result-links/secret.json', '/supabase/migrations/']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
