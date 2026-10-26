-- Storage-only foundation. No prompts, email addresses, access tokens or link
-- expiry policies are persisted until the corresponding product decisions.
begin;

create table public.songs (
  id uuid primary key default gen_random_uuid(),
  google_interaction_id text not null unique check (length(google_interaction_id) between 1 and 512),
  model text not null default 'lyria-3.5' check (model = 'lyria-3.5'),
  generated_at timestamptz not null,
  generation_status text not null default 'generated' check (generation_status = 'generated'),
  storage_status text not null default 'pending' check (storage_status in ('pending', 'storing', 'stored', 'failed')),
  storage_claim uuid,
  storage_lease_until timestamptz,
  stored_at timestamptz,
  last_error_code text check (last_error_code in ('network_error', 'http_error', 'content_mismatch', 'local_error', 'lease_lost', 'invalid_response')),
  last_http_status integer check (last_http_status between 100 and 599),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((storage_status = 'storing') = (storage_claim is not null and storage_lease_until is not null)),
  check (storage_status = 'storing' or (storage_claim is null and storage_lease_until is null)),
  check (storage_status <> 'stored' or stored_at is not null)
);

create table public.song_files (
  song_id uuid not null references public.songs(id) on delete restrict,
  file_index integer not null check (file_index between 1 and 8),
  mime_type text not null check (mime_type in ('audio/mpeg', 'audio/mp3', 'audio/wav')),
  byte_length integer not null check (byte_length between 1 and 67108864),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bucket_id text not null default 'nosayeon-audio' check (bucket_id = 'nosayeon-audio'),
  storage_path text not null unique,
  primary key (song_id, file_index)
);

create table public.song_events (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.songs(id) on delete restrict,
  stage text not null default 'storage' check (stage = 'storage'),
  event text not null check (event in ('registered', 'storage_started', 'storage_completed', 'storage_failed')),
  error_code text check (error_code in ('network_error', 'http_error', 'content_mismatch', 'local_error', 'lease_lost', 'invalid_response')),
  http_status integer check (http_status between 100 and 599),
  created_at timestamptz not null default now()
);
create index song_events_song_time on public.song_events(song_id, created_at);
create index songs_storage_queue on public.songs(storage_status, storage_lease_until);

alter table public.songs enable row level security;
alter table public.song_files enable row level security;
alter table public.song_events enable row level security;
-- Intentionally no anon/authenticated policies. Only trusted backend code.
revoke all on public.songs, public.song_files, public.song_events from public, anon, authenticated;
grant select, insert, update on public.songs, public.song_files to service_role;
grant select, insert on public.song_events to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('nosayeon-audio', 'nosayeon-audio', false, 67108864, array['audio/mpeg', 'audio/mp3', 'audio/wav'])
on conflict (id) do nothing;
do $$
begin
  if not exists (
    select 1 from storage.buckets where id = 'nosayeon-audio' and public = false
      and file_size_limit = 67108864
      and allowed_mime_types @> array['audio/mpeg', 'audio/mp3', 'audio/wav']
      and allowed_mime_types <@ array['audio/mpeg', 'audio/mp3', 'audio/wav']
  ) then
    raise exception 'nosayeon-audio bucket exists with incompatible settings';
  end if;
end $$;
-- No storage.objects policies are added. Do not expose this bucket publicly.

create function public.register_generated_song(p_interaction_id text, p_generated_at timestamptz, p_files jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_song public.songs;
  v_existing jsonb;
  v_canonical jsonb;
begin
  if p_generated_at is null or jsonb_typeof(p_files) is distinct from 'array' then
    raise exception 'Invalid generated-song manifest';
  end if;
  if jsonb_array_length(p_files) not between 1 and 8 then
    raise exception 'Invalid audio file count';
  end if;
  -- Normalize and validate before persisting anything. Constraints reject bad
  -- MIME, hash, size and repeated indexes; the whole transaction rolls back.
  select jsonb_agg(jsonb_build_object('file_index', (f->>'file_index')::integer,
    'mime_type', f->>'mime_type', 'byte_length', (f->>'byte_length')::integer,
    'sha256', f->>'sha256') order by (f->>'file_index')::integer)
    into v_canonical from jsonb_array_elements(p_files) f;

  insert into public.songs(google_interaction_id, generated_at)
    values (p_interaction_id, p_generated_at)
    on conflict (google_interaction_id) do nothing returning * into v_song;
  if v_song.id is null then
    select * into strict v_song from public.songs where google_interaction_id = p_interaction_id for update;
    select jsonb_agg(jsonb_build_object('file_index', file_index, 'mime_type', mime_type,
      'byte_length', byte_length, 'sha256', sha256) order by file_index)
      into v_existing from public.song_files where song_id = v_song.id;
    if v_existing is distinct from v_canonical or v_song.generated_at <> p_generated_at then
      raise exception 'Interaction baseline conflicts with existing manifest';
    end if;
    return to_jsonb(v_song);
  end if;

  insert into public.song_files(song_id, file_index, mime_type, byte_length, sha256, storage_path)
    select v_song.id, (f->>'file_index')::integer, f->>'mime_type', (f->>'byte_length')::integer, f->>'sha256',
      v_song.id::text || '/original/' || (f->>'file_index') || '-' || (f->>'sha256') ||
      case when f->>'mime_type' = 'audio/wav' then '.wav' else '.mp3' end
    from jsonb_array_elements(v_canonical) f;
  insert into public.song_events(song_id, event) values (v_song.id, 'registered');
  return to_jsonb(v_song);
end $$;

create function public.claim_song_storage(p_song_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_song public.songs;
begin
  update public.songs set storage_status = 'storing', storage_claim = gen_random_uuid(),
    storage_lease_until = now() + interval '10 minutes', updated_at = now(),
    last_error_code = null, last_http_status = null
    where id = p_song_id and (storage_status in ('pending', 'failed')
      or (storage_status = 'storing' and storage_lease_until < now()))
    returning * into v_song;
  if v_song.id is null then return null; end if;
  insert into public.song_events(song_id, event) values (v_song.id, 'storage_started');
  return to_jsonb(v_song);
end $$;

create function public.finish_song_storage(p_song_id uuid, p_claim uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_song public.songs;
begin
  update public.songs set storage_status = 'stored', storage_claim = null, storage_lease_until = null,
    stored_at = now(), updated_at = now(), last_error_code = null, last_http_status = null
    where id = p_song_id and storage_status = 'storing' and storage_claim = p_claim
      and storage_lease_until > now() returning * into v_song;
  if v_song.id is null then raise exception 'Storage lease no longer belongs to this worker'; end if;
  insert into public.song_events(song_id, event) values (v_song.id, 'storage_completed');
  return to_jsonb(v_song);
end $$;

create function public.fail_song_storage(p_song_id uuid, p_claim uuid, p_error_code text, p_http_status integer default null)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  update public.songs set storage_status = 'failed', storage_claim = null, storage_lease_until = null,
    last_error_code = p_error_code, last_http_status = p_http_status, updated_at = now()
    where id = p_song_id and storage_status = 'storing' and storage_claim = p_claim
      and storage_lease_until > now() returning id into v_id;
  if v_id is null then return false; end if;
  insert into public.song_events(song_id, event, error_code, http_status)
    values (v_id, 'storage_failed', p_error_code, p_http_status);
  return true;
end $$;

revoke all on function public.register_generated_song(text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.claim_song_storage(uuid) from public, anon, authenticated;
revoke all on function public.finish_song_storage(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_song_storage(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.register_generated_song(text, timestamptz, jsonb),
  public.claim_song_storage(uuid), public.finish_song_storage(uuid, uuid),
  public.fail_song_storage(uuid, uuid, text, integer) to service_role;

commit;
