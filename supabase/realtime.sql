-- WooRiBang realtime and shared-file setup
-- Run after schema.sql in Supabase Dashboard > SQL Editor.

create or replace function public.room_bookings(p_room_id text)
returns table (
  reservation_id uuid,
  room_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  extended boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.room_id, r.starts_at, r.ends_at, r.status, r.extended
  from public.reservations r
  where r.room_id = p_room_id
    and r.status in ('reserved', 'in_progress')
    and r.ends_at > now()
  order by r.starts_at;
$$;

create or replace function public.reservation_for_entry(p_reservation_id uuid)
returns table (
  reservation_id uuid,
  room_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  extended boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.room_id, r.starts_at, r.ends_at, r.status, r.extended
  from public.reservations r
  where r.id = p_reservation_id
    and r.status in ('reserved', 'in_progress')
    and r.ends_at > now();
$$;

create or replace function public.register_shared_file(
  p_reservation_id uuid,
  p_original_name text,
  p_storage_path text,
  p_external_url text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_name text := btrim(p_original_name);
begin
  if not public.is_active_room_participant(p_reservation_id) then
    raise exception 'NOT_AN_ACTIVE_PARTICIPANT' using errcode = '42501';
  end if;

  if v_name is null or length(v_name) < 1 or length(v_name) > 255 then
    raise exception 'INVALID_FILE_NAME' using errcode = '22023';
  end if;

  if (p_storage_path is null) = (p_external_url is null) then
    raise exception 'INVALID_SHARED_RESOURCE' using errcode = '22023';
  end if;

  if p_storage_path is not null and
    split_part(p_storage_path, '/', 1) <> p_reservation_id::text then
    raise exception 'INVALID_STORAGE_PATH' using errcode = '22023';
  end if;

  if p_external_url is not null and p_external_url !~ '^https?://' then
    raise exception 'INVALID_EXTERNAL_URL' using errcode = '22023';
  end if;

  insert into public.shared_files (
    reservation_id, uploader_id, original_name, storage_path, external_url
  )
  values (
    p_reservation_id, auth.uid(), v_name, p_storage_path, p_external_url
  )
  returning id into v_id;

  return v_id;
end;
$$;

create table if not exists public.room_cleanup_queue (
  reservation_id uuid primary key,
  storage_paths text[] not null default '{}',
  user_ids uuid[] not null default '{}',
  queued_at timestamptz not null default now()
);
alter table public.room_cleanup_queue enable row level security;
revoke all on public.room_cleanup_queue from anon, authenticated;
grant select, delete on public.room_cleanup_queue to service_role;
grant select on public.reservations, public.room_participants to service_role;

create or replace function public.is_active_room_participant_path(p_reservation_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_reservation_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_active_room_participant(p_reservation_path::uuid);
end;
$$;

create or replace function public.leave_room(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining integer;
  v_storage_paths text[];
  v_user_ids uuid[];
  v_owner_id uuid;
begin
  update public.room_participants
  set left_at = now()
  where reservation_id = p_reservation_id
    and user_id = auth.uid()
    and left_at is null;

  if not found then
    raise exception 'NOT_AN_ACTIVE_PARTICIPANT' using errcode = '42501';
  end if;

  select count(*) into v_remaining
  from public.room_participants p
  where p.reservation_id = p_reservation_id and p.left_at is null;

  if v_remaining = 0 then
    select r.owner_id into v_owner_id
    from public.reservations r
    where r.id = p_reservation_id;

    select coalesce(array_agg(f.storage_path) filter (where f.storage_path is not null), '{}')
      into v_storage_paths
    from public.shared_files f
    where f.reservation_id = p_reservation_id;

    select coalesce(array_agg(distinct user_id), '{}')
      into v_user_ids
    from unnest(array_append(
      coalesce((
        select array_agg(p.user_id)
        from public.room_participants p
        where p.reservation_id = p_reservation_id
      ), '{}'),
      v_owner_id
    )) as participant_ids(user_id);
    insert into public.room_cleanup_queue (reservation_id, storage_paths, user_ids)
    values (p_reservation_id, v_storage_paths, v_user_ids)
    on conflict (reservation_id) do nothing;

    delete from public.reservations where id = p_reservation_id;
    return true;
  end if;
  return false;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('room-shares', 'room-shares', false, 26214400)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "active room participants can read shared files" on storage.objects;
create policy "active room participants can read shared files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'room-shares'
    and public.is_active_room_participant_path((storage.foldername(name))[1])
  );

drop policy if exists "active room participants can upload shared files" on storage.objects;
create policy "active room participants can upload shared files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'room-shares'
    and public.is_active_room_participant_path((storage.foldername(name))[1])
  );

drop policy if exists "active room participants can delete shared files" on storage.objects;
create policy "active room participants can delete shared files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'room-shares'
    and public.is_active_room_participant_path((storage.foldername(name))[1])
  );

revoke all on function public.room_bookings(text) from public;
grant execute on function public.room_bookings(text) to anon, authenticated;
revoke all on function public.reservation_for_entry(uuid) from public;
grant execute on function public.reservation_for_entry(uuid) to anon, authenticated;
revoke all on function public.register_shared_file(uuid, text, text, text) from public;
grant execute on function public.register_shared_file(uuid, text, text, text) to authenticated;
revoke all on function public.leave_room(uuid) from public;
grant execute on function public.leave_room(uuid) to authenticated;
revoke all on function public.is_active_room_participant_path(text) from public;
grant execute on function public.is_active_room_participant_path(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shared_files'
  ) then
    alter publication supabase_realtime add table public.shared_files;
  end if;
end;
$$;
