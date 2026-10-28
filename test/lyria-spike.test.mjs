import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, extractAudio, runSpike } from '../src/lyria-spike.mjs';

const audio = (text = 'fake-mp3') => ({ type: 'audio', mime_type: 'audio/mp3', data: Buffer.from(text).toString('base64') });
const interaction = (blocks = [audio()]) => ({
  id: 'test-interaction', status: 'completed',
  steps: [
    { type: 'user_input', content: [audio('not-an-output')] },
    { type: 'model_output', content: [{ type: 'text', text: 'structure' }, ...blocks] },
  ],
});
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nosayeon-spike-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('최초 생성은 POST 1회, 재조회는 GET, 저장 옵션과 키 헤더 사용', async () => {
  const calls = [];
  const client = createClient({ apiKey: 'test-secret', fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(interaction());
  } });
  await client.create('test story');
  await client.get('id/with?chars');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { model: 'lyria-3.5', input: 'test story', store: true });
  assert.equal(calls[0].headers['x-goog-api-key'], 'test-secret');
  assert.equal(calls[1].method, 'GET');
  assert.match(calls[1].url, /id%2Fwith%3Fchars$/);
  assert.equal(calls[0].redirect, 'error');
});

test('HTTP 오류와 fetch 예외에 키/본문을 노출하거나 자동 재시도하지 않음', async () => {
  for (const failure of [() => new Response('secret-prompt-and-token', { status: 429 }), () => { throw new Error('secret-token'); }]) {
    let calls = 0;
    const client = createClient({ apiKey: 'test-secret', fetchImpl: async () => { calls++; return failure(); } });
    await assert.rejects(client.create('story'), (error) => !/secret/.test(error.message));
    assert.equal(calls, 1);
  }
  assert.throws(() => createClient({ apiKey: '' }), /GEMINI_API_KEY/);
});

test('외부 URI 거부, Storage 요청에 Google 키를 전달하지 않음', async () => {
  const calls = [];
  const client = createClient({ apiKey: 'test-secret', fetchImpl: async (url, options) => {
    calls.push(options); return new Response('audio-bytes');
  } });
  for (const url of ['https://evil.example/music', 'http://storage.googleapis.com/file', 'https://user:pass@storage.googleapis.com/file']) {
    assert.throws(() => client.audio(url), /URI/);
  }
  assert.equal(calls.length, 0);
  await client.audio('https://storage.googleapis.com/test/file');
  assert.equal(calls[0].headers['x-goog-api-key'], undefined);
});

test('생성된 모든 audio 블록 추출, user_input은 제외, 손상된 데이터 거부', async () => {
  const files = await extractAudio(interaction([audio('first'), audio('second')]), {});
  assert.deepEqual(files.map((f) => f.bytes.toString()), ['first', 'second']);
  await assert.rejects(extractAudio(interaction([]), {}), /오디오가 없어/);
  await assert.rejects(extractAudio(interaction([{ ...audio(), data: '%invalid' }]), {}), /Base64/);
  await assert.rejects(extractAudio(interaction([{ type: 'audio', mime_type: 'audio/mp3' }]), {}), /모두 없어/);
});

test('동일 해시 보고서 저장, resume은 생성 없이 최초 해시와 비교', async (t) => {
  const root = await workspace(t);
  let creates = 0;
  let gets = 0;
  const client = { create: async () => { creates++; return interaction(); }, get: async () => { gets++; return interaction(); } };
  const first = await runSpike({ root, client });
  assert.equal(first.report.result, 'identical');
  assert.equal(creates, 1);
  assert.equal(gets, 1);
  const second = await runSpike({ resume: first.dir, client: { ...client, get: async () => interaction([audio('changed')]) } });
  assert.equal(second.report.result, 'different');
  assert.equal(creates, 1);
  assert.equal(second.report.original[0].sha256, first.report.original[0].sha256);
  assert.equal(JSON.parse(await readFile(join(first.dir, 'report.json'))).result, 'different');
});

test('GET 실패 후 resume해도 새 곡 생성 없이 복구', async (t) => {
  const root = await workspace(t);
  let runDir;
  let creates = 0;
  const client = {
    create: async () => { creates++; return interaction(); },
    get: async () => { throw new Error('offline'); },
  };
  await assert.rejects(runSpike({ root, client, onProgress: (message) => { if (message.startsWith('검증 폴더: ')) runDir = message.slice('검증 폴더: '.length); } }));
  const resumed = await runSpike({ resume: runDir, client: { ...client, get: async () => interaction() } });
  assert.equal(resumed.report.result, 'identical');
  assert.equal(creates, 1);
});

test('불명확한 생성 실패는 request만 남기고 resume에서 재생성을 거부', async (t) => {
  const root = await workspace(t);
  let runDir;
  let creates = 0;
  const client = { create: async () => { creates++; throw new Error('timeout'); } };
  await assert.rejects(runSpike({ root, client, onProgress: (message) => { runDir = message.slice('검증 폴더: '.length); } }));
  await assert.rejects(runSpike({ resume: runDir, client }), /Google AI Studio/);
  assert.equal(creates, 1);
});

test('in_progress는 GET으로만 완료 대기하고 실패 상태에서 재생성하지 않음', async (t) => {
  const root = await workspace(t);
  let creates = 0;
  let gets = 0;
  const client = {
    create: async () => { creates++; return { id: 'test-interaction', status: 'in_progress' }; },
    get: async () => { gets++; return interaction(); },
  };
  const result = await runSpike({ root, client, pollOptions: { wait: async () => {} } });
  assert.equal(result.report.result, 'identical');
  assert.equal(creates, 1);
  assert.equal(gets, 2);
  await assert.rejects(runSpike({ root, client: { ...client, create: async () => ({ id: 'test', status: 'failed' }) } }), /완료되지/);
});

test('원본 파일 손상 시 비교 중단', async (t) => {
  const root = await workspace(t);
  const client = { create: async () => interaction(), get: async () => interaction() };
  const { dir } = await runSpike({ root, client });
  await writeFile(join(dir, 'original-1.mp3'), 'tampered');
  await assert.rejects(runSpike({ resume: dir, client }), /변경됐어/);
});

test('오디오 URI 응답도 파일 바이트로 비교하고 블록 누락을 탐지', async (t) => {
  const root = await workspace(t);
  const uriBlock = { type: 'audio', mime_type: 'audio/mp3', uri: 'https://storage.googleapis.com/test/file' };
  const client = {
    create: async () => interaction([uriBlock, audio('second')]),
    get: async () => interaction([uriBlock]),
    audio: async () => Buffer.from('same-audio'),
  };
  const result = await runSpike({ root, client });
  assert.equal(result.report.result, 'different');
  assert.equal(result.report.original[0].source, 'uri');
});

test('조회 대기 상한을 넘으면 생성 재요청 없이 종료', async (t) => {
  const root = await workspace(t);
  let creates = 0;
  let gets = 0;
  const pending = { id: 'test-interaction', status: 'in_progress' };
  const client = {
    create: async () => { creates++; return pending; },
    get: async () => { gets++; return pending; },
  };
  await assert.rejects(runSpike({ root, client, pollOptions: { wait: async () => {}, maxPolls: 2 } }), /대기 시간/);
  assert.equal(creates, 1);
  assert.equal(gets, 2);
});

test('multi-megabyte valid audio avoids regexp stack overflow and malformed padding stays rejected',async()=>{
 const bytes=Buffer.alloc(4163356,37),data=bytes.toString('base64');
 const files=await extractAudio(interaction([{type:'audio',mime_type:'audio/mpeg',data}]),{});
 assert.deepEqual(files[0].bytes,bytes);
 for(const invalid of ['A===','AAA','AA=A','====',data+'!'])await assert.rejects(extractAudio(interaction([{type:'audio',mime_type:'audio/mpeg',data:invalid}]),{}),/Base64/);
});
