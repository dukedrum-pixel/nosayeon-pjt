import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('최초 결과 링크의 RLS·발급 조건·중복·기간 제한을 실제 SQL 엔진에서 검증', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);`);
    for (const name of ['20261026143658_private_audio_storage', '20261026154303_result_link_access']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    const id = crypto.randomUUID();
    await db.query(`insert into public.songs(id,google_interaction_id,generated_at,storage_status,stored_at) values ($1,'existing-song',now(),'stored',now())`, [id]);
    const issue = (songId = id, hash = 'a'.repeat(64)) => db.query('select public.issue_initial_result_link($1,$2) as result', [songId, hash]);
    await t.test('익명·로그인 사용자는 링크 테이블과 발급 RPC에 접근할 수 없다', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(db.query('select * from public.song_result_links'), /permission denied/);
        await assert.rejects(issue(), /permission denied/);
        await db.exec('reset role');
      }
      await db.exec('grant select on public.song_result_links to authenticated; set role authenticated');
      assert.deepEqual((await db.query('select * from public.song_result_links')).rows, []);
      await db.exec('reset role; revoke select on public.song_result_links from authenticated');
    });
    await t.test('저장 완료 음원에만 해시로 최초 링크를 발급하고 정확히 7일 후 만료된다', async () => {
      await db.exec('set role service_role');
      await assert.rejects(issue(crypto.randomUUID()), /not stored/);
      await assert.rejects(issue(id, 'raw-token'), /check constraint/);
      const result = (await issue()).rows[0].result;
      assert.equal(Date.parse(result.expires_at) - Date.parse(result.issued_at), 7 * 86400000);
      assert.equal(Object.hasOwn(result, 'token_hash'), false);
      await db.exec('reset role');
    });
    await t.test('재호출은 기존 토큰과 발급 시각을 덮어쓰거나 만료를 연장하지 않는다', async () => {
      const first = (await db.query('select * from public.song_result_links')).rows[0];
      await db.exec('set role service_role');
      await assert.rejects(issue(id, 'b'.repeat(64)), /unique constraint/);
      await db.exec('reset role');
      assert.deepEqual((await db.query('select * from public.song_result_links')).rows, [first]);
      await assert.rejects(db.query(`update public.song_result_links set expires_at=issued_at+interval '8 days'`), /check constraint/);
    });
  } finally { await db.close(); }
});
