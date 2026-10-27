begin;
set local lock_timeout='5s';
create table public.site_login_attempts(
 client_hash text primary key check(client_hash~'^[a-f0-9]{64}$'), failures integer not null default 0,
 window_started timestamptz not null default clock_timestamp(),blocked_until timestamptz
);
alter table public.site_login_attempts enable row level security;
revoke all on public.site_login_attempts from public,anon,authenticated;
grant select,insert,update,delete on public.site_login_attempts to service_role;
create function public.check_site_login_attempt(p_client_hash text,p_success boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.site_login_attempts;t timestamptz:=clock_timestamp();
begin
 if p_client_hash is null or p_client_hash!~'^[a-f0-9]{64}$' or p_success is null then return jsonb_build_object('allowed',false);end if;
 insert into public.site_login_attempts(client_hash) values(p_client_hash) on conflict do nothing;
 select * into a from public.site_login_attempts where client_hash=p_client_hash for update;
 if a.blocked_until>t then return jsonb_build_object('allowed',false,'blocked',true);end if;
 if p_success then update public.site_login_attempts set failures=0,blocked_until=null,window_started=t where client_hash=p_client_hash;return jsonb_build_object('allowed',true);end if;
 if a.window_started<t-interval '10 minutes' then a.failures:=0;a.window_started:=t;end if;
 a.failures:=a.failures+1;
 update public.site_login_attempts set failures=a.failures,window_started=a.window_started,
  blocked_until=case when a.failures>=5 then t+interval '5 minutes' else null end where client_hash=p_client_hash;
 delete from public.site_login_attempts where window_started<t-interval '1 day' and client_hash<>p_client_hash;
 return jsonb_build_object('allowed',false,'blocked',a.failures>=5);
end $$;

create table public.song_restore_queue(
 id uuid primary key default gen_random_uuid(),song_id uuid not null references public.songs(id),requested_version integer not null check(requested_version>=0),
 token_hash text not null check(token_hash~'^[a-f0-9]{64}$'),sealed_token text not null check(sealed_token~'^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$'),
 status text not null default 'queued' check(status in ('queued','processing','succeeded','failed')),
 claim_id uuid,claimed_at timestamptz,created_at timestamptz not null default clock_timestamp(),completed_at timestamptz,
 unique(song_id,requested_version)
);
create index song_restore_queue_pending on public.song_restore_queue(created_at,id) where status='queued';
alter table public.song_restore_queue enable row level security;
revoke all on public.song_restore_queue from public,anon,authenticated;
grant select,insert,update on public.song_restore_queue to service_role;
create function public.enqueue_song_restore(p_song_id uuid,p_token_hash text,p_version integer,p_sealed_token text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.songs;l public.song_result_links;job public.song_restore_queue;
begin
 if p_version is null or p_version<0 or p_sealed_token is null or p_sealed_token!~'^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$' then return jsonb_build_object('result','invalid_request');end if;
 select * into s from public.songs where id=p_song_id for update;
 select * into l from public.song_result_links where song_id=p_song_id for update;
 if not found or l.token_hash is distinct from p_token_hash or not l.page_issued or l.revoked_at is not null then return jsonb_build_object('result','invalid_link');end if;
 if s.generated_at>clock_timestamp() or s.generated_at+interval '50 days'<=clock_timestamp() then return jsonb_build_object('result','retention_ended');end if;
 if l.delivery_version<>p_version then return jsonb_build_object('result','stale');end if;
 if not exists(select 1 from public.song_request_runtime where id=true and enabled and worker_seen_at>clock_timestamp()-interval '60 seconds') then return jsonb_build_object('result','worker_unavailable');end if;
 update public.song_restore_queue set status='failed',completed_at=clock_timestamp() where song_id=p_song_id and status='processing' and claimed_at<clock_timestamp()-interval '15 minutes';
 if exists(select 1 from public.song_restore_queue where song_id=p_song_id and status in ('queued','processing')) then return jsonb_build_object('result','busy');end if;
 insert into public.song_restore_queue(song_id,requested_version,token_hash,sealed_token) values(p_song_id,p_version,p_token_hash,p_sealed_token)
 on conflict(song_id,requested_version) do update set status='queued',token_hash=excluded.token_hash,sealed_token=excluded.sealed_token,claim_id=null,claimed_at=null,completed_at=null,created_at=clock_timestamp()
 where song_restore_queue.status='failed' returning * into job;
 if not found then return jsonb_build_object('result','stale');end if;
 return jsonb_build_object('result','queued');
end $$;
create function public.has_queued_song_restore(p_song_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.song_restore_queue where song_id=p_song_id and (status='queued' or(status='processing' and claimed_at>clock_timestamp()-interval '15 minutes')));
$$;
create function public.claim_queued_song_restore()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.song_restore_queue;
begin
 if not exists(select 1 from public.song_request_runtime where id=true and enabled and worker_seen_at>clock_timestamp()-interval '60 seconds') then return null;end if;
 select * into job from public.song_restore_queue where status='queued' order by created_at,id limit 1 for update skip locked;
 if not found then return null;end if;
 update public.song_restore_queue set status='processing',claim_id=gen_random_uuid(),claimed_at=clock_timestamp() where id=job.id returning * into job;
 return to_jsonb(job);
end $$;
create function public.finish_queued_song_restore(p_id uuid,p_claim_id uuid,p_success boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if p_success is null then return false;end if;
 update public.song_restore_queue set status=case when p_success then 'succeeded' else 'failed' end,completed_at=clock_timestamp()
 where id=p_id and claim_id=p_claim_id and status='processing';return found;
end $$;
create or replace function public.claim_versioned_download(p_song_id uuid,p_token_hash text,p_version integer)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from public.songs where id=p_song_id for update;
 perform 1 from public.song_result_links where song_id=p_song_id and token_hash=p_token_hash
  and delivery_version=p_version and restore_status='idle' and page_issued for update;
 if not found or public.has_queued_song_restore(p_song_id) then return null;end if;
 return public.claim_result_download(p_song_id,p_token_hash);
end $$;
revoke all on function public.check_site_login_attempt(text,boolean),public.enqueue_song_restore(uuid,text,integer,text),public.has_queued_song_restore(uuid),public.claim_queued_song_restore(),public.finish_queued_song_restore(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.check_site_login_attempt(text,boolean),public.enqueue_song_restore(uuid,text,integer,text),public.has_queued_song_restore(uuid),public.claim_queued_song_restore(),public.finish_queued_song_restore(uuid,uuid,boolean) to service_role;
commit;
