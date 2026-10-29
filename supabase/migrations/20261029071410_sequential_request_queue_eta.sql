begin;
set local lock_timeout='5s';
create or replace function public.submit_song_request(p_id uuid,p_prompt text,p_token_hash text,p_sealed_token text,p_ingress_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.song_request_runtime; existing public.song_requests;
begin
 select * into r from public.song_request_runtime where id=true for update;
 if not found or not r.enabled or r.ingress_hash is distinct from p_ingress_hash then return jsonb_build_object('result','unauthorized');end if;
 select * into existing from public.song_requests where id=p_id;
 if found then
  if existing.prompt is distinct from p_prompt or existing.token_hash is distinct from p_token_hash then return jsonb_build_object('result','conflict');end if;
  return jsonb_build_object('result','existing','id',existing.id,'status',existing.status);
 end if;
 if r.worker_seen_at is null or r.worker_seen_at<clock_timestamp()-interval '60 seconds' then return jsonb_build_object('result','worker_unavailable');end if;
 if (select count(*) from public.song_requests where created_at>clock_timestamp()-interval '24 hours')>=50 then return jsonb_build_object('result','daily_limit');end if;
 insert into public.song_requests(id,prompt,token_hash,sealed_token,recipient) values(p_id,p_prompt,p_token_hash,p_sealed_token,r.recipient);
 return jsonb_build_object('result','accepted','id',p_id,'status','accepted');
end $$;

create or replace function public.submit_song_request_to_email(p_id uuid,p_prompt text,p_token_hash text,p_sealed_token text,p_ingress_hash text,p_recipient text)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare r public.song_request_runtime; existing public.song_requests;
begin
 if p_recipient is null or not (length(p_recipient) between 1 and 254 and p_recipient ~ $email$^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$$email$ and position('..' in p_recipient)=0) then return jsonb_build_object('result','invalid_recipient');end if;
 select * into r from public.song_request_runtime where id=true for update;
 if not found or not r.enabled or r.ingress_hash is distinct from p_ingress_hash then return jsonb_build_object('result','unauthorized');end if;
 select * into existing from public.song_requests where id=p_id;
 if found then
  if existing.prompt is distinct from p_prompt or existing.token_hash is distinct from p_token_hash or existing.recipient is distinct from p_recipient then return jsonb_build_object('result','conflict');end if;
  return jsonb_build_object('result','existing','id',existing.id,'status',existing.status);
 end if;
 if r.worker_seen_at is null or r.worker_seen_at<clock_timestamp()-interval '60 seconds' then return jsonb_build_object('result','worker_unavailable');end if;
 if (select count(*) from public.song_requests where created_at>clock_timestamp()-interval '24 hours')>=50 then return jsonb_build_object('result','daily_limit');end if;
 insert into public.song_requests(id,prompt,token_hash,sealed_token,recipient) values(p_id,p_prompt,p_token_hash,p_sealed_token,p_recipient);
 return jsonb_build_object('result','accepted','id',p_id,'status','accepted');
end $fn$;
-- All claimers serialize on the runtime row; the lock ends before external API calls.
create or replace function public.claim_song_request()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.song_requests;
begin
 perform 1 from public.song_request_runtime where id=true and enabled and worker_seen_at>clock_timestamp()-interval '60 seconds' for update;
 if not found then return null;end if;
 if exists(select 1 from public.song_requests where status in ('generating','saving','notifying'))
  or exists(select 1 from public.song_restore_queue where status='processing') then return null;end if;
 select * into job from public.song_requests where status='accepted' order by created_at,id limit 1 for update;
 if not found then return null;end if;
 if exists(select 1 from public.song_restore_queue where status='queued' and (created_at,id)<(job.created_at,job.id)) then return null;end if;
 update public.song_requests set status='generating',generation_reserved_at=clock_timestamp(),updated_at=clock_timestamp() where id=job.id returning * into job;
 return to_jsonb(job);
end $$;
create or replace function public.claim_queued_song_restore()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.song_restore_queue;
begin
 perform 1 from public.song_request_runtime where id=true and enabled and worker_seen_at>clock_timestamp()-interval '60 seconds' for update;
 if not found then return null;end if;
 if exists(select 1 from public.song_requests where status in ('generating','saving','notifying'))
  or exists(select 1 from public.song_restore_queue where status='processing') then return null;end if;
 select * into job from public.song_restore_queue where status='queued' order by created_at,id limit 1 for update;
 if not found then return null;end if;
 if exists(select 1 from public.song_requests where status='accepted' and (created_at,id)<(job.created_at,job.id)) then return null;end if;
 update public.song_restore_queue set status='processing',claim_id=gen_random_uuid(),claimed_at=clock_timestamp() where id=job.id returning * into job;
 return to_jsonb(job);
end $$;

create function public.song_request_queue_state(p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare j public.song_requests;t timestamptz:=clock_timestamp();unit_seconds integer;queued_ahead integer;active_count integer;remaining integer;eta integer;ready boolean;stalled boolean;
begin
 select * into j from public.song_requests where id=p_id;
 if not found or j.status not in ('accepted','generating','saving','notifying') then return null;end if;
 select coalesce(enabled and worker_seen_at>t-interval '60 seconds',false) into ready from public.song_request_runtime where id=true;
 select coalesce(ceil(avg(seconds)*1.3)::integer,180) into unit_seconds from (
  select greatest(1,extract(epoch from updated_at-generation_reserved_at)) as seconds
  from public.song_requests where status='completed' and generation_reserved_at is not null
   and updated_at>=generation_reserved_at order by updated_at desc limit 20
 ) recent;
 unit_seconds:=greatest(60,least(600,unit_seconds));
 select count(*)::integer,coalesce(sum(greatest(30,unit_seconds-extract(epoch from t-started))),0)::integer,
  coalesce(bool_or(started is null or started<t-interval '20 minutes'),false)
 into active_count,remaining,stalled from (
  select generation_reserved_at as started from public.song_requests where status in ('generating','saving','notifying')
  union all select claimed_at from public.song_restore_queue where status='processing'
 ) active;
 select count(*)::integer into queued_ahead from (
  select created_at,id from public.song_requests where status='accepted'
  union all select created_at,id from public.song_restore_queue where status='queued'
 ) q where (q.created_at,q.id)<(j.created_at,j.id);
 if j.status='accepted' then eta:=remaining+(queued_ahead+1)*unit_seconds;
 else eta:=greatest(30,unit_seconds-extract(epoch from t-j.generation_reserved_at))::integer;queued_ahead:=0;active_count:=0;end if;
 return jsonb_build_object('position',case when j.status='accepted' then queued_ahead+active_count+1 else 0 end,
  'ahead',queued_ahead+active_count,'estimatedSeconds',case when ready and not stalled then eta else null end,
  'estimatedAt',t,'estimatedCompletionAt',case when ready and not stalled then t+eta*interval '1 second' else null end,
  'paused',not coalesce(ready,false) or stalled,'sampleSeconds',unit_seconds);
end $$;

create or replace function public.read_song_request(p_id uuid,p_ingress_hash text)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',j.id,'status',j.status,'songId',j.song_id,'errorCode',j.error_code,
  'sealedToken',j.sealed_token,'recipient',j.recipient,'queue',public.song_request_queue_state(j.id))
 from public.song_requests j where j.id=p_id and exists(select 1 from public.song_request_runtime r where r.id=true and r.ingress_hash=p_ingress_hash);
$$;
revoke all on function public.song_request_queue_state(uuid) from public,anon,authenticated;
grant execute on function public.song_request_queue_state(uuid) to service_role;
commit;
