import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { createGmailAuthorizationServer, desktopClient } from '../src/gmail-authorization.mjs';
import { GMAIL_SCOPE, loadGmailConfiguration } from '../src/gmail-auth.mjs';
import { createGmailDelivery } from '../src/gmail-delivery.mjs';

const client = { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'TEST_SECRET' };
const sender = 'peter@humansyntax.kr';
const grants = `${GMAIL_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`;
async function fixture(overrides = {}) {
  const saved = [], completed = [], calls = [];
  const server = createGmailAuthorizationServer({ client, sender, saveCredentials: async value => saved.push(value), onComplete: result => completed.push(result),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(calls.length === 1 ? { access_token: 'ACCESS_TOKEN', refresh_token: 'REFRESH_TOKEN', scope: grants } : { email: sender, email_verified: true });
    }, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const connect = () => fetch(`${base}/connect`, { redirect: 'manual' });
  const auth = new URL((await connect()).headers.get('location'));
  const callback = (params = {}) => fetch(`${base}/callback?${new URLSearchParams({ code: 'PRIVATE_CODE', state: auth.searchParams.get('state'), ...params })}`);
  return { base, auth, callback, connect, saved, completed, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

test('Desktop 클라이언트만 허용하고 파일 안의 서버 주소는 OAuth 대상으로 사용하지 않는다', () => {
  const document = { installed: { client_id: client.clientId, client_secret: client.clientSecret, token_uri: 'https://evil.example/token' } };
  assert.deepEqual(desktopClient(document), client);
  assert.throws(() => desktopClient({ web: document.installed }), /desktop_client_required/);
  assert.throws(() => desktopClient({ installed: { client_id: 'bad', client_secret: 'x' } }));
});

test('PKCE·state·loopback·최소 권한을 사용하고 계정 확인 후 refresh token만 비공개 저장 콜백에 넘긴다', async () => {
  const f = await fixture();
  try {
    assert.equal(f.auth.origin, 'https://accounts.google.com');
    assert.equal(f.auth.searchParams.get('access_type'), 'offline');
    assert.equal(f.auth.searchParams.get('login_hint'), sender);
    assert.equal(f.auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(f.auth.searchParams.get('scope'), `${GMAIL_SCOPE} openid email`);
    assert.equal(f.auth.searchParams.get('redirect_uri'), `${f.base}/callback`);
    assert.equal((await f.callback({ state: 'wrong' })).status, 403); assert.equal(f.calls.length, 0);
    const response = await f.callback(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PRIVATE_CODE|ACCESS_TOKEN|REFRESH_TOKEN|TEST_SECRET/);
    const body = f.calls[0].options.body;
    assert.equal(body.get('code'), 'PRIVATE_CODE');
    const expectedChallenge = createHash('sha256').update(body.get('code_verifier')).digest('base64url');
    assert.equal(f.auth.searchParams.get('code_challenge'), expectedChallenge);
    assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(f.calls[1].url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.deepEqual(f.saved, [{ version: 1, sender, ...client, refreshToken: 'REFRESH_TOKEN' }]);
    assert.equal(f.completed[0].status, 'saved');
    assert.equal((await f.callback()).status, 410); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('계정 불일치·검증 안 된 이메일·추가 권한·refresh token 누락·거절은 저장하지 않고 원문을 숨긴다', async () => {
  for (const scenario of ['mismatch', 'unverified', 'scope', 'missing', 'rejected', 'network']) {
    let calls = 0;
    const f = await fixture({ fetchImpl: async () => {
      calls++;
      if (scenario === 'network') throw new Error('PRIVATE_NETWORK_RESPONSE');
      if (calls === 1) return Response.json({ access_token: 'ACCESS_TOKEN',
        ...(scenario !== 'missing' ? { refresh_token: 'REFRESH_TOKEN' } : {}),
        scope: grants + (scenario === 'scope' ? ' https://www.googleapis.com/auth/drive' : '') });
      return Response.json({ email: scenario === 'mismatch' ? 'someone@example.com' : sender, email_verified: scenario !== 'unverified' });
    } });
    try {
      const response = await f.callback(scenario === 'rejected' ? { error: 'access_denied', error_description: 'PRIVATE_RESPONSE' } : {});
      assert.equal(response.status, 400); assert.equal(f.saved.length, 0);
      assert.doesNotMatch(await response.text(), /PRIVATE|ACCESS_TOKEN|REFRESH_TOKEN/);
      assert.equal(f.completed[0].status, 'failed');
      assert.equal((await f.callback()).status, 410);
    } finally { await f.close(); }
  }
});

test('외부 Origin·잘못된 Host·만료된 callback은 교환하지 않는다', async () => {
  let time = 0;
  const f = await fixture({ clock: () => time });
  try {
    assert.equal((await fetch(`${f.base}/connect`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const deniedHost = await new Promise((resolve, reject) => get(`${f.base}/connect`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
    assert.equal(deniedHost, 403);
    time = 10 * 60000;
    assert.equal((await f.callback()).status, 410); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('인증 파일은 권한·크기·심볼릭 링크를 검사하며 환경변수 혼합·발신 주소만 교체를 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nosayeon-gmail-test-'));
  try {
    const path = join(directory, 'credentials.json');
    await writeFile(path, JSON.stringify({ version: 1, sender, ...client, refreshToken: 'REFRESH' }), { mode: 0o600 });
    assert.equal(await loadGmailConfiguration({}), null);
    assert.deepEqual(await loadGmailConfiguration({ GMAIL_CREDENTIALS_FILE: path }), { sender, ...client, refreshToken: 'REFRESH' });
    await assert.rejects(loadGmailConfiguration({ GMAIL_CREDENTIALS_FILE: path, GMAIL_CLIENT_ID: 'different' }), /mixed/);
    await assert.rejects(loadGmailConfiguration({ GMAIL_CREDENTIALS_FILE: path, GMAIL_SENDER: 'other@example.com' }), /invalid_mail_configuration/);
    await assert.rejects(loadGmailConfiguration({ GMAIL_CLIENT_SECRET: 'partial' }), /incomplete/);
    const link = join(directory, 'symlink.json'); await symlink(path, link);
    await assert.rejects(loadGmailConfiguration({ GMAIL_CREDENTIALS_FILE: link }), /invalid_private_file/);
    await chmod(path, 0o644); await assert.rejects(loadGmailConfiguration({ GMAIL_CREDENTIALS_FILE: path }), /invalid_private_file/);
    await writeFile(path, 'x'.repeat(16385)); await chmod(path, 0o600);
    await assert.rejects(loadGmailConfiguration({ GMAIL_CREDENTIALS_FILE: path }), /invalid_private_file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('메일 없는 연결 검사는 계정만 확인하고 잘못된 계정은 실제 발송 POST 전에 차단한다', async () => {
  for (const account of [sender, 'someone@example.com']) {
    const calls = [];
    const delivery = createGmailDelivery({ sender, ...client, refreshToken: 'REFRESH', fetchImpl: async (url, options) => {
      calls.push({ url, options }); return Response.json(calls.length % 2 === 1 ? { access_token: 'ACCESS' } : { email: account, email_verified: true });
    } });
    if (account === sender) assert.deepEqual(await delivery.checkConnection(), { sender, status: 'verified' });
    else await assert.rejects(delivery.send({ recipient: 'dukedrum@gmail.com', bytes: Buffer.from('old MP3'), operationId: crypto.randomUUID() }), error => error.code === 'mail_auth_failed' && error.state === 'failed');
    assert.deepEqual(calls.map(x => new URL(x.url).hostname), ['oauth2.googleapis.com','openidconnect.googleapis.com']);
  }
});
