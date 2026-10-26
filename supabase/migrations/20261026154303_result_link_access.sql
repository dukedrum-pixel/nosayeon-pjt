-- Initial, read-only result access. No restore, consumption or deletion policy.
begin;

create table public.song_result_links (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null unique references public.songs(id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked_at timestamptz,
  check (expires_at > issued_at and expires_at <= issued_at + interval '7 days')
);
alter table public.song_result_links enable row level security;
revoke all on public.song_result_links from public, anon, authenticated;
grant select, insert, update on public.song_result_links to service_role;

create function public.issue_initial_result_link(p_song_id uuid, p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_link public.song_result_links;
begin
  -- Serialize with storage state changes. One initial link per song; neither a
  -- repeat call nor an expired link silently resets the seven-day window.
  perform 1 from public.songs where id = p_song_id and storage_status = 'stored' for update;
  if not found then raise exception 'Song is not stored'; end if;
  insert into public.song_result_links(song_id, token_hash) values (p_song_id, p_token_hash)
    returning * into v_link;
  return jsonb_build_object('id', v_link.id, 'song_id', v_link.song_id,
    'issued_at', v_link.issued_at, 'expires_at', v_link.expires_at);
end $$;
revoke all on function public.issue_initial_result_link(uuid, text) from public, anon, authenticated;
grant execute on function public.issue_initial_result_link(uuid, text) to service_role;

commit;
