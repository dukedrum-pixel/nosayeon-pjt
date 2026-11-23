begin;
set local lock_timeout='5s';
create table public.operations_access(id boolean primary key default true check(id),secret_hash text not null check(secret_hash~'^[a-f0-9]{64}$'));
alter table public.operations_access enable row level security;
revoke all on public.operations_access from public,anon,authenticated;
grant select,insert,update on public.operations_access to service_role;
create table public.song_worker_events(
 id uuid primary key default gen_random_uuid(),created_at timestamptz not null default clock_timestamp(),
 kind text not null check(kind in ('started','startup_failed','request_failed','diagnostic','heartbeat_failed')),
 phase text not null check(phase~'^[a-z_]{1,60}$'),code text not null check(code~'^[a-z0-9_]{1,80}$'),
 request_id uuid references public.song_requests(id),http_status integer check(http_status between 100 and 599)
);
alter table public.song_worker_events enable row level security;
revoke all on public.song_worker_events from public,anon,authenticated;
grant select,insert on public.song_worker_events to service_role;
create function public.record_song_worker_event(p_kind text,p_phase text,p_code text,p_request_id uuid default null,p_http_status integer default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 insert into public.song_worker_events(kind,phase,code,request_id,http_status) values(p_kind,p_phase,p_code,p_request_id,p_http_status);
 if p_kind='request_failed' and p_request_id is not null then
  update public.song_requests set error_code=p_phase||'_'||p_code where id=p_request_id and status in ('failed','unknown','mail_failed','mail_unknown');
 end if;return true;
end $$;
create function public.operations_dashboard(p_hash text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.operations_access where id=true and secret_hash=p_hash) then return null;end if;
 select jsonb_build_object(
 'observedAt',clock_timestamp(),
 'runtime',(select jsonb_build_object('enabled',enabled,'workerReady',coalesce(worker_seen_at>clock_timestamp()-interval '60 seconds',false),'workerSeenAt',worker_seen_at,'dailyLimit',50,'concurrency',1) from public.song_request_runtime where id=true),
 'summary',(select jsonb_build_object('total',count(*),'today',count(*) filter(where (created_at at time zone 'Asia/Seoul')::date=(clock_timestamp() at time zone 'Asia/Seoul')::date),'used24h',count(*) filter(where created_at>clock_timestamp()-interval '24 hours'),'queued',count(*) filter(where status='accepted'),'active',count(*) filter(where status in ('generating','saving','notifying')),'completed',count(*) filter(where status='completed'),'errors',count(*) filter(where status in ('failed','unknown','mail_failed','mail_unknown')),'lastCompletedAt',max(updated_at) filter(where status='completed')) from public.song_requests),
 'requests',coalesce((select jsonb_agg(x order by x."createdAt" desc) from (
  select id,status,error_code as "errorCode",created_at as "createdAt",updated_at as "updatedAt",generation_reserved_at as "startedAt",song_id as "songId",
   left(split_part(recipient,'@',1),2)||'***@'||split_part(recipient,'@',2) as recipient,
   public.song_request_queue_state(id) as queue from public.song_requests order by created_at desc,id desc limit 100
 ) x),'[]'::jsonb),
 'restores',coalesce((select jsonb_agg(x order by x."createdAt" desc) from (
  select id,song_id as "songId",requested_version as version,status,created_at as "createdAt",claimed_at as "startedAt",completed_at as "completedAt" from public.song_restore_queue order by created_at desc,id desc limit 50
 ) x),'[]'::jsonb),
 'notifications',coalesce((select jsonb_agg(x order by x."createdAt" desc) from (
  select id,song_id as "songId",delivery_version as version,event,status,error_code as "errorCode",created_at as "createdAt",completed_at as "completedAt" from public.song_notification_outbox order by created_at desc,id desc limit 100
 ) x),'[]'::jsonb),
 'storage',jsonb_build_object('databaseBytes',pg_database_size(current_database()),'songs',(select count(*) from public.songs),'stored',(select count(*) from public.songs where storage_status='stored'),'storedAudioBytes',(select coalesce(sum(f.byte_length),0) from public.song_files f join public.songs s on s.id=f.song_id where s.storage_status='stored'),'cleanupPending',(select count(*) from public.song_result_links where cleanup_status='pending'),'cleanupFailed',(select count(*) from public.song_result_links where cleanup_status='failed')),
 'events',coalesce((select jsonb_agg(x order by x."createdAt" desc) from (
  select id,created_at as "createdAt",kind,phase,code,request_id as "requestId",http_status as "httpStatus" from public.song_worker_events order by created_at desc,id desc limit 50
 ) x),'[]'::jsonb)
 ) into result;
 return result;
end $$;
create function public.operations_request_detail(p_hash text,p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.operations_access where id=true and secret_hash=p_hash) then return null;end if;
 return (select jsonb_build_object('id',j.id,'status',j.status,'recipient',j.recipient,'prompt',j.prompt,'createdAt',j.created_at,'startedAt',j.generation_reserved_at,'updatedAt',j.updated_at,'errorCode',j.error_code,'hasInteraction',j.interaction_id is not null,'songId',j.song_id,'queue',public.song_request_queue_state(j.id),
 'song',(select jsonb_build_object('storageStatus',s.storage_status,'generatedAt',s.generated_at,'version',l.delivery_version,'expiresAt',l.expires_at,'consumedAt',l.consumed_at,'restoreStatus',l.restore_status,'notificationStatus',l.notification_status) from public.songs s left join public.song_result_links l on l.song_id=s.id where s.id=j.song_id)) from public.song_requests j where j.id=p_id);
end $$;
revoke all on function public.record_song_worker_event(text,text,text,uuid,integer),public.operations_dashboard(text),public.operations_request_detail(text,uuid) from public,anon,authenticated;
grant execute on function public.record_song_worker_event(text,text,text,uuid,integer),public.operations_dashboard(text),public.operations_request_detail(text,uuid) to service_role;
commit;
