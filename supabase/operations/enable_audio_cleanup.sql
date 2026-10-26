-- Run only after the authenticated Edge Function is deployed and verified.
-- The token is generated and used inside PostgreSQL; never SELECT its value.
begin;
do $$
declare v_token text; v_hash text;
begin
  if exists(select 1 from public.audio_cleanup_settings where id) then
    select decrypted_secret into strict v_token from vault.decrypted_secrets where name='nosayeon_audio_cleanup_trigger';
    select token_hash into strict v_hash from public.audio_cleanup_settings where id;
    if encode(sha256(convert_to(v_token,'UTF8')),'hex') <> v_hash then raise exception 'Cleanup trigger configuration mismatch'; end if;
    update public.audio_cleanup_settings set enabled=true where id;
  else
    if exists(select 1 from vault.secrets where name='nosayeon_audio_cleanup_trigger') then raise exception 'Cleanup trigger already exists without configuration'; end if;
    v_token:=encode(extensions.gen_random_bytes(32),'hex');
    perform vault.create_secret(v_token,'nosayeon_audio_cleanup_trigger','Dedicated token for the authenticated audio cleanup worker');
    insert into public.audio_cleanup_settings(id,token_hash,enabled) values(true,encode(sha256(convert_to(v_token,'UTF8')),'hex'),true);
  end if;
end $$;
select cron.schedule('nosayeon-audio-cleanup','*/15 * * * *','select nosayeon_private.dispatch_audio_cleanup();');
select cron.alter_job((select jobid from cron.job where jobname='nosayeon-audio-cleanup'),active:=true);
select nosayeon_private.dispatch_audio_cleanup() as request_id;
commit;
