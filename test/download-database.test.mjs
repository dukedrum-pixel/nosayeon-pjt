import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('다운로드 점유·사용·삭제 RPC의 원자적 조건과 권한을 실제 SQL로 검증', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const name of ['20261026143658_private_audio_storage', '20261026154303_result_link_access', '20261026200705_single_download_cleanup', '20261026203923_expired_audio_cleanup']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    const id = crypto.randomUUID(), hash = 'a'.repeat(64);
    await db.query(`insert into public.songs(id,google_interaction_id,generated_at,storage_status,stored_at) values ($1,'download-test',now(),'stored',now())`, [id]);
    const rpc = async (name, args = []) => (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as value`, args)).rows[0].value;
    await rpc('issue_initial_result_link', [id, hash]);
    await t.test('익명·로그인 사용자는 다운로드·정리 RPC를 호출할 수 없다', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        for (const [name, args] of [ ['claim_result_download', [id, hash]], ['release_result_download', [id, id]],
          ['consume_result_download', [id, id]], ['claim_result_cleanup', [id]], ['finish_result_cleanup', [id, id]], ['fail_result_cleanup', [id, id]] ]) {
          await assert.rejects(rpc(name, args), /permission denied/);
        }
        await db.exec('reset role');
      }
    });
    await db.exec('set role service_role');
    await t.test('잘못된 토큰·중복 점유·다른 작업의 해제를 거부한다', async () => {
      assert.equal(await rpc('claim_result_download', [id, 'b'.repeat(64)]), null);
      const claim = await rpc('claim_result_download', [id, hash]); assert.ok(claim);
      assert.equal(await rpc('claim_result_download', [id, hash]), null);
      assert.equal(await rpc('release_result_download', [id, crypto.randomUUID()]), false);
      assert.equal(await rpc('release_result_download', [id, claim]), true);
    });
    await t.test('취소·만료 뒤에는 신규 점유와 이미 시작된 점유의 확정을 거부한다', async () => {
      await db.query('update public.song_result_links set revoked_at=clock_timestamp() where song_id=$1', [id]);
      assert.equal(await rpc('claim_result_download', [id, hash]), null);
      await db.query('update public.song_result_links set revoked_at=null where song_id=$1', [id]);
      const claim = await rpc('claim_result_download', [id, hash]);
      await db.query('update public.song_result_links set revoked_at=clock_timestamp() where song_id=$1', [id]);
      assert.equal(await rpc('consume_result_download', [id, claim]), false);
      await rpc('release_result_download', [id, claim]);
      await db.query(`update public.song_result_links set revoked_at=null,issued_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 hour' where song_id=$1`, [id]);
      assert.equal(await rpc('claim_result_download', [id, hash]), null);
      await db.query(`update public.song_result_links set issued_at=now(),expires_at=now()+interval '7 days' where song_id=$1`, [id]);
    });
    await t.test('만료된 점유는 교체하며 이전 작업은 새 작업을 확정하거나 해제할 수 없다', async () => {
      const first = await rpc('claim_result_download', [id, hash]);
      await db.query(`update public.song_result_links set download_lease_until=now()-interval '1 second' where song_id=$1`, [id]);
      const next = await rpc('claim_result_download', [id, hash]); assert.notEqual(first, next);
      assert.equal(await rpc('consume_result_download', [id, first]), false);
      assert.equal(await rpc('release_result_download', [id, first]), false);
      assert.equal(await rpc('consume_result_download', [id, next]), true);
      assert.equal(await rpc('consume_result_download', [id, next]), false);
      assert.equal(await rpc('claim_result_download', [id, hash]), null);
      assert.equal(await rpc('release_result_download', [id, next]), false);
    });
    await t.test('부분 삭제 후 재개·이전 점유 차단·완료 상태를 유지한다', async () => {
      const first = await rpc('claim_result_cleanup', [id]); assert.ok(first);
      assert.equal(await rpc('claim_result_cleanup', [id]), null);
      await db.query(`update public.song_result_links set cleanup_lease_until=now()-interval '1 second' where song_id=$1`, [id]);
      const next = await rpc('claim_result_cleanup', [id]); assert.notEqual(first, next);
      assert.equal(await rpc('finish_result_cleanup', [id, first]), false);
      assert.equal(await rpc('fail_result_cleanup', [id, first]), false);
      assert.equal(await rpc('fail_result_cleanup', [id, next]), true);
      const retry = await rpc('claim_result_cleanup', [id]);
      assert.equal(await rpc('finish_result_cleanup', [id, retry]), true);
      assert.equal((await db.query('select storage_status from public.songs where id=$1', [id])).rows[0].storage_status, 'deleted');
      assert.equal(await rpc('claim_result_cleanup', [id]), null);
      assert.equal(await rpc('claim_result_download', [id, hash]), null);
    });
  } finally { await db.close(); }
});
