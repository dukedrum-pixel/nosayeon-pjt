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
 if exists(select 1 from public.song_requests where status in ('accepted','generating','saving','notifying')) then return jsonb_build_object('result','busy');end if;
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
 if exists(select 1 from public.song_requests where status in ('accepted','generating','saving','notifying')) then return jsonb_build_object('result','busy');end if;
 if (select count(*) from public.song_requests where created_at>clock_timestamp()-interval '24 hours')>=50 then return jsonb_build_object('result','daily_limit');end if;
 insert into public.song_requests(id,prompt,token_hash,sealed_token,recipient) values(p_id,p_prompt,p_token_hash,p_sealed_token,p_recipient);
 return jsonb_build_object('result','accepted','id',p_id,'status','accepted');
end $fn$;
commit;
