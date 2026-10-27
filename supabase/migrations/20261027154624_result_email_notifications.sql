begin;
set local lock_timeout = '5s';

create table public.song_email_settings (
  song_id uuid primary key references public.songs(id) on delete restrict,
  recipient text not null check (length(recipient) between 3 and 254 and recipient !~ '[[:space:]]'),
  sender text not null check (length(sender) between 3 and 254 and sender !~ '[[:space:]]'),
  public_origin text not null check (public_origin ~ '^https://[a-z0-9.-]+\.[a-z]{2,63}$'),
  sealed_token text not null check (sealed_token ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$'),
  enabled boolean not null default true,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.song_email_settings enable row level security;
revoke all on public.song_email_settings from public, anon, authenticated;
grant select, insert, update on public.song_email_settings to service_role;

alter table public.song_notification_outbox drop constraint song_notification_outbox_event_check;
alter table public.song_notification_outbox drop constraint song_notification_outbox_status_check;
alter table public.song_notification_outbox
  add constraint song_notification_event check (event in ('initial_ready', 'reissue_ready')),
  add constraint song_notification_status check (status in ('pending_setup','pending','sending','sent','failed','unknown','skipped')),
  add constraint song_notification_version unique (song_id, delivery_version),
  add column operation_id uuid unique,
  add column recipient text,
  add column sender text,
  add column started_at timestamptz,
  add column completed_at timestamptz,
  add column provider_message_id text check (provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  add column error_code text check (error_code in ('invalid_mail','mail_auth_failed','mail_rejected','mail_result_unknown','no_longer_available')),
  add constraint song_notification_attempt check (
    (status in ('pending_setup','pending','skipped') and operation_id is null)
    or (status in ('sending','sent','failed','unknown') and operation_id is not null and recipient is not null and sender is not null and started_at is not null)
    -- Preserve legacy completed rows without manufacturing provider evidence.
    or (status in ('sent','failed') and operation_id is null and completed_at is null)
  );
create index song_notification_pending on public.song_notification_outbox(created_at, id)
  where status in ('pending_setup','pending');

create function public.configure_song_email(p_song_id uuid, p_token_hash text, p_recipient text, p_sender text, p_public_origin text, p_sealed_token text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare l public.song_result_links; s public.songs;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_recipient is null or p_sender is null
    or length(p_recipient) not between 3 and 254 or length(p_sender) not between 3 and 254
    or p_recipient ~ '[[:space:]]' or p_sender ~ '[[:space:]]'
    or p_public_origin is null or p_public_origin !~ '^https://[a-z0-9.-]+\.[a-z]{2,63}$'
    or p_sealed_token is null or p_sealed_token !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$'
    then return jsonb_build_object('result','invalid_request'); end if;
  select * into s from public.songs where id = p_song_id for update;
  if not found then return jsonb_build_object('result','invalid_link'); end if;
  select * into l from public.song_result_links where song_id = p_song_id for update;
  if not found or not l.page_issued or l.revoked_at is not null or l.token_hash <> p_token_hash
    then return jsonb_build_object('result','invalid_link'); end if;
  if exists (select 1 from public.song_notification_outbox where song_id=p_song_id and status='sending')
    then return jsonb_build_object('result','busy'); end if;
  insert into public.song_email_settings(song_id,recipient,sender,public_origin,sealed_token)
    values(p_song_id,p_recipient,p_sender,p_public_origin,p_sealed_token)
    on conflict(song_id) do update set recipient=excluded.recipient,sender=excluded.sender,
      public_origin=excluded.public_origin,sealed_token=excluded.sealed_token,enabled=true,updated_at=clock_timestamp();
  if s.storage_status='stored' and l.restore_status='idle' and l.consumed_at is null and l.expires_at>clock_timestamp() then
    insert into public.song_notification_outbox(song_id,delivery_version,event)
      values(p_song_id,l.delivery_version,case when l.delivery_version=0 then 'initial_ready' else 'reissue_ready' end)
      on conflict do nothing;
    update public.song_result_links set notification_status=(select status from public.song_notification_outbox
      where song_id=p_song_id and delivery_version=l.delivery_version) where song_id=p_song_id;
  end if;
  return jsonb_build_object('result','configured');
end $$;

create function public.list_result_notification_candidates(p_limit integer default 10)
returns table(id uuid) language sql stable security invoker set search_path = '' as $$
  select n.id from public.song_notification_outbox n
    join public.song_email_settings e on e.song_id=n.song_id and e.enabled
    where n.status in ('pending_setup','pending')
    order by n.created_at,n.id limit greatest(1,least(coalesce(p_limit,10),20));
$$;

create function public.begin_result_notification(p_id uuid, p_public_origin text, p_sender text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare n public.song_notification_outbox; l public.song_result_links; s public.songs; e public.song_email_settings; song uuid; operation uuid;
begin
  select song_id into song from public.song_notification_outbox where id=p_id;
  if not found then return jsonb_build_object('result','not_found'); end if;
  -- Use the same lock order as restore/download to avoid cycles.
  select * into s from public.songs where id=song for update;
  select * into l from public.song_result_links where song_id=song for update;
  select * into e from public.song_email_settings where song_id=song for update;
  select * into n from public.song_notification_outbox where id=p_id for update;
  if n.status not in ('pending_setup','pending') then return jsonb_build_object('result','existing','status',n.status); end if;
  if e.song_id is null or not e.enabled or e.public_origin is distinct from p_public_origin or e.sender is distinct from p_sender
    then return jsonb_build_object('result','pending_setup'); end if;
  if l.song_id is null or l.delivery_version<>n.delivery_version or not l.page_issued or l.revoked_at is not null
    or l.consumed_at is not null or l.restore_status<>'idle' or s.storage_status<>'stored' or l.expires_at<=clock_timestamp() then
    update public.song_notification_outbox set status='skipped',error_code='no_longer_available',completed_at=clock_timestamp() where id=p_id;
    update public.song_result_links set notification_status='skipped' where song_id=song and delivery_version=n.delivery_version;
    return jsonb_build_object('result','skipped');
  end if;
  operation:=gen_random_uuid();
  update public.song_notification_outbox set status='sending',operation_id=operation,recipient=e.recipient,sender=e.sender,started_at=clock_timestamp() where id=p_id;
  update public.song_result_links set notification_status='sending' where song_id=song and delivery_version=n.delivery_version;
  return jsonb_build_object('result','started','operation_id',operation,'song_id',song,'recipient',e.recipient,
    'sender',e.sender,'public_origin',e.public_origin,'sealed_token',e.sealed_token,'token_hash',l.token_hash,
    'expires_at',l.expires_at,'event',n.event,'delivery_version',n.delivery_version);
end $$;

create function public.finish_result_notification(p_id uuid, p_operation_id uuid, p_status text, p_message_id text, p_error_code text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare song uuid; v integer;
begin
  if p_status is null or p_status not in ('sent','failed','unknown')
    or (p_status='sent' and (p_message_id is null or p_message_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_error_code is not null))
    or (p_status<>'sent' and (p_message_id is not null or p_error_code is null or p_error_code not in ('invalid_mail','mail_auth_failed','mail_rejected','mail_result_unknown')))
    then return false; end if;
  select song_id,delivery_version into song,v from public.song_notification_outbox where id=p_id;
  if not found then return false; end if;
  perform 1 from public.songs where id=song for update;
  perform 1 from public.song_result_links where song_id=song for update;
  update public.song_notification_outbox set status=p_status,provider_message_id=p_message_id,error_code=p_error_code,completed_at=clock_timestamp()
    where id=p_id and operation_id=p_operation_id and status='sending';
  if not found then return false; end if;
  update public.song_result_links set notification_status=p_status where song_id=song and delivery_version=v;
  return true;
end $$;

revoke all on function public.configure_song_email(uuid,text,text,text,text,text),public.list_result_notification_candidates(integer),
  public.begin_result_notification(uuid,text,text),public.finish_result_notification(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.configure_song_email(uuid,text,text,text,text,text),public.list_result_notification_candidates(integer),
  public.begin_result_notification(uuid,text,text),public.finish_result_notification(uuid,uuid,text,text,text) to service_role;
create or replace function public.read_admin_dashboard()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'observedAt', statement_timestamp(),
    'registeredRequests', (select count(*) from public.songs),
    'generated', (select count(*) from public.songs where generation_status = 'generated'),
    'stored', (select count(*) from public.songs where storage_status = 'stored'),
    'storageFailed', (select count(*) from public.songs where storage_status = 'failed'),
    'restoring', (select count(*) from public.song_result_links where restore_status = 'restoring'),
    'restoreFailed', (select count(*) from public.song_result_links where restore_status = 'failed'),
    'reissueRequests', (select count(*) from public.song_restore_requests),
    'pendingNotifications', (select count(*) from public.song_notification_outbox where status in ('pending_setup', 'pending', 'failed')),
    'notificationsAccepted', (select count(*) from public.song_notification_outbox where status='sent'),
    'notificationsUncertain', (select count(*) from public.song_notification_outbox where status in ('sending','unknown')),
    'manualPrepared', (select count(*) from public.admin_delivery_exports where status = 'prepared'),
    'manualEmailAccepted', (select count(*) from public.admin_delivery_exports where status = 'sent'),
    'manualEmailUncertain', (select count(*) from public.admin_delivery_exports where status in ('sending','unknown')),
    'databaseBytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'storageBytes', (select coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end), 0) from storage.objects),
    'audioBytes', (select coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end), 0) from storage.objects where bucket_id = 'nosayeon-audio'),
    'unknownStorageSizes', (select count(*) from storage.objects where metadata->>'size' is null or metadata->>'size' !~ '^[0-9]+$')
  );
$$;
commit;
