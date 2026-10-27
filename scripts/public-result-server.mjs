import { createStorageBackend } from '../src/supabase-storage.mjs';
import { createResultHandler } from '../src/result-access.mjs';
import { createResultServer } from '../src/result-server.mjs';
import { cleanupConsumedSong } from '../src/result-cleanup.mjs';
import { createGoogleRestoreClient } from '../src/lyria-restore.mjs';
import { createGmailDelivery } from '../src/gmail-delivery.mjs';
import { loadGmailConfiguration } from '../src/gmail-auth.mjs';
import { notificationConfiguration } from '../src/result-notifications.mjs';
import { startNotificationWorker } from '../src/notification-worker.mjs';
import { publicResultOrigin } from '../src/result-link.mjs';

try {
  const publicOrigin = publicResultOrigin(process.env.RESULT_PUBLIC_ORIGIN);
  const port = Number(process.env.PORT || '8080');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error();
  const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  const restoreClient = process.env.GEMINI_API_KEY ? createGoogleRestoreClient({ apiKey: process.env.GEMINI_API_KEY }) : undefined;
  const configuration = notificationConfiguration();
  const gmail = configuration ? await loadGmailConfiguration() : null;
  if (configuration && !gmail) throw new Error();
  const mailer = gmail ? createGmailDelivery(gmail) : null;
  const server = createResultServer({ publicOrigin, handler: createResultHandler({ backend, restoreClient }),
    afterDownloadResponse: async songId => {
      const result = await cleanupConsumedSong({ backend, songId });
      if (result.result === 'failed') console.error('음원 삭제 확인 필요. 서버 전용 정리 이력을 확인해 주세요.');
    } });
  let stopWorker = () => {};
  server.on('close', () => stopWorker());
  server.on('error', () => { stopWorker(); console.error('공개 결과 서버 시작 실패. 설정과 포트를 확인해 주세요.'); process.exitCode = 1; });
  server.listen(port, '0.0.0.0', () => {
    stopWorker = startNotificationWorker({ backend, mailer, configuration, onResult: result => console.log(`고객 완료 안내: ${JSON.stringify(result)}`) });
    console.log('고객 결과 서버가 준비되었습니다. HTTPS 프록시 뒤에서만 운영하세요. 요청 URL·토큰은 기록하지 않습니다.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopWorker(); server.close();
    // Allow in-flight download/restore/mail to settle before process shutdown.
    const deadline = setTimeout(() => process.exit(1), 650000); deadline.unref();
  });
} catch { console.error('공개 결과 서버 설정이 유효하지 않습니다. 공개 HTTPS 주소·서버 Secret을 확인해 주세요. 값은 출력하지 않습니다.'); process.exitCode = 1; }
