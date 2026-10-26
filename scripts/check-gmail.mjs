import { loadGmailConfiguration } from '../src/gmail-auth.mjs';
import { createGmailDelivery } from '../src/gmail-delivery.mjs';

try {
  const configuration = await loadGmailConfiguration();
  if (!configuration) throw new Error();
  await createGmailDelivery(configuration).checkConnection();
  console.log('Gmail 토큰 갱신·발신 계정 일치 확인 완료. 메일 발송은 실행하지 않았습니다.');
} catch { console.error('Gmail 인증·발신 계정·네트워크 설정을 확인해 주세요. 메일은 발송하지 않았으며 키·원문 응답은 출력하지 않습니다.'); process.exitCode = 1; }
