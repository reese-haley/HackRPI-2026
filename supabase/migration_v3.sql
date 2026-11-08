-- Migration v3: draft players now span multiple events.
-- Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.
-- Works whether you ran migration_v2.sql or not.
--
-- WHAT THIS CHANGES
--   * draft_players / draft_picks are dropped and rebuilt (a player is now a person/team,
--     and the new draft_events table holds the Polymarket events about that player).
--   * Draft leagues created with the old version will have no players afterwards.
--     Non-draft leagues, predictions, members and accounts are NOT touched.

alter table leagues add column if not exists draft_enabled boolean not null default false;
alter table leagues add column if not exists draft_closes_at timestamptz;
alter table leagues add column if not exists roster_size int not null default 3;

drop table if exists draft_picks;
drop table if exists draft_events;
drop table if exists draft_players;

create table draft_players (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  unique (league_id, name)
);

create table draft_events (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  player_id uuid not null references draft_players(id) on delete cascade,
  market_id text not null,               -- Polymarket market id
  question text not null,
  end_date timestamptz,
  price numeric not null,                -- current "Yes" probability, 0..1
  resolved boolean not null default false,
  won boolean,                           -- true when the market resolved Yes
  created_at timestamptz not null default now(),
  unique (league_id, market_id)
);

create table draft_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  player_id uuid not null references draft_players(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (league_id, player_id)          -- a player can only be on one roster
);

alter table draft_players enable row level security;
alter table draft_events enable row level security;
alter table draft_picks enable row level security;

create policy "players readable by members" on draft_players
  for select to authenticated using (is_member(league_id));
create policy "draft events readable by members" on draft_events
  for select to authenticated using (is_member(league_id));
create policy "draft picks readable by members" on draft_picks
  for select to authenticated using (is_member(league_id));

-- OPTIONAL: remove draft leagues made with the old version (they are empty now).
-- Uncomment and run if you want them gone:
-- delete from leagues where draft_enabled = true and id not in (select league_id from draft_players);
