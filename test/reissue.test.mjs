import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {sha256} from '../src/storage-import.mjs';
import {hashResultToken,createResultHandler} from '../src/result-access.mjs';
import {reissueSong} from '../src/song-reissue.mjs';
import {cleanupResultSong} from '../src/result-cleanup.mjs';

const bytes=new TextEncoder().encode('the-same-original-audio'),hash=await sha256(bytes),token='a'.repeat(43),tokenHash=await hashResultToken(token);
const tokenFor=id=>id.replaceAll('-','')+'a'.repeat(11),tokenHashes=new Map(),hashFor=id=>tokenHashes.get(id);
test('고정 결과 페이지와 무제한 재신청의 SQL·저장·API를 함께 검증한다',async t=>{
 const db=new PGlite(),objects=new Map();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema storage;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for(const name of ['20261026143658_private_audio_storage','20261026154303_result_link_access','20261026200705_single_download_cleanup','20261026203923_expired_audio_cleanup','20261026220530_stable_page_reissue'])await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;
  async function fixture({age=0,storedAge=0,page=true}={}){
   const id=crypto.randomUUID();
   await db.query(`insert into public.songs(id,google_interaction_id,generated_at,storage_status,stored_at) values($1,$2,statement_timestamp()-make_interval(days=>$3),'stored',statement_timestamp()-make_interval(days=>$4))`,[id,id,age,storedAge]);
   const path=`${id}/original/1-${hash}.mp3`;
   await db.query(`insert into public.song_files(song_id,file_index,mime_type,byte_length,sha256,storage_path) values($1,1,'audio/mpeg',$2,$3,$4)`,[id,bytes.length,hash,path]);
   tokenHashes.set(id,await hashResultToken(tokenFor(id)));
   objects.set(path,bytes);if(page)await rpc('issue_initial_result_link',[id,hashFor(id)]);return id;
  }
  const backend={
   beginRestore:(id,h,v)=>rpc('begin_song_restore',[id,h,v]),restoreLease:(id,c)=>rpc('check_song_restore',[id,c]),
   finishRestore:(id,c)=>rpc('finish_song_restore',[id,c]),failRestore:(id,c,e)=>rpc('fail_song_restore',[id,c,e]),
   claimCleanup:id=>rpc('claim_result_cleanup',[id]),cleanupFiles:(id,c)=>rpc('read_claimed_cleanup_files',[id,c]),
   finishCleanup:(id,c)=>rpc('finish_result_cleanup',[id,c]),failCleanup:(id,c)=>rpc('fail_result_cleanup',[id,c]),
   files:async id=>(await db.query('select * from public.song_files where song_id=$1 order by file_index',[id])).rows,
   remove:async paths=>{for(const path of paths)objects.delete(path);},objectExists:async p=>objects.has(p),
   upload:async(p,data)=>{assert.equal(objects.has(p),false);objects.set(p,data);},download:async p=>objects.get(p)??null,
   resultLink:async(id,h)=>{const row=(await db.query('select l.*,s.generated_at,s.storage_status from public.song_result_links l join public.songs s on s.id=l.song_id where l.song_id=$1 and l.token_hash=$2',[id,h])).rows[0];return row?{...row,songs:{generated_at:row.generated_at.toISOString(),storage_status:row.storage_status}}:null;},
   claimDownloadVersion:(id,h,v)=>rpc('claim_versioned_download',[id,h,v]),releaseDownload:(id,c)=>rpc('release_result_download',[id,c]),consumeDownload:(id,c)=>rpc('consume_result_download',[id,c]),
  };
  let retrieveCount=0;
  const client={retrieve:async baseline=>{retrieveCount++;assert.equal(baseline.files[0].sha256,hash);return [{index:1,mime:'audio/mpeg',bytes,sha256:hash}];}};
  const request=(id,path='/api/result',version=0)=>new Request(`http://127.0.0.1:4174${path}?id=${id}&version=${version}`,{method:['/api/restore','/api/download'].includes(path)?'POST':'GET',headers:{Authorization:`Bearer ${tokenFor(id)}`}});

  await t.test('기존 권한을 종료하고 이전 파일부터 삭제한 뒤 같은 음악을 4회 재준비한다',async()=>{
   const id=await fixture();let previous=(await backend.files(id))[0].storage_path;
   const checked={retrieve:async b=>{assert.equal(objects.has(previous),false);return client.retrieve(b);}};
   const handle=createResultHandler({backend,restoreClient:checked});
   for(let version=0;version<4;version++){
    assert.equal((await handle(request(id,'/api/restore',version))).status,200);
    const link=await backend.resultLink(id,hashFor(id));assert.equal(link.delivery_version,version+1);assert.equal(link.token_hash,hashFor(id));
    assert.equal(Date.parse(link.expires_at)-Date.parse(link.issued_at),7*86400000);
    assert.equal((await handle(request(id,'/api/download',version))).status,409);
    previous=(await backend.files(id))[0].storage_path;assert.equal(objects.has(previous),true);
   }
   assert.equal(retrieveCount,4);
   assert.equal((await db.query('select count(*)::integer as n from public.song_notification_outbox where song_id=$1 and status=\'pending_setup\'',[id])).rows[0].n,4);
   const page=await(await handle(request(id))).json();assert.equal(page.canRestore,true);assert.equal(page.deliveryVersion,4);
  });
  await t.test('50일 이후 재신청은 차단하되 직전 발급된 7일 다운로드는 유지한다',async()=>{
   const id=await fixture({age:49});await reissueSong({backend,restoreClient:client,songId:id,tokenHash:hashFor(id),version:0});
   await db.query(`update public.songs set generated_at=clock_timestamp()-interval '50 days' where id=$1`,[id]);
   const handle=createResultHandler({backend,restoreClient:client});const page=await(await handle(request(id))).json();
   assert.equal(page.status,'available');assert.equal(page.canRestore,false);
   assert.equal((await handle(request(id,'/api/restore',1))).status,410);
   assert.equal((await handle(request(id,'/api/download',1))).status,200);
  });
  await t.test('조회 실패 후에도 페이지 인증을 유지하고 부분 파일 정리 후 새 차수로 재시도한다',async()=>{
   const id=await fixture();const failed=await reissueSong({backend,restoreClient:{retrieve:async()=>{throw new Error('PRIVATE');}},songId:id,tokenHash:hashFor(id),version:0});
   assert.equal(failed.result,'failed');const link=await backend.resultLink(id,hashFor(id));assert.equal(link.restore_status,'failed');
   const resumed=await reissueSong({backend,restoreClient:client,songId:id,tokenHash:hashFor(id),version:1});assert.equal(resumed.result,'ready');assert.equal(resumed.deliveryVersion,2);
  });
  await t.test('이전 삭제 작업의 스냅샷과 늦은 완료는 새 차수 파일을 건드리지 못한다',async()=>{
   const id=await fixture({storedAge:8});const old=await backend.claimCleanup(id);const snapshot=await backend.cleanupFiles(id,old);
   await db.query(`update public.song_result_links set cleanup_lease_until=clock_timestamp()-interval '1 second' where song_id=$1`,[id]);
   const ready=await reissueSong({backend,restoreClient:client,songId:id,tokenHash:hashFor(id),version:0});assert.equal(ready.result,'ready');
   await backend.remove(snapshot.map(f=>f.storage_path));assert.equal(await backend.cleanupFiles(id,old),null);
   assert.equal(await backend.finishCleanup(id,old),false);assert.equal(objects.has((await backend.files(id))[0].storage_path),true);
  });
  await t.test('중단된 재신청도 만료된 점유를 회수해 부분 파일을 정리한다',async()=>{
   const id=await fixture();const job=await backend.beginRestore(id,hashFor(id),0);assert.equal(job.result,'started');
   assert.equal((await backend.beginRestore(id,hashFor(id),1)).result,'busy');
   objects.set(job.target_files[0].storage_path,bytes);
   await db.query(`update public.song_result_links set restore_lease_until=clock_timestamp()-interval '1 second' where song_id=$1`,[id]);
   assert.equal((await cleanupResultSong({backend,songId:id})).result,'deleted');
   for(const f of [...job.source_files,...job.target_files])assert.equal(objects.has(f.storage_path),false);
   assert.equal(await backend.finishRestore(id,job.claim),false);
  });
  await t.test('페이지 미발급 파일도 저장 후 7일이 지나면 삭제하고 나중에 고정 페이지를 발급할 수 있다',async()=>{
   const id=await fixture({age:9,storedAge:8,page:false});assert.equal((await cleanupResultSong({backend,songId:id})).result,'deleted');
   await rpc('issue_initial_result_link',[id,hashFor(id)]);
   const handle=createResultHandler({backend,restoreClient:client}),page=await(await handle(request(id))).json();
   assert.equal(page.status,'expired');assert.equal(page.canRestore,true);
  });
  await t.test('익명·로그인 사용자는 재신청 함수·스냅샷·알림 대기열에 접근하지 못한다',async()=>{
   const id=crypto.randomUUID();for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    for(const [name,args] of [['begin_song_restore',[id,tokenHash,0]],['check_song_restore',[id,id]],['finish_song_restore',[id,id]],['fail_song_restore',[id,id,'restore_failed']],['read_claimed_cleanup_files',[id,id]],['claim_versioned_download',[id,tokenHash,0]]])await assert.rejects(rpc(name,args),/permission denied/);
    await assert.rejects(db.query('select * from public.song_notification_outbox'),/permission denied/);await db.exec('reset role');
   }
  });
 }finally{await db.close();}
});
