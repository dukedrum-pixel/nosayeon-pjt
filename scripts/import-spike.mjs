import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadVerifiedRun } from '../src/verified-run.mjs';
import { importGeneratedAudio, StorageError } from '../src/storage-import.mjs';
import { createStorageBackend } from '../src/supabase-storage.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    run: { type: 'string' }, 'allow-storage-write': { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help || !values.run) {
    console.log('기존 검증 음악 → Supabase 비공개 저장소 (음악 생성 없음)\n'
      + '로컬 파일 검사: npm run storage:import -- --run artifacts/lyria/run-XXXXXX\n'
      + '실제 저장: 위 명령 뒤에 --allow-storage-write 추가\n'
      + '필요 설정: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. 키는 출력하지 않습니다.');
    return;
  }
  const manifest = await loadVerifiedRun(values.run);
  console.log(`검증된 원본 ${manifest.files.length}개, ${manifest.files.reduce((sum, file) => sum + file.bytes.length, 0)}바이트. 해시 확인 완료.`);
  if (!values['allow-storage-write']) {
    console.log('로컬 검사만 완료했습니다. DB·Storage·음악 생성 API 호출은 없습니다.');
    return;
  }
  const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  let result;
  try {
    result = await importGeneratedAudio({ manifest, backend, onProgress: console.log });
  } catch (error) {
    const safe = error instanceof StorageError ? error : new StorageError('local_error');
    await writeFile(join(values.run, 'storage-report.json'), JSON.stringify({
      checked_at: new Date().toISOString(), result: 'failed', error_code: safe.code, http_status: safe.httpStatus ?? null,
      next_step: '같은 --run 폴더로 저장만 재개. 음악 생성 명령은 실행하지 않는다.',
    }, null, 2) + '\n', { mode: 0o600 });
    throw safe;
  }
  await writeFile(join(values.run, 'storage-report.json'), JSON.stringify({ checked_at: new Date().toISOString(), ...result }, null, 2) + '\n', { mode: 0o600 });
  console.log(`저장 결과: ${result.result}. 보고서: 실행 폴더의 storage-report.json`);
  if (result.result === 'busy') process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof StorageError ? error.message : '로컬 저장 처리 실패. 설정과 실행 폴더를 확인해 주세요. 음악 생성은 실행하지 않았습니다.');
  process.exitCode = 1;
});
