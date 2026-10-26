begin;
set local lock_timeout = '5s';

alter table public.song_result_links drop constraint cleanup_requires_consumption;
alter table public.song_result_links
  add column cleanup_reason text check (cleanup_reason in ('download','expired')),
  add column expired_at timestamptz,
  add column cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  add column cleanup_retry_at timestamptz;
update public.song_result_links set cleanup_reason='download' where consumed_at is not null;
alter table public.song_result_links
  add constraint cleanup_has_reason check ((cleanup_status='none') = (cleanup_reason is null)),
  add constraint cleanup_source check (cleanup_reason is null
    or (cleanup_reason='download' and consumed_at is not null)
    or (cleanup_reason='expired' and consumed_at is null and expired_at is not null and expired_at >= expires_at));
create index song_result_cleanup_due on public.song_result_links(expires_at,song_id) where cleanup_status <> 'deleted';

create or replace function public.consume_result_download(p_song_id uuid, p_claim uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update public.song_result_links l set consumed_at=clock_timestamp(), download_claim=null,
    download_lease_until=null, cleanup_status='pending', cleanup_reason='download'
  where l.song_id=p_song_id and l.download_claim=p_claim
    and l.download_lease_until > clock_timestamp() and l.consumed_at is null
    and l.revoked_at is null and l.expires_at > clock_timestamp()
    and exists (select 1 from public.songs s where s.id=l.song_id and s.storage_status='stored');
  return found;
end $$;

create or replace function public.claim_result_cleanup(p_song_id uuid)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_claim uuid;
begin
  update public.song_result_links l set cleanup_status='deleting',cleanup_claim=gen_random_uuid(),
    cleanup_lease_until=clock_timestamp()+interval '10 minutes',
    cleanup_reason=case when consumed_at is not null then 'download' else 'expired' end,
    expired_at=case when consumed_at is null then coalesce(expired_at,clock_timestamp()) else expired_at end,
    download_claim=null,download_lease_until=null,cleanup_retry_at=null,cleanup_attempts=cleanup_attempts+1
  where l.song_id=p_song_id and (l.consumed_at is not null or l.expires_at <= clock_timestamp())
    and (l.cleanup_status in ('none','pending','failed')
      or (l.cleanup_status='deleting' and l.cleanup_lease_until <= clock_timestamp()))
    and exists (select 1 from public.songs s where s.id=l.song_id and s.storage_status='stored')
  returning cleanup_claim into v_claim;
  return v_claim;
end $$;

create or replace function public.finish_result_cleanup(p_song_id uuid,p_claim uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  perform 1 from public.songs where id=p_song_id and storage_status='stored' for update;
  if not found then return false; end if;
  update public.song_result_links set cleanup_status='deleted',cleanup_claim=null,cleanup_lease_until=null,cleanup_retry_at=null
  where song_id=p_song_id and cleanup_status='deleting' and cleanup_claim=p_claim and cleanup_lease_until > clock_timestamp()
    and (consumed_at is not null or (cleanup_reason='expired' and expires_at <= clock_timestamp()));
  if not found then return false; end if;
  update public.songs set storage_status='deleted',updated_at=clock_timestamp() where id=p_song_id;
  return true;
end $$;

create or replace function public.fail_result_cleanup(p_song_id uuid,p_claim uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update public.song_result_links set cleanup_status='failed',cleanup_claim=null,cleanup_lease_until=null,
    cleanup_retry_at=clock_timestamp()+make_interval(secs => least(21600,900*power(2,least(greatest(cleanup_attempts-1,0),5)))::double precision)
    where song_id=p_song_id and cleanup_status='deleting' and cleanup_claim=p_claim;
  return found;
end $$;

create function public.list_result_cleanup_candidates(p_limit integer default 20)
returns table(song_id uuid) language sql security invoker set search_path=public,pg_temp as $$
  select l.song_id from public.song_result_links l join public.songs s on s.id=l.song_id
  where s.storage_status='stored' and l.cleanup_status <> 'deleted' and (l.consumed_at is not null or l.expires_at <= clock_timestamp())
    and (l.cleanup_status in ('none','pending','failed') or (l.cleanup_status='deleting' and l.cleanup_lease_until <= clock_timestamp()))
    and (l.cleanup_retry_at is null or l.cleanup_retry_at <= clock_timestamp())
  order by coalesce(l.consumed_at,l.expires_at),l.song_id limit greatest(1,least(coalesce(p_limit,20),20));
$$;

create table public.audio_cleanup_settings (
  id boolean primary key default true check(id),
  token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean not null default false
);
create table public.audio_cleanup_runs (
  id uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default clock_timestamp(),
  result text not null check(result in ('completed','partial','failed')),
  scanned integer not null check(scanned between 0 and 20),
  deleted integer not null check(deleted between 0 and 20),
  failed integer not null check(failed between 0 and 20),
  skipped integer not null check(skipped between 0 and 20),
  deferred integer not null check(deferred between 0 and 20),
  duration_ms integer not null check(duration_ms between 0 and 300000)
);
create index audio_cleanup_runs_time on public.audio_cleanup_runs(checked_at);
alter table public.audio_cleanup_settings enable row level security;
alter table public.audio_cleanup_runs enable row level security;
revoke all on public.audio_cleanup_settings,public.audio_cleanup_runs from public,anon,authenticated;
grant select on public.audio_cleanup_settings to service_role;
grant select,insert,delete on public.audio_cleanup_runs to service_role;

create function public.authorize_audio_cleanup_job(p_token_hash text)
returns boolean language sql security invoker set search_path=public,pg_temp as $$
  select exists(select 1 from public.audio_cleanup_settings where id and enabled and token_hash=p_token_hash);
$$;
create function public.record_audio_cleanup_run(p_summary jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  insert into public.audio_cleanup_runs(result,scanned,deleted,failed,skipped,deferred,duration_ms)
    values(p_summary->>'result',(p_summary->>'scanned')::integer,(p_summary->>'deleted')::integer,
      (p_summary->>'failed')::integer,(p_summary->>'skipped')::integer,(p_summary->>'deferred')::integer,(p_summary->>'duration_ms')::integer);
  delete from public.audio_cleanup_runs where checked_at < clock_timestamp()-interval '30 days';
end $$;

revoke all on function public.list_result_cleanup_candidates(integer),public.authorize_audio_cleanup_job(text),public.record_audio_cleanup_run(jsonb) from public,anon,authenticated;
grant execute on function public.list_result_cleanup_candidates(integer),public.authorize_audio_cleanup_job(text),public.record_audio_cleanup_run(jsonb) to service_role;
commit;
