import { parseArgs } from 'node:util';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { createGoogleRestoreClient,RestoreError } from '../src/lyria-restore.mjs';
import { validateAudioFiles } from '../src/audio-files.mjs';
import { SONG_ID } from '../src/result-access.mjs';
import { StorageError,sha256 } from '../src/storage-import.mjs';

async function main() {
  const {values} = parseArgs({options:{'song-id':{type:'string'},'allow-google-read':{type:'boolean',default:false}}});
  const id = values['song-id'];
  if (!SONG_ID.test(id??'') || !values['allow-google-read']) {
    console.log('기존 음악 조회·해시 검증만 실행: npm run restore:verify -- --song-id <UUID> --allow-google-read'); return;
  }
  await mkdir('artifacts/restore-verification',{recursive:true,mode:0o700});
  const dir = await mkdtemp('artifacts/restore-verification/run-');
  try {
    const backend=createStorageBackend({url:process.env.SUPABASE_URL,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
    const song=await backend.song(id);
    if (song.id !== id) throw new RestoreError('invalid_baseline');
    const rows=validateAudioFiles(await backend.files(id),id);
    const baseline={interactionId:song.google_interaction_id,model:song.model,generatedAt:song.generated_at,
      files:rows.map(f=>({index:f.file_index,mime:f.mime_type,byteLength:f.byte_length,sha256:f.sha256}))};
    const files=await createGoogleRestoreClient({apiKey:process.env.GEMINI_API_KEY}).retrieve(baseline);
    for(const file of files) await writeFile(join(dir,`restored-${file.index}.${file.mime==='audio/wav'?'wav':'mp3'}`),file.bytes,{mode:0o600});
    const comparisons=await Promise.all(files.map(async(f,index)=>{
      const recovered=await sha256(f.bytes),original=baseline.files[index].sha256;
      return {index:f.index,mime:f.mime,bytes:f.bytes.byteLength,original_sha256:original,recovered_sha256:recovered,match:original===recovered};
    }));
    if(comparisons.some(f=>!f.match))throw new RestoreError('content_mismatch');
    const report={checked_at:new Date().toISOString(),song_id:id,result:'identical',google_generation_requests:0,
      remote_storage_writes:0,files:comparisons,
      limitation:'현재 시점의 조회·원본 일치 검증이다. 50일 보관 보장이나 재신청 정책 적용을 의미하지 않는다.'};
    await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(`기존 음악 ${files.length}개 원본 해시 일치. 생성·원격 저장·링크 재발급 없음. 보고서: ${dir}/report.json`);
  } catch(error) {
    const known=error instanceof RestoreError||error instanceof StorageError;
    await writeFile(join(dir,'report.json'),JSON.stringify({checked_at:new Date().toISOString(),result:'failed',error_code:known?error.code:'local_error',http_status:known?error.httpStatus??null:null,google_generation_requests:0,remote_storage_writes:0},null,2)+'\n',{mode:0o600});
    console.error('기존 음악 조회 검증을 완료하지 못했습니다. 비공개 보고서를 확인해 주세요. 생성·자동 재시도는 하지 않았습니다.');
    process.exitCode=1;
  }
}
main().catch(()=>{console.error('로컬 설정·실행 경로를 확인해 주세요. 키와 원문 오류는 출력하지 않습니다.');process.exitCode=1;});
