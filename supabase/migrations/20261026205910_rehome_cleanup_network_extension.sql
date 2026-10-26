-- pg_net is non-relocatable. Its first installation used the default schema;
-- rebuild this newly introduced extension with a safe extension namespace.
-- Pausing dispatch beforehand avoids discarding any queued request.
begin;
do $$
begin
  if exists(select 1 from public.audio_cleanup_settings where enabled) then raise exception 'Pause audio cleanup before rebuilding pg_net'; end if;
  if exists(select 1 from cron.job where jobname='nosayeon-audio-cleanup' and active) then raise exception 'Pause cron before rebuilding pg_net'; end if;
  if exists(select 1 from net.http_request_queue) then raise exception 'Wait for pending network requests'; end if;
end $$;
drop extension pg_net;
create extension pg_net with schema extensions;
revoke all on net.http_request_queue from public,anon,authenticated,service_role;
commit;
