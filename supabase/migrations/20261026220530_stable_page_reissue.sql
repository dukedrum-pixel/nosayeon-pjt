begin;
set local lock_timeout='5s';
alter table public.song_files add column delivery_version integer not null default 0 check(delivery_version>=0);
create table public.song_restore_requests(
 id uuid primary key default gen_random_uuid(),song_id uuid not null references public.songs(id) on delete restrict,
 delivery_version integer not null,source_files jsonb not null,
 status text not null check(status in ('restoring','ready','failed')),
 error_code text check(error_code in ('restore_failed','lease_lost','content_mismatch','http_error','network_error')),
 created_at timestamptz not null default clock_timestamp(),completed_at timestamptz,
 unique(song_id,delivery_version)
);
create table public.song_notification_outbox(
 id uuid primary key default gen_random_uuid(),song_id uuid not null references public.songs(id) on delete restrict,
 delivery_version integer not null,event text not null check(event='reissue_ready'),
 status text not null default 'pending_setup' check(status in ('pending_setup','pending','sent','failed')),
 created_at timestamptz not null default clock_timestamp(),unique(song_id,delivery_version,event)
);
alter table public.song_restore_requests enable row level security;
alter table public.song_notification_outbox enable row level security;
revoke all on public.song_restore_requests,public.song_notification_outbox from public,anon,authenticated;
grant select,insert,update on public.song_restore_requests,public.song_notification_outbox to service_role;

alter table public.song_result_links drop constraint cleanup_source;
alter table public.song_result_links drop constraint song_result_links_cleanup_reason_check;
alter table public.song_result_links
 add column delivery_version integer not null default 0 check(delivery_version>=0),
 add column page_issued boolean not null default true,
 add column restore_status text not null default 'idle' check(restore_status in ('idle','restoring','failed')),
 add column restore_request_id uuid references public.song_restore_requests(id) on delete restrict,
 add column restore_lease_until timestamptz,
 add column cleanup_targets jsonb,
 add column cleanup_snapshot jsonb,
 add column notification_status text not null default 'not_sent',
 add constraint cleanup_reason_kind check(cleanup_reason in ('download','expired','restore_failed')),
 add constraint cleanup_source check(cleanup_reason is null
   or(cleanup_reason='download' and consumed_at is not null)
   or(cleanup_reason='expired' and consumed_at is null and expired_at is not null and expired_at>=expires_at)
   or(cleanup_reason='restore_failed' and restore_status='failed'));

-- The seven-day storage window starts at verified storage completion.
update public.song_result_links l set issued_at=s.stored_at,
 expires_at=least(l.expires_at,s.stored_at+interval '7 days')
 from public.songs s where s.id=l.song_id and l.delivery_version=0 and l.cleanup_reason is null and s.stored_at is not null;

create or replace function public.issue_initial_result_link(p_song_id uuid,p_token_hash text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.songs;l public.song_result_links;
begin
 select * into s from public.songs where id=p_song_id and storage_status in ('stored','deleted') and stored_at is not null for update;
 if not found then raise exception 'Song is not stored';end if;
 select * into l from public.song_result_links where song_id=p_song_id for update;
 if found then
  if l.page_issued then raise exception 'Initial page already issued';end if;
  update public.song_result_links set token_hash=p_token_hash,page_issued=true where song_id=p_song_id returning * into l;
 else
  insert into public.song_result_links(song_id,token_hash,issued_at,expires_at)
   values(p_song_id,p_token_hash,s.stored_at,s.stored_at+interval '7 days') returning * into l;
 end if;
 return jsonb_build_object('id',l.id,'song_id',l.song_id,'issued_at',l.issued_at,'expires_at',l.expires_at);
end $$;

create function public.claim_versioned_download(p_song_id uuid,p_token_hash text,p_version integer)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from public.song_result_links where song_id=p_song_id and token_hash=p_token_hash
  and delivery_version=p_version and restore_status='idle' and page_issued for update;
 if not found then return null;end if;
 return public.claim_result_download(p_song_id,p_token_hash);
end $$;

create or replace function public.claim_result_cleanup(p_song_id uuid)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.songs;l public.song_result_links;v_claim uuid;v_files jsonb;
begin
 select * into s from public.songs where id=p_song_id for update;
 if not found then return null;end if;
 -- Expired stored audio without a published page must not escape cleanup.
 if s.storage_status='stored' and s.stored_at+interval '7 days'<=clock_timestamp() then
  insert into public.song_result_links(song_id,token_hash,issued_at,expires_at,page_issued)
   values(p_song_id,encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),s.stored_at,s.stored_at+interval '7 days',false)
   on conflict(song_id) do nothing;
 end if;
 select * into l from public.song_result_links where song_id=p_song_id for update;
 if not found then return null;end if;
 if l.restore_status='restoring' and l.restore_lease_until>clock_timestamp() then return null;end if;
 if l.restore_status='restoring' then
  update public.song_restore_requests set status='failed',error_code='lease_lost' where id=l.restore_request_id;
  update public.song_result_links set restore_status='failed',restore_lease_until=null,cleanup_status='pending',cleanup_reason='restore_failed' where song_id=p_song_id;
  update public.songs set storage_status='failed',storage_claim=null,storage_lease_until=null where id=p_song_id;
  select * into l from public.song_result_links where song_id=p_song_id;
 end if;
 if l.cleanup_status='deleted'
  or not(l.consumed_at is not null or l.expires_at<=clock_timestamp() or l.restore_status='failed')
  or(l.cleanup_status='deleting' and l.cleanup_lease_until>clock_timestamp()) then return null;end if;
 select jsonb_agg(to_jsonb(f) order by f.file_index) into v_files from public.song_files f where f.song_id=p_song_id;
 if l.restore_status='failed' then v_files:=l.cleanup_targets;end if;
 if v_files is null then return null;end if;
 v_claim:=gen_random_uuid();
 update public.song_result_links set cleanup_status='deleting',cleanup_claim=v_claim,
  cleanup_lease_until=clock_timestamp()+interval '10 minutes',cleanup_snapshot=v_files,
  cleanup_reason=case when restore_status='failed' then 'restore_failed' when consumed_at is not null then 'download' else 'expired' end,
  expired_at=case when restore_status<>'failed' and consumed_at is null then coalesce(expired_at,clock_timestamp()) else expired_at end,
  download_claim=null,download_lease_until=null,cleanup_retry_at=null,cleanup_attempts=cleanup_attempts+1 where song_id=p_song_id;
 return v_claim;
end $$;

create function public.read_claimed_cleanup_files(p_song_id uuid,p_claim uuid)
returns jsonb language sql security invoker set search_path=public,pg_temp as $$
 select cleanup_snapshot from public.song_result_links where song_id=p_song_id and cleanup_claim=p_claim
  and cleanup_status='deleting' and cleanup_lease_until>clock_timestamp() and restore_status<>'restoring';
$$;

create or replace function public.finish_result_cleanup(p_song_id uuid,p_claim uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from public.songs where id=p_song_id for update;
 update public.song_result_links set cleanup_status='deleted',cleanup_claim=null,cleanup_lease_until=null,cleanup_retry_at=null
  where song_id=p_song_id and cleanup_claim=p_claim and cleanup_status='deleting'
   and cleanup_lease_until>clock_timestamp() and restore_status<>'restoring';
 if not found then return false;end if;
 update public.songs set storage_status='deleted',storage_claim=null,storage_lease_until=null,updated_at=clock_timestamp() where id=p_song_id;
 return true;
end $$;

create or replace function public.list_result_cleanup_candidates(p_limit integer default 20)
returns table(song_id uuid) language sql security invoker set search_path=public,pg_temp as $$
 select s.id from public.songs s left join public.song_result_links l on l.song_id=s.id
 where(l.song_id is null and s.storage_status='stored' and s.stored_at+interval '7 days'<=clock_timestamp())
 or(l.cleanup_status<>'deleted' and(l.restore_status<>'restoring' or l.restore_lease_until<=clock_timestamp())
  and(l.consumed_at is not null or l.expires_at<=clock_timestamp() or l.restore_status='failed' or(l.restore_status='restoring' and l.restore_lease_until<=clock_timestamp()))
  and(l.cleanup_status in ('none','pending','failed') or(l.cleanup_status='deleting' and l.cleanup_lease_until<=clock_timestamp()))
  and(l.cleanup_retry_at is null or l.cleanup_retry_at<=clock_timestamp()))
 order by s.stored_at,s.id limit greatest(1,least(coalesce(p_limit,20),20));
$$;

create function public.begin_song_restore(p_song_id uuid,p_token_hash text,p_version integer)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.songs;l public.song_result_links;j uuid;v integer;source jsonb;target jsonb;
begin
 select * into s from public.songs where id=p_song_id for update;
 select * into l from public.song_result_links where song_id=p_song_id and token_hash=p_token_hash and page_issued for update;
 if not found or l.revoked_at is not null then return jsonb_build_object('result','invalid_link');end if;
 if s.generated_at>clock_timestamp() or s.generated_at+interval '50 days'<=clock_timestamp() then return jsonb_build_object('result','retention_ended');end if;
 if l.restore_status='restoring' and l.restore_lease_until>clock_timestamp() then return jsonb_build_object('result','busy');end if;
 if l.restore_status='restoring' then
  update public.song_restore_requests set status='failed',error_code='lease_lost' where id=l.restore_request_id;
  update public.song_result_links set restore_status='failed',restore_lease_until=null,cleanup_status='pending',cleanup_reason='restore_failed',cleanup_claim=null,cleanup_lease_until=null where song_id=p_song_id;
  update public.songs set storage_status='failed',storage_claim=null,storage_lease_until=null where id=p_song_id;
  return jsonb_build_object('result','cleanup_required');
 end if;
 if l.restore_status='failed' and l.cleanup_status<>'deleted' then return jsonb_build_object('result','cleanup_required');end if;
 if l.delivery_version<>p_version then return jsonb_build_object('result','stale');end if;
 if l.cleanup_status='deleting' and l.cleanup_lease_until>clock_timestamp() then return jsonb_build_object('result','busy');end if;
 select jsonb_agg(to_jsonb(f) order by f.file_index) into source from public.song_files f where f.song_id=p_song_id;
 if source is null then raise exception 'Audio metadata missing';end if;
 v:=l.delivery_version+1;j:=gen_random_uuid();
 insert into public.song_restore_requests(id,song_id,delivery_version,source_files,status) values(j,p_song_id,v,source,'restoring');
 update public.song_files set delivery_version=v,storage_path=p_song_id::text||'/revisions/'||v||'/original/'||file_index||'-'||sha256||case when mime_type='audio/wav' then '.wav' else '.mp3' end where song_id=p_song_id;
 select jsonb_agg(to_jsonb(f) order by f.file_index) into target from public.song_files f where f.song_id=p_song_id;
 update public.song_result_links set delivery_version=v,restore_status='restoring',restore_request_id=j,
  restore_lease_until=clock_timestamp()+interval '10 minutes',download_claim=null,download_lease_until=null,
  cleanup_status='none',cleanup_reason=null,cleanup_claim=null,cleanup_lease_until=null,cleanup_snapshot=null,
  cleanup_targets=source||target,cleanup_retry_at=null,cleanup_attempts=0 where song_id=p_song_id;
 update public.songs set storage_status='storing',storage_claim=j,storage_lease_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp() where id=p_song_id;
 return jsonb_build_object('result','started','claim',j,'delivery_version',v,'source_files',source,'target_files',target,
  'interaction_id',s.google_interaction_id,'model',s.model,'generated_at',s.generated_at);
end $$;

create or replace function public.claim_song_storage(p_song_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_song public.songs;
begin
 update public.songs set storage_status='storing',storage_claim=gen_random_uuid(),storage_lease_until=now()+interval '10 minutes',updated_at=now(),last_error_code=null,last_http_status=null
 where id=p_song_id and(storage_status in ('pending','failed') or(storage_status='storing' and storage_lease_until<now()))
 and not exists(select 1 from public.song_result_links where song_id=p_song_id and restore_status<>'idle') returning * into v_song;
 if v_song.id is null then return null;end if;
 insert into public.song_events(song_id,event) values(v_song.id,'storage_started');return to_jsonb(v_song);
end $$;

create function public.check_song_restore(p_song_id uuid,p_claim uuid)
returns boolean language sql security invoker set search_path=public,pg_temp as $$
 select exists(select 1 from public.song_result_links l join public.songs s on s.id=l.song_id
  where l.song_id=p_song_id and l.restore_status='restoring' and l.restore_request_id=p_claim
   and l.restore_lease_until>clock_timestamp() and s.storage_claim=p_claim and s.storage_status='storing');
$$;

create function public.finish_song_restore(p_song_id uuid,p_claim uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v integer;t timestamptz:=clock_timestamp();
begin
 perform 1 from public.songs where id=p_song_id for update;
 if not public.check_song_restore(p_song_id,p_claim) then return false;end if;
 update public.songs set storage_status='stored',storage_claim=null,storage_lease_until=null,stored_at=t,updated_at=t where id=p_song_id;
 update public.song_result_links set restore_status='idle',restore_lease_until=null,issued_at=t,expires_at=t+interval '7 days',
  consumed_at=null,expired_at=null,cleanup_status='none',cleanup_reason=null,cleanup_targets=null,
  notification_status='pending_setup' where song_id=p_song_id returning delivery_version into v;
 update public.song_restore_requests set status='ready',completed_at=t where id=p_claim;
 insert into public.song_notification_outbox(song_id,delivery_version,event) values(p_song_id,v,'reissue_ready') on conflict do nothing;
 return true;
end $$;

create function public.fail_song_restore(p_song_id uuid,p_claim uuid,p_error_code text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from public.songs where id=p_song_id for update;
 update public.song_result_links set restore_status='failed',restore_lease_until=null,cleanup_status='pending',cleanup_reason='restore_failed'
  where song_id=p_song_id and restore_request_id=p_claim and restore_status='restoring';
 if not found then return false;end if;
 update public.songs set storage_status='failed',storage_claim=null,storage_lease_until=null,updated_at=clock_timestamp() where id=p_song_id;
 update public.song_restore_requests set status='failed',error_code=p_error_code where id=p_claim;
 return true;
end $$;

revoke all on function public.claim_versioned_download(uuid,text,integer),public.read_claimed_cleanup_files(uuid,uuid),
 public.begin_song_restore(uuid,text,integer),public.check_song_restore(uuid,uuid),public.finish_song_restore(uuid,uuid),public.fail_song_restore(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_versioned_download(uuid,text,integer),public.read_claimed_cleanup_files(uuid,uuid),
 public.begin_song_restore(uuid,text,integer),public.check_song_restore(uuid,uuid),public.finish_song_restore(uuid,uuid),public.fail_song_restore(uuid,uuid,text) to service_role;
commit;
