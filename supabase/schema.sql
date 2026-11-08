-- Full schema for a FRESH Supabase project (includes draft mode).
-- Already set up an earlier version? Run supabase/migration_v3.sql instead.

create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null
);

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  topic text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  invite_code text not null unique,
  draft_enabled boolean not null default false,
  draft_closes_at timestamptz,
  roster_size int not null default 3,
  created_at timestamptz not null default now()
);

create table if not exists league_members (
  league_id uuid not null references leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);

-- Prediction events (non-draft leagues)
create table if not exists league_markets (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  market_id text not null,               -- Polymarket market id
  question text not null,
  event_title text,
  end_date timestamptz,
  outcomes jsonb not null,               -- ["Yes","No"]
  prices jsonb not null,                 -- [0.63,0.37]
  resolved boolean not null default false,
  winning_outcome text,
  unique (league_id, market_id)
);

create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  league_market_id uuid not null references league_markets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  pick text not null,
  price_at_pick numeric not null,
  points integer,                        -- null until the market resolves
  created_at timestamptz not null default now(),
  unique (league_market_id, user_id)
);

-- Draft leagues: players (people/teams), the events about them, and who drafted whom
create table if not exists draft_players (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  unique (league_id, name)
);

create table if not exists draft_events (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  player_id uuid not null references draft_players(id) on delete cascade,
  market_id text not null,
  question text not null,
  end_date timestamptz,
  price numeric not null,
  resolved boolean not null default false,
  won boolean,
  created_at timestamptz not null default now(),
  unique (league_id, market_id)
);

create table if not exists draft_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  player_id uuid not null references draft_players(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (league_id, player_id)
);

-- Auto-create a profile when someone signs up.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Membership helper (security definer avoids recursive RLS).
create or replace function is_member(lid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from league_members where league_id = lid and user_id = auth.uid()
  );
$$;

alter table profiles enable row level security;
alter table leagues enable row level security;
alter table league_members enable row level security;
alter table league_markets enable row level security;
alter table predictions enable row level security;
alter table draft_players enable row level security;
alter table draft_events enable row level security;
alter table draft_picks enable row level security;

-- Reads only. All writes go through the Next.js API routes (service role).
drop policy if exists "profiles readable" on profiles;
create policy "profiles readable" on profiles for select to authenticated using (true);

drop policy if exists "leagues readable by members" on leagues;
create policy "leagues readable by members" on leagues for select to authenticated using (is_member(id));

drop policy if exists "members readable by members" on league_members;
create policy "members readable by members" on league_members for select to authenticated using (is_member(league_id));

drop policy if exists "markets readable by members" on league_markets;
create policy "markets readable by members" on league_markets for select to authenticated using (is_member(league_id));

drop policy if exists "predictions readable by members" on predictions;
create policy "predictions readable by members" on predictions for select to authenticated using (is_member(league_id));

drop policy if exists "players readable by members" on draft_players;
create policy "players readable by members" on draft_players for select to authenticated using (is_member(league_id));

drop policy if exists "draft events readable by members" on draft_events;
create policy "draft events readable by members" on draft_events for select to authenticated using (is_member(league_id));

drop policy if exists "draft picks readable by members" on draft_picks;
create policy "draft picks readable by members" on draft_picks for select to authenticated using (is_member(league_id));
