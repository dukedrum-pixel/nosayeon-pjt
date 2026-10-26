begin;

-- No audio, email addresses, access tokens or provider responses in this audit.
-- 'prepared' describes verified export only; it must never be presented as sent.
create table public.admin_delivery_exports (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.songs(id) on delete restrict,
  file_index integer not null check (file_index between 1 and 8),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer not null check (byte_length between 1 and 67108864),
  channel text not null check (channel in ('email', 'kakao')),
  status text not null default 'prepared' check (status in ('prepared','sending','sent','failed','unknown')),
  operation_id uuid unique,
  recipient text check (length(recipient) between 3 and 254),
  sender text check (length(sender) between 3 and 254),
  provider_message_id text check (provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  error_code text check (error_code in ('invalid_mail','mail_auth_failed','mail_rejected','mail_result_unknown')),
  check ((status = 'prepared' and operation_id is null and recipient is null and sender is null)
    or (status <> 'prepared' and operation_id is not null and recipient is not null and sender is not null and channel = 'email')),
  created_at timestamptz not null default now()
);
create index admin_delivery_exports_song_time on public.admin_delivery_exports(song_id, created_at desc);
alter table public.admin_delivery_exports enable row level security;
revoke all on public.admin_delivery_exports from public, anon, authenticated;
grant select, insert, update on public.admin_delivery_exports to service_role;

create function public.read_admin_dashboard()
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
    'manualPrepared', (select count(*) from public.admin_delivery_exports where status = 'prepared'),
    'manualEmailAccepted', (select count(*) from public.admin_delivery_exports where status = 'sent'),
    'manualEmailUncertain', (select count(*) from public.admin_delivery_exports where status in ('sending','unknown')),
    'databaseBytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'storageBytes', (select coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end), 0) from storage.objects),
    'audioBytes', (select coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end), 0) from storage.objects where bucket_id = 'nosayeon-audio'),
    'unknownStorageSizes', (select count(*) from storage.objects where metadata->>'size' is null or metadata->>'size' !~ '^[0-9]+$')
  );
$$;

create function public.prepare_admin_delivery(p_song_id uuid, p_file_index integer, p_sha256 text, p_byte_length integer, p_channel text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_generated timestamptz; v_id uuid;
begin
  select generated_at into v_generated from public.songs where id = p_song_id for share;
  if not found then return jsonb_build_object('result', 'invalid_song'); end if;
  if v_generated > clock_timestamp() or v_generated + interval '50 days' <= clock_timestamp() then
    return jsonb_build_object('result', 'retention_ended');
  end if;
  if p_channel is null or p_channel not in ('email', 'kakao') or not exists (
    select 1 from public.song_files where song_id = p_song_id and file_index = p_file_index
      and sha256 = p_sha256 and byte_length = p_byte_length and mime_type in ('audio/mpeg','audio/mp3')
  ) then return jsonb_build_object('result', 'content_mismatch'); end if;
  insert into public.admin_delivery_exports(song_id,file_index,sha256,byte_length,channel)
    values(p_song_id,p_file_index,p_sha256,p_byte_length,p_channel) returning id into v_id;
  return jsonb_build_object('result', 'prepared', 'id', v_id);
end $$;

revoke all on function public.read_admin_dashboard() from public, anon, authenticated;
revoke all on function public.prepare_admin_delivery(uuid,integer,text,integer,text) from public, anon, authenticated;
grant execute on function public.read_admin_dashboard() to service_role;
grant execute on function public.prepare_admin_delivery(uuid,integer,text,integer,text) to service_role;

create function public.begin_admin_email(p_song_id uuid, p_file_index integer, p_sha256 text, p_byte_length integer, p_recipient text, p_sender text, p_operation_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_generated timestamptz; v_job public.admin_delivery_exports; v_inserted boolean;
begin
  if p_operation_id is null or p_recipient is null or p_sender is null
    or length(p_recipient) not between 3 and 254 or length(p_sender) not between 3 and 254
    or p_recipient ~ '[[:space:]]' or p_sender ~ '[[:space:]]' or p_byte_length > 18874368 then
    return jsonb_build_object('result', 'invalid_request');
  end if;
  select generated_at into v_generated from public.songs where id = p_song_id for share;
  if not found then return jsonb_build_object('result', 'invalid_song'); end if;
  if v_generated > clock_timestamp() or v_generated + interval '50 days' <= clock_timestamp() then
    return jsonb_build_object('result', 'retention_ended');
  end if;
  if not exists (select 1 from public.song_files where song_id = p_song_id and file_index = p_file_index
    and sha256 = p_sha256 and byte_length = p_byte_length and mime_type in ('audio/mpeg','audio/mp3')) then
    return jsonb_build_object('result', 'content_mismatch');
  end if;
  insert into public.admin_delivery_exports(song_id,file_index,sha256,byte_length,channel,status,operation_id,recipient,sender)
    values(p_song_id,p_file_index,p_sha256,p_byte_length,'email','sending',p_operation_id,p_recipient,p_sender)
    on conflict (operation_id) do nothing returning * into v_job;
  v_inserted := found;
  if not v_inserted then
    select * into strict v_job from public.admin_delivery_exports where operation_id = p_operation_id;
    if v_job.song_id <> p_song_id or v_job.file_index <> p_file_index or v_job.sha256 <> p_sha256
      or v_job.byte_length <> p_byte_length or v_job.recipient <> p_recipient or v_job.sender <> p_sender then
      return jsonb_build_object('result','conflict');
    end if;
    return jsonb_build_object('result','existing','id',v_job.id,'status',v_job.status);
  end if;
  return jsonb_build_object('result','started','id',v_job.id);
end $$;

create function public.finish_admin_email(p_id uuid, p_status text, p_message_id text, p_error_code text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status is null or p_status not in ('sent','failed','unknown')
    or (p_status = 'sent' and (p_message_id is null or p_error_code is not null))
    or (p_status <> 'sent' and (p_message_id is not null or p_error_code is null)) then return false; end if;
  update public.admin_delivery_exports set status = p_status, provider_message_id = p_message_id, error_code = p_error_code
    where id = p_id and status = 'sending';
  return found;
end $$;
revoke all on function public.begin_admin_email(uuid,integer,text,integer,text,text,uuid) from public, anon, authenticated;
revoke all on function public.finish_admin_email(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.begin_admin_email(uuid,integer,text,integer,text,text,uuid) to service_role;
grant execute on function public.finish_admin_email(uuid,text,text,text) to service_role;
commit;
