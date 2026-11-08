# Polyleague

Auto-generated fantasy leagues from any topic, powered by Polymarket odds.

Type a topic, and the app pulls open markets from the Polymarket Gamma API into a league. Everyone makes predictions (or drafts players), invites friends with a link, and compares scores on a leaderboard.

Stack: Next.js 14 (App Router) + TypeScript, Supabase (auth + Postgres), Polymarket Gamma API. Runs locally.

## Setup

1. **Supabase**: create a project, then open the SQL editor and run `supabase/schema.sql`.
   - Already set up an earlier version? Run `supabase/migration_v3.sql` instead (see the note at the top of that file: it rebuilds the draft tables, so draft leagues made with the old version are emptied).
2. In Supabase go to Authentication > Providers > Email and turn off "Confirm email" (easiest for local dev).
3. Copy the env file and fill it in from Project Settings > API:
   ```
   cp .env.example .env.local
   ```
4. Install and run:
   ```
   npm install
   npm run dev
   ```
5. Open http://localhost:3000, create two accounts (second browser or a private window), create a league, and open its invite link in the other window.

## How it works

**Home** shows only your leagues, with a button to the **New league** page. Signed-in users never see the sign-in form. The home icon (top left) always goes back to your leagues.

**Event selection (both modes)**
- Only markets with at least `MIN_MARKET_VOLUME` USD traded are used (default 10,000; set it in `.env.local`).
- Prediction events are ranked by how even the odds are (50/50 first, 95/5 last) and near-certain ones are dropped.

**Non-draft leagues**
- Pick an outcome; a correct pick earns `100 - (chance % when you picked)`. Everyone can see everyone's picks.
- Resolved events move to **History** (with your pick and points). Each time one resolves, a new balanced event is added to keep about 12 open. Events that haven't resolved always stay.

**Draft leagues** (no separate predictions)
- Players are the real names inside "who will win" style events. Placeholders like "Person A", "Other" or brackets like "↑ 100,000" are ignored, and only events whose options are mutually exclusive (probabilities add up to about 100%) are used.
- Each player is followed across several events: their own option plus other open events whose question is about them ("Will <player> ..."). About 3 open events per player are kept, and new ones are added automatically as others resolve.
- Every event a player resolves Yes on is worth 100 pts to whoever drafted them. First come, first served, one owner per player, roster size set at creation. Open events show their current chance; **History** shows resolved events and who got the points.

**Windows and results**: each event shows when it closes; the draft has its own close time. The Schedule block summarises them. The league page checks Polymarket on load and every minute (throttled server-side) and scores resolved events automatically; "Check now" forces a check.

**Status dots**: green = open, orange = closing soon, blue = closed and awaiting the result, grey = resolved.

## Code map

- `src/lib/polymarket.ts`: search, volume filter, odds-balance ranking, player-name filtering, exclusivity check, per-player event lookup, resolution detection.
- `src/lib/scoring.ts`: prediction and draft scoring.
- `src/app/api/leagues` (create), `.../[id]/sync` (refresh, score, rotate new events), `api/predictions`, `api/draft`, `api/join`.
- Row Level Security lets members read their league's data; all writes go through the API routes using the service role key (server-only).

## Notes

- Draft needs topics with "who will win" style events (politics, awards, sports). Otherwise creation explains why and you can turn draft off.
- "Performing well" in a draft means the player's events resolve Yes. Questions where Yes is bad news for a player are treated the same way, so topic choice matters a little.
- Never commit `.env.local`.
