import { createStorageBackend } from '../src/supabase-storage.mjs';
import { createResultHandler } from '../src/result-access.mjs';
import { createResultServer } from '../src/result-server.mjs';

try {
  const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  const server = createResultServer({ handler: createResultHandler({ backend }) });
  server.on('error', () => { console.error('결과 서버를 시작할 수 없습니다. 설정과 포트를 확인해 주세요.'); process.exitCode = 1; });
  server.listen(4174, '127.0.0.1', () => console.log('로컬 결과 조회 서버: http://127.0.0.1:4174 (키·토큰·요청 URL은 기록하지 않습니다.)'));
} catch { console.error('서버 설정을 확인해 주세요. 키 값은 출력하지 않습니다.'); process.exitCode = 1; }
