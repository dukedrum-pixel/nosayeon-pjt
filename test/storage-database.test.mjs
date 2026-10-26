import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { importGeneratedAudio, sha256, StorageError } from '../src/storage-import.mjs';

const timestamp = '2026-10-26T14:06:27Z';
const original = new TextEncoder().encode('mock-audio-bytes-not-a-real-mp3');
const digest = await sha256(original);
const metadata = [{ file_index: 1, mime_type: 'audio/mpeg', byte_length: original.length, sha256: digest }];
const manifest = id => ({ interactionId: id, model: 'lyria-3.5', generatedAt: timestamp, files: [{ index: 1, mime: 'audio/mpeg', sha256: digest, bytes: original }] });

test('PostgreSQL 마이그레이션과 저장 재개를 실제 SQL 엔진으로 검증', async t => {
  const db = new PGlite();
  try {
    // Minimal stand-in for managed Supabase roles and Storage catalog only.
    // RLS, constraints, transactions and PL/pgSQL execute in PostgreSQL WASM.
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
    `);
    const migration = await readFile(new URL('../supabase/migrations/20261026143658_private_audio_storage.sql', import.meta.url), 'utf8');
    await t.test('공개 버킷 이름 충돌 시 마이그레이션 전체 롤백', async () => {
      await db.exec(`insert into storage.buckets(id, public) values ('nosayeon-audio', true)`);
      await assert.rejects(db.exec(migration), /incompatible settings/);
      await db.exec('rollback');
      assert.equal((await db.query(`select to_regclass('public.songs') as table_name`)).rows[0].table_name, null);
      await db.exec('delete from storage.buckets');
      await db.exec(migration);
      const bucket = (await db.query('select * from storage.buckets')).rows[0];
      assert.equal(bucket.public, false);
      assert.equal(Number(bucket.file_size_limit), 67108864);
      assert.deepEqual(bucket.allowed_mime_types, ['audio/mpeg', 'audio/mp3', 'audio/wav']);
    });

    async function rpc(name, args, types) {
      const placeholders = args.map((_, i) => `$${i + 1}${types?.[i] ? `::${types[i]}` : ''}`).join(',');
      return (await db.query(`select public.${name}(${placeholders}) as result`, args)).rows[0].result;
    }
    const register = id => rpc('register_generated_song', [id, timestamp, JSON.stringify(metadata)], ['text', 'timestamptz', 'jsonb']);

    await t.test('같은 Interaction 등록은 동일 행을 반환하고 해시 변경은 거부', async () => {
      await db.exec('set role service_role');
      const first = await register('duplicate');
      const second = await register('duplicate');
      assert.equal(first.id, second.id);
      const changed = [{ ...metadata[0], sha256: 'a'.repeat(64) }];
      await assert.rejects(rpc('register_generated_song', ['duplicate', timestamp, JSON.stringify(changed)], ['text', 'timestamptz', 'jsonb']), /baseline conflicts/);
      assert.equal((await db.query('select count(*)::integer as count from public.songs')).rows[0].count, 1);
      assert.equal((await db.query('select count(*)::integer as count from public.song_events')).rows[0].count, 1);
      await db.exec('reset role');
    });

    await t.test('익명·로그인 사용자는 테이블과 RPC에 접근할 수 없고 RLS도 차단', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(db.query('select * from public.songs'), /permission denied/);
        await assert.rejects(register('unauthorized'), /permission denied/);
        await db.exec('reset role');
      }
      await db.exec('grant select on public.songs to authenticated; set role authenticated');
      assert.deepEqual((await db.query('select * from public.songs')).rows, []);
      await db.exec('reset role; revoke select on public.songs from authenticated');
    });

    await t.test('동시에 한 작업만 저장을 점유하고 만료된 작업은 완료·실패 처리 불가', async () => {
      await db.exec('set role service_role');
      const song = await register('lease');
      const first = await rpc('claim_song_storage', [song.id]);
      assert.ok(first.storage_claim);
      assert.equal(await rpc('claim_song_storage', [song.id]), null);
      await db.query(`update public.songs set storage_lease_until = now() - interval '1 minute' where id = $1`, [song.id]);
      const second = await rpc('claim_song_storage', [song.id]);
      assert.notEqual(first.storage_claim, second.storage_claim);
      await assert.rejects(rpc('finish_song_storage', [song.id, first.storage_claim]), /lease/);
      assert.equal(await rpc('fail_song_storage', [song.id, first.storage_claim, 'network_error', null]), false);
      assert.equal((await rpc('finish_song_storage', [song.id, second.storage_claim])).storage_status, 'stored');
      assert.equal(await rpc('claim_song_storage', [song.id]), null);
      await db.exec('reset role');
    });

    await t.test('잘못된 오디오 메타데이터는 DB에 부분 기록을 남기지 않음', async () => {
      const before = (await db.query('select count(*) as count from public.songs')).rows[0].count;
      for (const files of [[], [{ ...metadata[0], mime_type: 'text/html' }], [{ ...metadata[0], byte_length: 67108865 }], [metadata[0], metadata[0]]]) {
        await assert.rejects(rpc('register_generated_song', ['invalid', timestamp, JSON.stringify(files)], ['text', 'timestamptz', 'jsonb']));
      }
      assert.equal((await db.query('select count(*) as count from public.songs')).rows[0].count, before);
    });

    function backendFor() {
      const objects = new Map();
      let uploads = 0;
      let breakReadback = true;
      return {
        objects,
        get uploads() { return uploads; },
        register: args => rpc('register_generated_song', [args.p_interaction_id, args.p_generated_at, JSON.stringify(args.p_files)], ['text', 'timestamptz', 'jsonb']),
        claim: songId => rpc('claim_song_storage', [songId]),
        files: async songId => (await db.query('select * from public.song_files where song_id = $1 order by file_index', [songId])).rows,
        download: async path => {
          if (objects.has(path) && breakReadback) { breakReadback = false; throw new StorageError('network_error'); }
          return objects.get(path) ?? null;
        },
        upload: async (path, bytes) => { assert.equal(objects.has(path), false); uploads++; objects.set(path, bytes); },
        finish: (songId, claim) => rpc('finish_song_storage', [songId, claim]),
        fail: (songId, claim, code, status) => rpc('fail_song_storage', [songId, claim, code, status ?? null]),
      };
    }

    await t.test('업로드 후 통신 실패에서 같은 DB 행·파일로 저장만 재개', async () => {
      await db.exec('set role service_role');
      const backend = backendFor();
      await assert.rejects(importGeneratedAudio({ manifest: manifest('resume'), backend }), /network_error/);
      const failed = (await db.query(`select * from public.songs where google_interaction_id = 'resume'`)).rows[0];
      assert.equal(failed.storage_status, 'failed');
      assert.equal(failed.generation_status, 'generated');
      assert.equal(failed.last_error_code, 'network_error');
      const result = await importGeneratedAudio({ manifest: manifest('resume'), backend });
      assert.equal(result.songId, failed.id);
      assert.equal(result.result, 'stored');
      assert.equal(backend.uploads, 1);
      assert.equal((await importGeneratedAudio({ manifest: manifest('resume'), backend })).result, 'already_stored');
      assert.equal(backend.uploads, 1);
      assert.deepEqual((await db.query('select event from public.song_events where song_id = $1 order by created_at, id', [failed.id])).rows.map(row => row.event).sort(), ['registered', 'storage_completed', 'storage_failed', 'storage_started', 'storage_started'].sort());
      await db.exec('reset role');
    });

    await t.test('여러 오디오 중 일부만 업로드됐어도 누락 파일만 저장', async () => {
      await db.exec('set role service_role');
      const backend = backendFor();
      const multi = manifest('multiple-files');
      multi.files.push({ ...multi.files[0], index: 2 });
      await assert.rejects(importGeneratedAudio({ manifest: multi, backend }), /network_error/);
      assert.equal(backend.uploads, 1);
      const result = await importGeneratedAudio({ manifest: multi, backend });
      assert.equal(result.files, 2);
      assert.equal(result.result, 'stored');
      assert.equal(backend.uploads, 2);
      assert.equal(backend.objects.size, 2);
      await db.exec('reset role');
    });

    await t.test('기존 원격 파일의 해시가 다르면 덮어쓰지 않고 저장 실패로 기록', async () => {
      await db.exec('set role service_role');
      const backend = backendFor();
      const song = await register('remote-corruption');
      const row = (await backend.files(song.id))[0];
      backend.objects.set(row.storage_path, new TextEncoder().encode('wrong-object'));
      // First read simulates a network failure; second attempt sees bad bytes.
      await assert.rejects(importGeneratedAudio({ manifest: manifest('remote-corruption'), backend }), /network_error/);
      await assert.rejects(importGeneratedAudio({ manifest: manifest('remote-corruption'), backend }), /content_mismatch/);
      assert.equal(backend.uploads, 0);
      assert.equal((await db.query('select storage_status from public.songs where id = $1', [song.id])).rows[0].storage_status, 'failed');
      await db.exec('reset role');
    });

    await t.test('원본 파일 손상은 원격 기록 이전에 차단', async () => {
      let writes = 0;
      const bad = manifest('bad-audio');
      bad.files[0].bytes = new TextEncoder().encode('corrupted');
      await assert.rejects(importGeneratedAudio({ manifest: bad, backend: { register() { writes++; } } }), /content_mismatch/);
      assert.equal(writes, 0);
    });
  } finally { await db.close(); }
});
