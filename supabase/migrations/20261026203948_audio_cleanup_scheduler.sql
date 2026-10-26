begin;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create schema if not exists nosayeon_private;
revoke all on schema nosayeon_private from public,anon,authenticated,service_role;

create function nosayeon_private.dispatch_audio_cleanup()
returns bigint language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare v_token text;
begin
  if not exists(select 1 from public.audio_cleanup_settings where id and enabled) then return null; end if;
  select decrypted_secret into strict v_token from vault.decrypted_secrets where name='nosayeon_audio_cleanup_trigger';
  return net.http_post(
    url:='https://fuvgpqkyhuyanbfavwcg.supabase.co/functions/v1/cleanup-expired-audio',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_token),
    body:='{}'::jsonb,timeout_milliseconds:=120000);
end $$;
revoke all on function nosayeon_private.dispatch_audio_cleanup() from public,anon,authenticated,service_role;
revoke all on net.http_request_queue from public,anon,authenticated,service_role;
-- Deployment and verification precede activation. No scheduled job or raw
-- trigger token is created by this migration.
commit;
