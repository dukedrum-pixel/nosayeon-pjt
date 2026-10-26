import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageBackend } from '../src/supabase-storage.mjs';

const url = 'https://abcdefghijklmnopqrst.supabase.co';
const serviceRoleKey = 'private-test-key';
const id = '11111111-1111-4111-8111-111111111111';
const path = `${id}/original/1-${'a'.repeat(64)}.mp3`;

test('결과 링크 어댑터는 해시만 전달하고 읽기 응답을 검증한다', async () => {
  const calls = [];
  const backend = createStorageBackend({ url, serviceRoleKey, fetchImpl: async (target, options) => {
    calls.push({ target, options });
    return new Response(target.pathname.includes('/rpc/') ? '{}' : '[{"song_id":"test"}]');
  } });
  const hash = 'b'.repeat(64);
  await backend.issueResultLink(id, hash);
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_song_id: id, p_token_hash: hash });
  assert.equal((await backend.resultLink(id, hash)).song_id, 'test');
  assert.equal(calls[1].target.searchParams.get('token_hash'), `eq.${hash}`);
  await assert.rejects(backend.resultLink(id, 'raw-token'), /local_error/);
  assert.equal(calls.length, 2);
});

test('서버 키는 지정 프로젝트에만 보내고 업로드는 덮어쓰기·자동 재시도 없음', async () => {
  const calls = [];
  const backend = createStorageBackend({ url, serviceRoleKey, fetchImpl: async (target, options) => {
    calls.push({ target, options });
    return new Response('{}');
  } });
  await backend.register({ p_interaction_id: 'same-interaction' });
  await backend.upload(path, new Uint8Array([1, 2]), 'audio/mpeg');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target.origin, url);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${serviceRoleKey}`);
  assert.equal(calls[1].options.headers['x-upsert'], 'false');
  assert.equal(calls[1].options.redirect, 'error');
  for (const invalid of ['http://abcdefghijklmnopqrst.supabase.co', 'https://evil.example', `${url}/other`, `${url}?key=1`, 'https://user:password@abcdefghijklmnopqrst.supabase.co']) {
    assert.throws(() => createStorageBackend({ url: invalid, serviceRoleKey }), /local_error/);
  }
  await assert.rejects(backend.download('../outside'), /local_error/);
  assert.equal(calls.length, 2);
});

test('인증 오류·네트워크 예외는 키와 원문을 숨기고 한 번만 요청', async () => {
  for (const mode of ['http', 'network']) {
    let count = 0;
    const backend = createStorageBackend({ url, serviceRoleKey, fetchImpl: async () => {
      count++;
      if (mode === 'network') throw new Error(serviceRoleKey);
      return new Response(serviceRoleKey, { status: 401 });
    } });
    await assert.rejects(backend.claim(id), error => !error.message.includes(serviceRoleKey) && error.code === (mode === 'http' ? 'http_error' : 'network_error'));
    assert.equal(count, 1);
  }
});

test('오디오가 없다는 구조화된 응답만 업로드 후보로 취급', async () => {
  const missing = createStorageBackend({ url, serviceRoleKey, fetchImpl: async () => new Response(JSON.stringify({ statusCode: '404', error: 'not_found' }), { status: 400 }) });
  assert.equal(await missing.download(path), null);
  const denied = createStorageBackend({ url, serviceRoleKey, fetchImpl: async () => new Response(JSON.stringify({ statusCode: '403', error: 'AccessDenied' }), { status: 400 }) });
  await assert.rejects(denied.download(path), /HTTP 400/);
});

test('삭제는 검증된 정확한 오브젝트 경로만 Storage API에 전달한다', async () => {
  const calls = [];
  const backend = createStorageBackend({ url, serviceRoleKey, fetchImpl: async (target, options) => {
    calls.push({ target, options }); return new Response('[]');
  } });
  await backend.remove([path]);
  assert.equal(calls[0].target.pathname, '/storage/v1/object/nosayeon-audio');
  assert.equal(calls[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].options.body), { prefixes: [path] });
  await assert.rejects(backend.remove(['../outside']), /local_error/);
  await assert.rejects(backend.remove([]), /local_error/);
  assert.equal(calls.length, 1);
});

test('삭제 확인은 POST 목록에서 정확한 파일명을 찾고 캐시 우회 조회는 같은 호스트만 사용한다', async () => {
  const calls = [];
  const backend = createStorageBackend({ url, serviceRoleKey, fetchImpl: async (target, options) => {
    calls.push({ target, options }); return new Response('[]');
  } });
  assert.equal(await backend.objectExists(path), false);
  assert.equal(calls[0].target.pathname, '/storage/v1/object/list/nosayeon-audio');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).search, path.split('/').at(-1));
  await backend.download(path, { fresh: true });
  assert.equal(calls[1].target.origin, url);
  assert.ok(calls[1].target.searchParams.get('cacheNonce'));
});
