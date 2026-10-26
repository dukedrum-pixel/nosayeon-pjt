import { createStorageBackend } from '../src/supabase-storage.mjs';
import { createResultHandler } from '../src/result-access.mjs';
import { createResultServer } from '../src/result-server.mjs';
import { cleanupConsumedSong } from '../src/result-cleanup.mjs';
import { createGoogleRestoreClient } from '../src/lyria-restore.mjs';
import { createAdminHandler } from '../src/admin-access.mjs';
import { createGmailDelivery } from '../src/gmail-delivery.mjs';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

try {
  const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  const restoreClient=process.env.GEMINI_API_KEY?createGoogleRestoreClient({apiKey:process.env.GEMINI_API_KEY}):undefined;
  let adminToken = process.env.ADMIN_ACCESS_TOKEN;
  if (!adminToken) {
    adminToken = randomBytes(32).toString('base64url');
    await mkdir(new URL('../artifacts/admin/', import.meta.url), { recursive: true, mode: 0o700 });
    await writeFile(new URL('../artifacts/admin/access.json', import.meta.url), JSON.stringify({ token: adminToken }), { mode: 0o600 });
    console.log('로컬 관리자 인증 파일: artifacts/admin/access.json (서버 재시작 시 교체, 값은 출력하지 않습니다.)');
  }
  const capacity = name => process.env[name] ? Number(process.env[name]) : null;
  const gmailConfig = [process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REFRESH_TOKEN];
  if (gmailConfig.some(Boolean) && !gmailConfig.every(Boolean)) throw new Error('incomplete_mail_configuration');
  const sender = process.env.GMAIL_SENDER || 'peter@humansyntax.kr';
  const mailer = gmailConfig.every(Boolean) ? createGmailDelivery({ sender, clientId: gmailConfig[0], clientSecret: gmailConfig[1], refreshToken: gmailConfig[2] }) : undefined;
  const adminHandler = createAdminHandler({ backend, accessToken: adminToken, mailer, sender,
    databaseCapacityBytes: capacity('ADMIN_DATABASE_CAPACITY_BYTES'), storageCapacityBytes: capacity('ADMIN_STORAGE_CAPACITY_BYTES') });
  const server = createResultServer({ handler: createResultHandler({ backend,restoreClient }),
    adminHandler,
    afterDownloadResponse: async songId => {
      const result = await cleanupConsumedSong({ backend, songId });
      if (result.result === 'failed') console.error(`파일 삭제 실패 (${result.errorCode}${result.httpStatus ? `, HTTP ${result.httpStatus}` : ''}). result:cleanup 명령으로 삭제만 재개해 주세요.`);
    },
  });
  server.on('error', () => { console.error('결과 서버를 시작할 수 없습니다. 설정과 포트를 확인해 주세요.'); process.exitCode = 1; });
  server.listen(4174, '127.0.0.1', () => console.log('로컬 결과 조회 서버: http://127.0.0.1:4174 (키·토큰·요청 URL은 기록하지 않습니다.)'));
} catch { console.error('서버 설정을 확인해 주세요. 키 값은 출력하지 않습니다.'); process.exitCode = 1; }
