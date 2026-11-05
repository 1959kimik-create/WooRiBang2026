-- WooRiBang Supabase schema
-- Run this once in Supabase Dashboard > SQL Editor as the project owner.

create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

create table if not exists public.rooms (
  id text primary key check (id in ('A', 'B', 'C')),
  display_name text not null,
  enabled boolean not null default true
);

insert into public.rooms (id, display_name)
values ('A', 'A 토론방'), ('B', 'B 토론방'), ('C', 'C 토론방')
on conflict (id) do update set display_name = excluded.display_name;

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms (id),
  owner_id uuid not null references auth.users (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  extended boolean not null default false,
  status text not null default 'reserved'
    check (status in ('reserved', 'in_progress', 'finished', 'cancelled')),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.reservation_secrets (
  reservation_id uuid primary key references public.reservations (id) on delete cascade,
  password_hash text not null
);

alter table public.reservations
  drop constraint if exists reservations_no_overlapping_active_room_bookings;
alter table public.reservations
  add constraint reservations_no_overlapping_active_room_bookings
  exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
  where (status in ('reserved', 'in_progress'));

create table if not exists public.room_participants (
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 40),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (reservation_id, user_id)
);

create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  sender_name text not null,
  body text not null check (length(body) between 1 and 2000),
  input_type text not null default 'text' check (input_type in ('text', 'voice')),
  created_at timestamptz not null default now()
);

create index if not exists room_messages_reservation_created_idx
  on public.room_messages (reservation_id, created_at);

create table if not exists public.shared_files (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  uploader_id uuid not null references auth.users (id) on delete cascade,
  original_name text not null,
  storage_path text,
  external_url text,
  created_at timestamptz not null default now(),
  check ((storage_path is not null) <> (external_url is not null))
);

create or replace function public.is_active_room_participant(p_reservation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_participants p
    where p.reservation_id = p_reservation_id
      and p.user_id = auth.uid()
      and p.left_at is null
  );
$$;

create or replace function public.room_schedule(p_from timestamptz, p_until timestamptz)
returns table (room_id text, starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.room_id, r.starts_at, r.ends_at
  from public.reservations r
  where r.status in ('reserved', 'in_progress')
    and r.ends_at > now()
    and r.starts_at < p_until
    and r.ends_at > p_from
  order by r.starts_at;
$$;

create or replace function public.reserve_room(
  p_room_id text,
  p_starts_at timestamptz,
  p_password text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation_id uuid;
  v_ends_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if p_room_id not in ('A', 'B', 'C') then
    raise exception 'INVALID_ROOM' using errcode = '22023';
  end if;

  if p_starts_at is null
    or p_starts_at <= now()
    or extract(second from p_starts_at) <> 0
    or extract(minute from p_starts_at)::integer not in (0, 30) then
    raise exception 'INVALID_START_TIME' using errcode = '22023';
  end if;

  if p_password is null or length(p_password) < 4 or length(p_password) > 64 then
    raise exception 'INVALID_PASSWORD' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.rooms room
    where room.id = p_room_id and room.enabled
  ) then
    raise exception 'ROOM_UNAVAILABLE' using errcode = '22023';
  end if;

  v_ends_at := p_starts_at + interval '2 hours';
  insert into public.reservations (room_id, owner_id, starts_at, ends_at)
  values (
    p_room_id,
    auth.uid(),
    p_starts_at,
    v_ends_at
  )
  returning id into v_reservation_id;

  insert into public.reservation_secrets (reservation_id, password_hash)
  values (v_reservation_id, extensions.crypt(p_password, extensions.gen_salt('bf')));

  return v_reservation_id;
exception
  when exclusion_violation then
    raise exception 'TIME_SLOT_TAKEN' using errcode = '23P01';
end;
$$;

create or replace function public.join_room(
  p_reservation_id uuid,
  p_password text,
  p_display_name text
)
returns table (reservation_id uuid, room_id text, ends_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
  v_display_name text;
  v_password_hash text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  v_display_name := btrim(p_display_name);
  if v_display_name is null or length(v_display_name) < 1 or length(v_display_name) > 40 then
    raise exception 'INVALID_DISPLAY_NAME' using errcode = '22023';
  end if;

  select r.* into v_reservation
  from public.reservations r
  where r.id = p_reservation_id
  for update;

  if not found
    or v_reservation.status not in ('reserved', 'in_progress')
    or now() < v_reservation.starts_at
    or now() >= v_reservation.ends_at then
    raise exception 'RESERVATION_NOT_OPEN' using errcode = '22023';
  end if;

  select s.password_hash into v_password_hash
  from public.reservation_secrets s
  where s.reservation_id = p_reservation_id;

  if p_password is null
    or v_password_hash is null
    or extensions.crypt(p_password, v_password_hash) <> v_password_hash then
    raise exception 'INVALID_PASSWORD' using errcode = '28000';
  end if;

  insert into public.room_participants (reservation_id, user_id, display_name, left_at)
  values (p_reservation_id, auth.uid(), v_display_name, null)
  on conflict (reservation_id, user_id) do update
    set display_name = excluded.display_name,
        joined_at = now(),
        left_at = null;

  update public.reservations
  set status = 'in_progress'
  where id = p_reservation_id and status = 'reserved';

  return query
  select v_reservation.id, v_reservation.room_id, v_reservation.ends_at;
end;
$$;

create or replace function public.send_room_message(
  p_reservation_id uuid,
  p_body text,
  p_input_type text default 'text'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message_id uuid;
  v_display_name text;
  v_body text := btrim(p_body);
begin
  select p.display_name into v_display_name
  from public.room_participants p
  where p.reservation_id = p_reservation_id
    and p.user_id = auth.uid()
    and p.left_at is null;

  if v_display_name is null then
    raise exception 'NOT_AN_ACTIVE_PARTICIPANT' using errcode = '42501';
  end if;

  if v_body is null or length(v_body) < 1 or length(v_body) > 2000 then
    raise exception 'INVALID_MESSAGE' using errcode = '22023';
  end if;

  if p_input_type not in ('text', 'voice') then
    raise exception 'INVALID_INPUT_TYPE' using errcode = '22023';
  end if;

  insert into public.room_messages (reservation_id, sender_id, sender_name, body, input_type)
  values (p_reservation_id, auth.uid(), v_display_name, v_body, p_input_type)
  returning id into v_message_id;

  return v_message_id;
end;
$$;

create or replace function public.extend_room(p_reservation_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
  v_new_end timestamptz;
begin
  select r.* into v_reservation
  from public.reservations r
  where r.id = p_reservation_id
  for update;

  if not found or not public.is_active_room_participant(p_reservation_id) then
    raise exception 'NOT_AN_ACTIVE_PARTICIPANT' using errcode = '42501';
  end if;
  if v_reservation.status <> 'in_progress' or v_reservation.extended then
    raise exception 'EXTENSION_UNAVAILABLE' using errcode = '22023';
  end if;

  v_new_end := v_reservation.ends_at + interval '10 minutes';
  if exists (
    select 1 from public.reservations other
    where other.room_id = v_reservation.room_id
      and other.id <> p_reservation_id
      and other.status in ('reserved', 'in_progress')
      and other.starts_at < v_new_end
      and other.ends_at > v_reservation.ends_at
  ) then
    raise exception 'EXTENSION_CONFLICT' using errcode = '23P01';
  end if;

  update public.reservations
  set ends_at = v_new_end, extended = true
  where id = p_reservation_id;
  return v_new_end;
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
    delete from public.reservations where id = p_reservation_id;
    return true;
  end if;
  return false;
end;
$$;

alter table public.rooms enable row level security;
alter table public.reservations enable row level security;
alter table public.reservation_secrets enable row level security;
alter table public.room_participants enable row level security;
alter table public.room_messages enable row level security;
alter table public.shared_files enable row level security;

drop policy if exists "participants can read their room reservations" on public.reservations;
create policy "participants can read their room reservations"
  on public.reservations for select to authenticated
  using (owner_id = auth.uid() or public.is_active_room_participant(id));

drop policy if exists "participants can read active room participants" on public.room_participants;
create policy "participants can read active room participants"
  on public.room_participants for select to authenticated
  using (public.is_active_room_participant(reservation_id));

drop policy if exists "participants can read room messages" on public.room_messages;
create policy "participants can read room messages"
  on public.room_messages for select to authenticated
  using (public.is_active_room_participant(reservation_id));

drop policy if exists "participants can read shared file metadata" on public.shared_files;
create policy "participants can read shared file metadata"
  on public.shared_files for select to authenticated
  using (public.is_active_room_participant(reservation_id));

drop policy if exists "participants can delete shared file metadata" on public.shared_files;
create policy "participants can delete shared file metadata"
  on public.shared_files for delete to authenticated
  using (public.is_active_room_participant(reservation_id));

grant select on public.rooms to anon, authenticated;
grant select on public.reservations to authenticated;
revoke all on public.reservation_secrets from anon, authenticated;
grant select on public.room_participants to authenticated;
grant select on public.room_messages to authenticated;
grant select on public.shared_files to authenticated;
grant delete on public.shared_files to authenticated;

revoke all on function public.room_schedule(timestamptz, timestamptz) from public;
grant execute on function public.room_schedule(timestamptz, timestamptz) to anon, authenticated;
revoke all on function public.reserve_room(text, timestamptz, text) from public;
grant execute on function public.reserve_room(text, timestamptz, text) to authenticated;
revoke all on function public.join_room(uuid, text, text) from public;
grant execute on function public.join_room(uuid, text, text) to authenticated;
revoke all on function public.send_room_message(uuid, text, text) from public;
grant execute on function public.send_room_message(uuid, text, text) to authenticated;
revoke all on function public.extend_room(uuid) from public;
grant execute on function public.extend_room(uuid) to authenticated;
revoke all on function public.leave_room(uuid) from public;
grant execute on function public.leave_room(uuid) to authenticated;
revoke all on function public.is_active_room_participant(uuid) from public;
grant execute on function public.is_active_room_participant(uuid) to authenticated;

drop policy if exists "anyone can view enabled rooms" on public.rooms;
create policy "anyone can view enabled rooms"
  on public.rooms for select to anon, authenticated
  using (enabled);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_messages'
  ) then
    alter publication supabase_realtime add table public.room_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_participants'
  ) then
    alter publication supabase_realtime add table public.room_participants;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reservations'
  ) then
    alter publication supabase_realtime add table public.reservations;
  end if;
end;
$$;
