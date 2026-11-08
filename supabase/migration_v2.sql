-- Migration v2: draft mode. Safe to run once on an existing database (idempotent).
-- Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- No existing data is changed; existing leagues keep working with draft turned off.

alter table leagues add column if not exists draft_enabled boolean not null default false;
alter table leagues add column if not exists draft_closes_at timestamptz;
alter table leagues add column if not exists roster_size int not null default 3;

create table if not exists draft_players (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  market_id text not null,
  name text not null,
  event_title text,
  end_date timestamptz,
  price numeric not null,            -- current "Yes" probability, 0..1
  resolved boolean not null default false,
  won boolean,
  unique (league_id, market_id)
);

create table if not exists draft_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  player_id uuid not null references draft_players(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (league_id, player_id)      -- a player can only be on one roster
);

alter table draft_players enable row level security;
alter table draft_picks enable row level security;

drop policy if exists "players readable by members" on draft_players;
create policy "players readable by members" on draft_players
  for select to authenticated using (is_member(league_id));

drop policy if exists "draft picks readable by members" on draft_picks;
create policy "draft picks readable by members" on draft_picks
  for select to authenticated using (is_member(league_id));
