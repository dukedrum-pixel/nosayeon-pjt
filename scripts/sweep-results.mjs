import { parseArgs } from 'node:util';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { runCleanupSweep } from '../src/cleanup-sweep.mjs';

try {
  const { values } = parseArgs({ options: { 'allow-storage-delete': { type: 'boolean', default: false } } });
  if (!values['allow-storage-delete']) console.log('만료·사용 완료 파일 일괄 정리: npm run result:sweep -- --allow-storage-delete');
  else {
    const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, timeoutMs: 5000 });
    const summary = await runCleanupSweep({ backend });
    console.log(JSON.stringify(summary));
    if (summary.result !== 'completed') process.exitCode = 1;
  }
} catch { console.error('파일 정리를 완료하지 못했습니다. 키·토큰·경로·원문은 출력하지 않습니다.'); process.exitCode = 1; }
