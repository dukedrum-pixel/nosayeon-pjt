import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createAdminHandler } from '../src/admin-access.mjs';
import { createGmailDelivery, GmailDeliveryError } from '../src/gmail-delivery.mjs';
import { createResultServer } from '../src/result-server.mjs';
import { sha256 } from '../src/storage-import.mjs';

const token = 'a'.repeat(43), id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('existing original MP3 test bytes'), hash = await sha256(bytes);
const generated = new Date().toISOString();
const metadata = { file_index: 1, mime_type: 'audio/mpeg', byte_length: bytes.length, sha256: hash };
function setup(mailer) {
  const calls = [], jobs = new Map();
  const backend = {
    adminDashboard: async () => ({ registeredRequests: 1 }), adminSongs: async () => [], adminHistory: async () => [],
    song: async () => ({ generated_at: generated, storage_status: 'deleted' }), files: async () => [metadata],
    prepareAdminDelivery: async (...args) => { calls.push(['prepare', ...args]); return { result: 'prepared', id }; },
    beginAdminEmail: async (...args) => { const key = args.at(-1); if (jobs.has(key)) return { result: 'existing', status: jobs.get(key) }; jobs.set(key, 'sending'); return { result: 'started', id: key }; },
    finishAdminEmail: async (key, state) => { jobs.set(key, state); return true; },
  };
  const handler = createAdminHandler({ backend, accessToken: token, mailer });
  return { backend, handler, calls, jobs };
}
function request({ path = 'prepare', audio = bytes, auth = token, operationId = id, recipient = 'customer@example.com' } = {}) {
  return new Request(`http://127.0.0.1/api/admin/${path}?id=${id}&index=1&channel=email`, { method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': operationId, 'X-Delivery-To': recipient }, body: audio });
}

test('관리자 인증 없이 조회·업로드가 불가하며 결과 토큰·서비스 키를 관리자 인증으로 쓰지 않는다', async () => {
  const { handler, calls } = setup();
  for (const auth of ['', 'service-secret', 'b'.repeat(43)]) assert.equal((await handler(request({ auth }))).status, 401);
  assert.equal(calls.length, 0);
  assert.throws(() => createAdminHandler({ backend: {}, accessToken: 'short' }));
});

test('삭제된 음악도 백업 MP3 해시가 일치하면 별도 파일로 준비하고 고객 권한은 변경하지 않는다', async () => {
  const { handler, calls } = setup();
  const response = await handler(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await sha256(new Uint8Array(await response.arrayBuffer())), hash);
  assert.deepEqual(calls, [['prepare', id, 1, hash, bytes.length, 'email']]);
  assert.equal(response.headers.get('x-preparation-id'), id);
});

test('잘못된 파일 크기·해시·50일 경과는 감사 기록이나 발송 전에 차단한다', async () => {
  const { handler, backend, calls } = setup();
  assert.equal((await handler(request({ audio: Buffer.alloc(bytes.length) }))).status, 422);
  assert.equal((await handler(request({ audio: Buffer.from('short') }))).status, 422);
  backend.song = async () => ({ generated_at: new Date(Date.now() - 50 * 86400000).toISOString() });
  assert.equal((await handler(request())).status, 410); assert.equal(calls.length, 0);
});

test('Gmail 미연결·헤더 삽입·첨부 크기 초과는 실제 발송 전에 차단한다', async () => {
  assert.equal((await setup().handler(request({ path: 'send-email' }))).status, 503);
  const { handler, backend } = setup({ sender: 'sender@example.com', send: () => { throw new Error('must not send'); } });
  assert.equal((await handler(request({ path: 'send-email', recipient: 'one@example.com,two@example.com' }))).status, 400);
  backend.files = async () => [{ ...metadata, byte_length: 19 * 1048576 }];
  assert.equal((await handler(request({ path: 'send-email' }))).status, 413);
});

test('동일 발송 키는 한 번만 보내고 성공 응답·DB 기록 손실에도 자동 재발송하지 않는다', async () => {
  let sent = 0;
  const { handler, backend, jobs } = setup({ sender: 'sender@example.com', send: async () => { sent++; return { providerMessageId: 'abc' }; } });
  assert.equal((await handler(request({ path: 'send-email' }))).status, 200);
  assert.equal((await handler(request({ path: 'send-email' }))).status, 409);
  assert.equal(sent, 1); assert.equal(jobs.get(id), 'sent');
  backend.finishAdminEmail = async () => { throw new Error('PRIVATE database response lost'); };
  const key = crypto.randomUUID();
  assert.equal((await handler(request({ path: 'send-email', operationId: key }))).status, 503);
  assert.equal((await handler(request({ path: 'send-email', operationId: key }))).status, 409);
  assert.equal(sent, 2); assert.equal(jobs.get(key), 'sending');
});

test('발송 결과가 불명확하면 unknown 이력으로 남기고 오류 원문을 노출하지 않는다', async () => {
  const { handler, jobs } = setup({ sender: 'sender@example.com', send: async () => { throw new GmailDeliveryError('unknown', 'mail_result_unknown'); } });
  const response = await handler(request({ path: 'send-email' }));
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'mail_result_unknown'); assert.equal(jobs.get(id), 'unknown');
});

test('Gmail MIME에 MP3 원본을 첨부하고 토큰을 정확한 Google 호스트에만 전달한다', async () => {
  const calls = [];
  const client = createGmailDelivery({ sender: 'peter@humansyntax.kr', clientId: 'CLIENT', clientSecret: 'SECRET', refreshToken: 'REFRESH',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(calls.length === 1 ? { access_token: 'ACCESS' } : calls.length === 2 ? { email: 'peter@humansyntax.kr', email_verified: true } : { id: 'message123' }); } });
  assert.deepEqual(await client.send({ recipient: 'customer@example.com', bytes, operationId: id }), { providerMessageId: 'message123' });
  assert.equal(calls.length, 3); assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[1].url, 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(calls[2].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ACCESS');
  const mime = Buffer.from(JSON.parse(calls[2].options.body).raw, 'base64url').toString();
  assert.match(mime, /To: customer@example.com\r\n/); assert.match(mime, /From: peter@humansyntax.kr\r\n/);
  const attachment = mime.split('Content-Disposition: attachment; filename="nosayeon.mp3"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
  assert.equal(await sha256(Buffer.from(attachment, 'base64')), hash);
  assert.doesNotMatch(mime, /SECRET|REFRESH|ACCESS/);
});

test('Gmail 토큰 발급 실패는 failed, 발송 POST 타임아웃·서버 오류·응답 손실은 unknown, 재시도는 없다', async () => {
  for (const scenario of ['oauth', 'timeout', 'server', 'bad_json', 'reject']) {
    let calls = 0;
    const client = createGmailDelivery({ sender: 'sender@example.com', clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: async () => {
      calls++;
      if (calls === 1) return scenario === 'oauth' ? new Response('PRIVATE', { status: 401 }) : Response.json({ access_token: 'token' });
      if (calls === 2) return Response.json({ email: 'sender@example.com', email_verified: true });
      if (scenario === 'timeout') throw new Error('PRIVATE');
      return scenario === 'bad_json' ? new Response('PRIVATE') : new Response('PRIVATE', { status: scenario === 'reject' ? 403 : 503 });
    } });
    await assert.rejects(client.send({ recipient: 'customer@example.com', bytes, operationId: id }), error => error.state === (['oauth', 'reject'].includes(scenario) ? 'failed' : 'unknown') && !error.message.includes('PRIVATE'));
    assert.equal(calls, scenario === 'oauth' ? 1 : 3);
  }
});

test('실제 HTTP 서버가 관리자 본문·멱등키·수신처를 전달하고 Origin·인증을 강제한다', async () => {
  let sent = 0;
  const { handler } = setup({ sender: 'sender@example.com', send: async () => { sent++; return { providerMessageId: 'abc' }; } });
  const server = createResultServer({ handler: async () => new Response('public'), adminHandler: handler });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = request({ path: 'send-email' });
    const response = await fetch(base + new URL(req.url).pathname + new URL(req.url).search, { method: 'POST', headers: req.headers, body: bytes });
    assert.equal(response.status, 200); assert.equal(sent, 1);
    assert.equal((await fetch(`${base}/api/admin/dashboard`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(`${base}/admin.html`)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('관리자 SQL은 service_role 전용이고 원본·페이지 상태 보존 및 멱등 발송 상태 전이를 검증한다', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,metadata jsonb);grant usage on schema storage to service_role;grant select on storage.objects to service_role;`);
    for (const name of ['20261026143658_private_audio_storage','20261026154303_result_link_access','20261026200705_single_download_cleanup','20261026203923_expired_audio_cleanup','20261026220530_stable_page_reissue','20261026230353_admin_dashboard']) await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query("insert into public.songs(id,google_interaction_id,generated_at,storage_status) values($1,'verification:admin',now(),'deleted')", [id]);
    await db.query("insert into public.song_files(song_id,file_index,mime_type,byte_length,sha256,storage_path) values($1,1,'audio/mpeg',$2,$3,$4)",[id,bytes.length,hash,`${id}/original/1-${hash}.mp3`]);
    const rpc = async (name, args = []) => (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) value`, args)).rows[0].value;
    await db.exec('set role anon');
    await assert.rejects(rpc('read_admin_dashboard'), /permission denied/);
    await assert.rejects(db.query('select * from public.admin_delivery_exports'), /permission denied/);
    await db.exec('reset role;set role service_role');
    assert.equal((await rpc('prepare_admin_delivery',[id,1,hash,bytes.length,'email'])).result, 'prepared');
    assert.equal((await rpc('prepare_admin_delivery',[id,1,'0'.repeat(64),bytes.length,'email'])).result, 'content_mismatch');
    const args = [id,1,hash,bytes.length,'customer@example.com','peter@humansyntax.kr',id];
    const job = await rpc('begin_admin_email',args); assert.equal(job.result, 'started');
    assert.equal((await rpc('begin_admin_email',args)).result, 'existing');
    assert.equal((await rpc('begin_admin_email',[...args.slice(0,4),'other@example.com',...args.slice(5)])).result, 'conflict');
    assert.equal(await rpc('finish_admin_email',[job.id,'sent','abc',null]), true);
    assert.equal(await rpc('finish_admin_email',[job.id,'unknown',null,'mail_result_unknown']), false);
    const dashboard = await rpc('read_admin_dashboard'); assert.equal(dashboard.generated, 1); assert.equal(dashboard.manualEmailAccepted, 1); assert.equal(dashboard.manualPrepared, 1);
    assert.equal((await db.query('select storage_status from public.songs where id=$1',[id])).rows[0].storage_status,'deleted');
    assert.equal((await db.query('select count(*)::int n from public.song_result_links')).rows[0].n, 0);
    await db.exec('reset role');
    await db.query("update public.songs set generated_at=now()-interval '50 days' where id=$1",[id]);
    assert.equal((await rpc('prepare_admin_delivery',[id,1,hash,bytes.length,'email'])).result, 'retention_ended');
    for (const role of ['anon', 'authenticated']) {
      const permissions = (await db.query("select has_table_privilege($1,'public.admin_delivery_exports','SELECT') allowed,has_function_privilege($1,'public.begin_admin_email(uuid,integer,text,integer,text,text,uuid)','EXECUTE') executable",[role])).rows[0];
      assert.deepEqual(permissions, { allowed: false, executable: false });
    }
  } finally { await db.close(); }
});
