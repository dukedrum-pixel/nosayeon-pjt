import { parseArgs } from 'node:util';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { createGmailDelivery } from '../src/gmail-delivery.mjs';
import { loadGmailConfiguration } from '../src/gmail-auth.mjs';
import { deliverResultNotifications, notificationConfiguration } from '../src/result-notifications.mjs';

try {
  const { values } = parseArgs({ options: { 'deliver-pending': { type: 'boolean', default: false } } });
  if (!values['deliver-pending']) console.log('실제 발송은 실행하지 않았습니다. 설정 확인 후 --deliver-pending으로 신규 대기 건만 1회 처리합니다.');
  else {
    const configuration = notificationConfiguration();
    if (!configuration) console.log(JSON.stringify({ status: 'disabled' }));
    else {
      const gmail = await loadGmailConfiguration();
      if (!gmail) throw new Error();
      const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
      const result = await deliverResultNotifications({ backend, mailer: createGmailDelivery(gmail), configuration });
      console.log(JSON.stringify(result));
      if (result.failed || result.unknown) process.exitCode = 1;
    }
  }
} catch { console.error('완료 안내 처리를 완료하지 못했습니다. 설정·DB 이력을 확인하세요. 자동 재발송하지 않으며 비밀값·수신처·원문 응답은 출력하지 않습니다.'); process.exitCode = 1; }
