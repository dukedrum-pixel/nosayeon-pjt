begin;
set local lock_timeout='5s';
create table public.song_request_runtime(
 id boolean primary key default true check(id), ingress_hash text not null check(ingress_hash~'^[a-f0-9]{64}$'),
 enabled boolean not null default false, worker_seen_at timestamptz,
 recipient text not null default 'dukedrum@gmail.com' check(recipient='dukedrum@gmail.com')
);
create table public.song_requests(
 id uuid primary key, prompt text not null check(length(prompt) between 1 and 12000),
 token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),
 sealed_token text not null check(sealed_token~'^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$'),
 recipient text not null check(recipient='dukedrum@gmail.com'),
 status text not null default 'accepted' check(status in ('accepted','generating','saving','notifying','completed','failed','unknown','mail_failed','mail_unknown')),
 interaction_id text, song_id uuid references public.songs(id), error_code text,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 generation_reserved_at timestamptz
);
create index song_requests_queue on public.song_requests(created_at,id) where status='accepted';
create index song_requests_song on public.song_requests(song_id);
alter table public.song_requests enable row level security;
alter table public.song_request_runtime enable row level security;
revoke all on public.song_requests,public.song_request_runtime from public,anon,authenticated;
grant select,insert,update on public.song_requests,public.song_request_runtime to service_role;

create function public.submit_song_request(p_id uuid,p_prompt text,p_token_hash text,p_sealed_token text,p_ingress_hash text)
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
 if exists(select 1 from public.song_requests where status in ('accepted','generating','saving','notifying')) then return jsonb_build_object('result','busy');end if;
 if (select count(*) from public.song_requests where created_at>clock_timestamp()-interval '24 hours')>=3 then return jsonb_build_object('result','daily_limit');end if;
 insert into public.song_requests(id,prompt,token_hash,sealed_token,recipient) values(p_id,p_prompt,p_token_hash,p_sealed_token,r.recipient);
 return jsonb_build_object('result','accepted','id',p_id,'status','accepted');
end $$;
create function public.read_song_request(p_id uuid,p_ingress_hash text)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',j.id,'status',j.status,'songId',j.song_id,'errorCode',j.error_code,'sealedToken',j.sealed_token)
 from public.song_requests j where j.id=p_id and exists(select 1 from public.song_request_runtime r where r.id=true and r.ingress_hash=p_ingress_hash);
$$;
create function public.song_request_readiness(p_ingress_hash text)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('enabled',enabled,'workerReady',worker_seen_at>clock_timestamp()-interval '60 seconds')
 from public.song_request_runtime where id=true and ingress_hash=p_ingress_hash;
$$;
create function public.touch_song_request_worker()
returns boolean language plpgsql security invoker set search_path='' as $$
begin update public.song_request_runtime set worker_seen_at=clock_timestamp() where id=true and enabled;return found;end $$;
create function public.claim_song_request()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.song_requests;
begin
 if not exists(select 1 from public.song_request_runtime where id=true and enabled and worker_seen_at>clock_timestamp()-interval '60 seconds') then return null;end if;
 select * into job from public.song_requests where status='accepted' order by created_at,id limit 1 for update skip locked;
 if not found then return null;end if;
 update public.song_requests set status='generating',generation_reserved_at=clock_timestamp(),updated_at=clock_timestamp() where id=job.id returning * into job;
 return to_jsonb(job);
end $$;
create function public.progress_song_request(p_id uuid,p_status text,p_interaction_id text default null,p_song_id uuid default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if p_status not in ('generating','saving','notifying','completed','failed','unknown','mail_failed','mail_unknown') then return false;end if;
 update public.song_requests set status=p_status,interaction_id=coalesce(p_interaction_id,interaction_id),song_id=coalesce(p_song_id,song_id),updated_at=clock_timestamp()
 where id=p_id and status in ('generating','saving','notifying')
 and (p_interaction_id is null or interaction_id is null or interaction_id=p_interaction_id)
 and (p_song_id is null or song_id is null or song_id=p_song_id);
 return found;
end $$;
revoke all on function public.submit_song_request(uuid,text,text,text,text),public.read_song_request(uuid,text),public.song_request_readiness(text),public.touch_song_request_worker(),public.claim_song_request(),public.progress_song_request(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.submit_song_request(uuid,text,text,text,text),public.read_song_request(uuid,text),public.song_request_readiness(text),public.touch_song_request_worker(),public.claim_song_request(),public.progress_song_request(uuid,text,text,uuid) to service_role;
commit;
