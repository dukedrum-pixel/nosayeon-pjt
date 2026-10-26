import { parseArgs } from 'node:util';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { cleanupConsumedSong } from '../src/result-cleanup.mjs';
import { SONG_ID } from '../src/result-access.mjs';

try {
  const { values } = parseArgs({ options: { 'song-id': { type: 'string' }, 'allow-storage-delete': { type: 'boolean', default: false } } });
  if (!SONG_ID.test(values['song-id'] ?? '') || !values['allow-storage-delete']) {
    console.log('만료·사용 완료 음악의 삭제만 재시도: npm run result:cleanup -- --song-id <UUID> --allow-storage-delete');
  } else {
    const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const result = await cleanupConsumedSong({ backend, songId: values['song-id'] });
    console.log(`파일 삭제 결과: ${result.result}. 음악 생성·권한 재발급은 없습니다.`);
    if (result.result === 'failed') { console.error(`삭제 오류: ${result.errorCode}${result.httpStatus ? `, HTTP ${result.httpStatus}` : ''}`); process.exitCode = 1; }
  }
} catch { console.error('파일 삭제를 완료하지 못했습니다. 키·경로·원문 오류는 출력하지 않습니다.'); process.exitCode = 1; }
