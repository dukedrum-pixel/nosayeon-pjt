import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { GMAIL_SCOPES, GMAIL_SCOPE, GmailAuthError, googleJson, validAccessToken, verifyGoogleSender } from './gmail-auth.mjs';
import { validEmail } from './gmail-delivery.mjs';

export function desktopClient(document) {
  const client = document?.installed;
  if (!client || typeof client.client_id !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id)
    || typeof client.client_secret !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(client.client_secret)) throw new GmailAuthError('desktop_client_required');
  // Never accept endpoint URLs supplied by a downloaded file.
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

const safeHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
const html = message => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>노사연 Gmail 연결</title><h1>노사연 Gmail 연결</h1><p>${message}</p></html>`;

export function createGmailAuthorizationServer({ client, sender, saveCredentials, onComplete = () => {}, fetchImpl = fetch, clock = Date.now }) {
  if (!validEmail(sender) || typeof saveCredentials !== 'function') throw new GmailAuthError('invalid_mail_configuration');
  const { clientId, clientSecret } = desktopClient({ installed: { client_id: client?.clientId, client_secret: client?.clientSecret } });
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const startedAt = clock(); let consumed = false;
  return createServer(async (req, res) => {
    const reply = (status, message) => res.writeHead(status, { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' }).end(html(message));
    try {
      const port = req.socket.localPort;
      if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') { reply(403, '허용되지 않은 요청입니다.'); return; }
      const base = `http://127.0.0.1:${port}`, url = new URL(req.url, base);
      if (req.headers.origin && req.headers.origin !== base) { reply(403, '허용되지 않은 요청입니다.'); return; }
      if (clock() - startedAt >= 10 * 60000 || consumed) { reply(410, '연결 세션이 종료되었습니다. 명령을 다시 실행해 주세요.'); return; }
      if (url.pathname === '/') {
        reply(200, '발신 계정 이메일 확인과 메일 보내기 권한만 요청합니다. 기존 음악 생성이나 메일 발송은 실행하지 않습니다. <a href="/connect">Google 계정 연결 시작</a>'); return;
      }
      if (url.pathname === '/connect') {
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${base}/callback`, response_type: 'code',
          scope: GMAIL_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
          access_type: 'offline', prompt: 'consent select_account', login_hint: sender }).toString();
        res.writeHead(302, { ...safeHeaders, Location: auth.href }).end(); return;
      }
      if (url.pathname !== '/callback' || (req.url?.length ?? 0) > 16384) { reply(404, '페이지를 찾을 수 없습니다.'); return; }
      const supplied = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state);
      if (url.searchParams.getAll('state').length !== 1 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        reply(403, '연결 세션이 일치하지 않습니다.'); return;
      }
      consumed = true;
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !code || code.length > 8192) throw new GmailAuthError('authorization_denied');
      const result = await googleJson(await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
          grant_type: 'authorization_code', redirect_uri: `${base}/callback` }), signal: AbortSignal.timeout(30000),
      }));
      const scopes = new Set(typeof result.scope === 'string' ? result.scope.split(' ') : []);
      const allowed = new Set([...GMAIL_SCOPES, 'https://www.googleapis.com/auth/userinfo.email']);
      if (!scopes.has(GMAIL_SCOPE) || !scopes.has('openid') || (!scopes.has('email') && !scopes.has('https://www.googleapis.com/auth/userinfo.email'))
        || [...scopes].some(scope => !allowed.has(scope))) throw new GmailAuthError('unexpected_scopes');
      if (!validAccessToken(result.access_token) || typeof result.refresh_token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(result.refresh_token)) throw new GmailAuthError('refresh_token_missing');
      const identity = await verifyGoogleSender({ accessToken: result.access_token, sender, fetchImpl });
      await saveCredentials({ version: 1, sender: identity.sender, clientId, clientSecret, refreshToken: result.refresh_token });
      reply(200, '발신 계정을 확인하고 비공개 인증 파일에 저장했습니다. 이 창을 닫아도 됩니다. 메일은 발송하지 않았습니다.');
      onComplete({ status: 'saved', sender: identity.sender });
    } catch (error) {
      // Never reflect Google's error text, a code, a token or a requested URL.
      reply(400, '연결을 완료하지 못했습니다. 선택한 계정·권한과 네트워크를 확인하고 명령을 다시 실행해 주세요.');
      onComplete({ status: 'failed', errorCode: error instanceof GmailAuthError ? error.code : 'mail_auth_failed' });
    }
  });
}
