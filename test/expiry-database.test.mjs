import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('만료 정리의 DB 경계·재시도·서버 전용 권한을 검증한다', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const name of ['20261026143658_private_audio_storage','20261026154303_result_link_access','20261026200705_single_download_cleanup','20261026203923_expired_audio_cleanup']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
    }
    const rpc = async (name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;
    async function fixture(expired=false) {
      const id=crypto.randomUUID();
      await db.query(`insert into public.songs(id,google_interaction_id,generated_at,storage_status,stored_at) values($1,$2,now(),'stored',now())`,[id,id]);
      await db.query(`insert into public.song_result_links(song_id,token_hash,issued_at,expires_at)
        values($1,$4,statement_timestamp()-make_interval(days=>$2),statement_timestamp()+make_interval(days=>$3))`,[id,expired?8:0,expired?-1:7,id.replaceAll('-','').repeat(2)]);
      return id;
    }
    const expired=await fixture(true), live=await fixture(), consumed=await fixture();
    const candidates=async()=> (await db.query('select * from public.list_result_cleanup_candidates(20)')).rows.map(row=>row.song_id);
    await db.exec('set role service_role');
    const hash=id=>id.replaceAll('-','').repeat(2);
    const download=await rpc('claim_result_download',[consumed,hash(consumed)]);
    assert.equal(await rpc('consume_result_download',[consumed,download]),true);
    await t.test('만료된 미사용 링크와 사용 완료 링크만 선택하고 유효 링크는 삭제하지 않는다',async()=>{
      assert.deepEqual(new Set(await candidates()),new Set([expired,consumed]));
      assert.equal(await rpc('claim_result_cleanup',[live]),null);
      const claim=await rpc('claim_result_cleanup',[expired]);assert.ok(claim);
      assert.equal(await rpc('claim_result_cleanup',[expired]),null);
      const row=(await db.query('select * from public.song_result_links where song_id=$1',[expired])).rows[0];
      assert.equal(row.cleanup_reason,'expired');assert.equal(row.consumed_at,null);assert.ok(row.expired_at);
      assert.equal(await rpc('finish_result_cleanup',[expired,claim]),true);
      assert.equal((await db.query('select storage_status from public.songs where id=$1',[expired])).rows[0].storage_status,'deleted');
      const used=await rpc('claim_result_cleanup',[consumed]);assert.ok(used);
      assert.equal(await rpc('finish_result_cleanup',[consumed,used]),true);
    });
    await t.test('실패 건은 자동 후보에서 잠시 제외하지만 운영자는 삭제만 바로 재개할 수 있다',async()=>{
      await db.exec('reset role');const id=await fixture(true);await db.exec('set role service_role');
      const first=await rpc('claim_result_cleanup',[id]);await rpc('fail_result_cleanup',[id,first]);
      assert.equal((await candidates()).includes(id),false);
      const row=(await db.query('select cleanup_retry_at,cleanup_attempts from public.song_result_links where song_id=$1',[id])).rows[0];
      assert.equal(row.cleanup_attempts,1);assert.ok(new Date(row.cleanup_retry_at).getTime()>Date.now());
      const manual=await rpc('claim_result_cleanup',[id]);assert.ok(manual);
      await db.query(`update public.song_result_links set cleanup_lease_until=clock_timestamp()-interval '1 second' where song_id=$1`,[id]);
      const next=await rpc('claim_result_cleanup',[id]);assert.notEqual(manual,next);
      assert.equal(await rpc('finish_result_cleanup',[id,manual]),false);
      assert.equal(await rpc('fail_result_cleanup',[id,manual]),false);
      assert.equal(await rpc('finish_result_cleanup',[id,next]),true);
    });
    await t.test('만료 순간의 정리 점유는 이전 다운로드 점유를 무효화한다',async()=>{
      const claim=await rpc('claim_result_download',[live,hash(live)]);assert.ok(claim);
      await db.query(`update public.song_result_links set issued_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' where song_id=$1`,[live]);
      const cleanup=await rpc('claim_result_cleanup',[live]);assert.ok(cleanup);
      assert.equal(await rpc('consume_result_download',[live,claim]),false);
      assert.equal(await rpc('finish_result_cleanup',[live,cleanup]),true);
    });
    await t.test('트리거 인증은 해시와 활성화 상태를 검사하고 익명 역할은 함수·기록에 접근하지 못한다',async()=>{
      await db.exec('reset role');
      await db.query(`insert into public.audio_cleanup_settings(token_hash,enabled) values($1,true)`,['a'.repeat(64)]);
      await db.exec('set role service_role');
      assert.equal(await rpc('authorize_audio_cleanup_job',['a'.repeat(64)]),true);
      assert.equal(await rpc('authorize_audio_cleanup_job',['b'.repeat(64)]),false);
      await assert.rejects(db.query('update public.audio_cleanup_settings set enabled=false'),/permission denied/);
      await rpc('record_audio_cleanup_run',[JSON.stringify({result:'completed',scanned:0,deleted:0,failed:0,skipped:0,deferred:0,duration_ms:1,token:'DO_NOT_SAVE'})]);
      assert.equal(JSON.stringify((await db.query('select * from public.audio_cleanup_runs')).rows).includes('DO_NOT_SAVE'),false);
      await db.exec('reset role');
      for(const role of ['anon','authenticated']){
        await db.exec(`set role ${role}`);
        await assert.rejects(candidates(),/permission denied/);
        await assert.rejects(rpc('authorize_audio_cleanup_job',['a'.repeat(64)]),/permission denied/);
        await assert.rejects(rpc('record_audio_cleanup_run',['{}']),/permission denied/);
        await assert.rejects(db.query('select * from public.audio_cleanup_settings'),/permission denied/);
        await db.exec('reset role');
      }
    });
    await t.test('후보 수는 최대 20개로 제한한다',async()=>{
      for(let i=0;i<23;i++)await fixture(true);
      await db.exec('set role service_role');
      assert.equal((await db.query('select * from public.list_result_cleanup_candidates(10000)')).rows.length,20);
    });
  } finally {await db.close();}
});
