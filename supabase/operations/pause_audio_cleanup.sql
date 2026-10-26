begin;
update public.audio_cleanup_settings set enabled=false where id;
select cron.alter_job((select jobid from cron.job where jobname='nosayeon-audio-cleanup'),active:=false);
commit;
