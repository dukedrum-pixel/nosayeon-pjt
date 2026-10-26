import { mkdir, open, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { privateJson } from '../src/gmail-auth.mjs';
import { createGmailAuthorizationServer, desktopClient } from '../src/gmail-authorization.mjs';

// Run this on the SAME computer as the browser receiving the loopback callback.
// No browser automation, pasted authorization codes, OOB flow or public tunnel.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--client') {
  console.error('사용: npm run gmail:authorize -- --client /비공개/desktop-client.json'); process.exitCode = 1;
} else {
  try {
    const client = desktopClient(await privateJson(args[1]));
    const target = resolve('artifacts/gmail/credentials.json');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try { await stat(target); throw new Error('already_configured'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let timer;
    const server = createGmailAuthorizationServer({ client, sender: process.env.GMAIL_SENDER || 'peter@humansyntax.kr',
      saveCredentials: async credentials => {
        const file = await open(target, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(credentials)); await file.sync(); }
        finally { await file.close(); }
      },
      onComplete: result => {
        console.log(result.status === 'saved' ? '계정 확인·인증 파일 저장 완료: artifacts/gmail/credentials.json (값 비출력, 메일 미발송)' : `연결 실패 (${result.errorCode}). 키·응답 원문은 출력하지 않습니다.`);
        process.exitCode = result.status === 'saved' ? 0 : 1;
        clearTimeout(timer); server.close();
      },
    });
    server.on('error', () => { console.error('Gmail 연결 서버를 시작할 수 없습니다. 설정과 포트 4175를 확인해 주세요.'); clearTimeout(timer); process.exitCode = 1; });
    server.listen(4175, '127.0.0.1', () => console.log('이 명령을 실행한 컴퓨터의 브라우저에서 http://127.0.0.1:4175/ 를 여세요. 10분간 유효합니다.'));
    timer = setTimeout(() => { console.error('Gmail 연결 시간이 만료되었습니다.'); server.close(); server.closeAllConnections(); process.exitCode = 1; }, 10 * 60000);
  } catch { console.error('비공개 Desktop OAuth 클라이언트 파일과 출력 파일 유무를 확인해 주세요. 기존 인증 파일은 덮어쓰지 않습니다. 키 값은 출력하지 않습니다.'); process.exitCode = 1; }
}
