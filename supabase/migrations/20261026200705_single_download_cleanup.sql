begin;
set local lock_timeout = '5s';

alter table public.songs drop constraint songs_storage_status_check;
alter table public.songs add constraint songs_storage_status_check
  check (storage_status in ('pending', 'storing', 'stored', 'failed', 'deleted'));

alter table public.song_result_links
  add column download_claim uuid,
  add column download_lease_until timestamptz,
  add column consumed_at timestamptz,
  add column cleanup_status text not null default 'none'
    check (cleanup_status in ('none', 'pending', 'deleting', 'failed', 'deleted')),
  add column cleanup_claim uuid,
  add column cleanup_lease_until timestamptz,
  add constraint download_claim_pair check ((download_claim is null) = (download_lease_until is null)),
  add constraint consumed_has_no_claim check (consumed_at is null or download_claim is null),
  add constraint cleanup_requires_consumption check ((cleanup_status = 'none') = (consumed_at is null)),
  add constraint cleanup_claim_pair check ((cleanup_status = 'deleting') = (cleanup_claim is not null and cleanup_lease_until is not null)),
  add constraint cleanup_no_stale_claim check (cleanup_status = 'deleting' or (cleanup_claim is null and cleanup_lease_until is null));

create function public.claim_result_download(p_song_id uuid, p_token_hash text)
returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_claim uuid;
begin
  update public.song_result_links l set download_claim = gen_random_uuid(),
    download_lease_until = clock_timestamp() + interval '10 minutes'
  where l.song_id = p_song_id and l.token_hash = p_token_hash
    and l.revoked_at is null and l.consumed_at is null
    and l.issued_at <= clock_timestamp() and l.expires_at > clock_timestamp()
    and (l.download_claim is null or l.download_lease_until <= clock_timestamp())
    and exists (select 1 from public.songs s where s.id = l.song_id and s.storage_status = 'stored')
  returning download_claim into v_claim;
  return v_claim;
end $$;

create function public.release_result_download(p_song_id uuid, p_claim uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.song_result_links set download_claim = null, download_lease_until = null
    where song_id = p_song_id and download_claim = p_claim and consumed_at is null;
  return found;
end $$;

create function public.consume_result_download(p_song_id uuid, p_claim uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.song_result_links l set consumed_at = clock_timestamp(),
    download_claim = null, download_lease_until = null, cleanup_status = 'pending'
  where l.song_id = p_song_id and l.download_claim = p_claim
    and l.download_lease_until > clock_timestamp() and l.consumed_at is null
    and l.revoked_at is null and l.expires_at > clock_timestamp()
    and exists (select 1 from public.songs s where s.id = l.song_id and s.storage_status = 'stored');
  return found;
end $$;

create function public.claim_result_cleanup(p_song_id uuid)
returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_claim uuid;
begin
  update public.song_result_links set cleanup_status = 'deleting', cleanup_claim = gen_random_uuid(),
    cleanup_lease_until = clock_timestamp() + interval '10 minutes'
  where song_id = p_song_id and consumed_at is not null
    and (cleanup_status in ('pending', 'failed')
      or (cleanup_status = 'deleting' and cleanup_lease_until <= clock_timestamp()))
  returning cleanup_claim into v_claim;
  return v_claim;
end $$;

create function public.finish_result_cleanup(p_song_id uuid, p_claim uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  -- Match the existing issuance RPC's songs -> links lock order.
  perform 1 from public.songs where id = p_song_id for update;
  update public.song_result_links set cleanup_status = 'deleted', cleanup_claim = null, cleanup_lease_until = null
    where song_id = p_song_id and consumed_at is not null and cleanup_status = 'deleting'
      and cleanup_claim = p_claim and cleanup_lease_until > clock_timestamp();
  if not found then return false; end if;
  update public.songs set storage_status = 'deleted', updated_at = clock_timestamp() where id = p_song_id;
  return true;
end $$;

create function public.fail_result_cleanup(p_song_id uuid, p_claim uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.song_result_links set cleanup_status = 'failed', cleanup_claim = null, cleanup_lease_until = null
    where song_id = p_song_id and cleanup_status = 'deleting' and cleanup_claim = p_claim;
  return found;
end $$;

revoke all on function public.claim_result_download(uuid,text), public.release_result_download(uuid,uuid),
  public.consume_result_download(uuid,uuid), public.claim_result_cleanup(uuid),
  public.finish_result_cleanup(uuid,uuid), public.fail_result_cleanup(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_result_download(uuid,text), public.release_result_download(uuid,uuid),
  public.consume_result_download(uuid,uuid), public.claim_result_cleanup(uuid),
  public.finish_result_cleanup(uuid,uuid), public.fail_result_cleanup(uuid,uuid) to service_role;
commit;
