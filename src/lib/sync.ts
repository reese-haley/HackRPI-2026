import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_EVENTS_PER_PLAYER,
  buildMarketPool,
  findPlayerEvents,
  getEvent,
  getMarket,
  normalizedYes,
  winningOutcome,
  yesIndex,
} from "./polymarket";
import { pointsForPrice } from "./scoring";

/** Non-draft leagues keep roughly this many open events; new ones are added as others resolve. */
const TARGET_OPEN_MARKETS = 10;
/** Draft leagues: top a player up with new events when they have fewer than MIN, never above MAX. */
const MIN_ACTIVE_EVENTS = 3;
const TOPUP_COOLDOWN_MS = 5 * 60_000;

const lastTopUp = new Map<string, number>(); // per league, in memory

type LeagueRow = { id: string; topic: string; draft_enabled: boolean };
// Rows come back from Supabase untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function syncLeague(db: SupabaseClient, league: LeagueRow) {
  return league.draft_enabled ? syncDraft(db, league.id) : syncPredictions(db, league);
}

/* ------------------------------------------------------------ prediction leagues */

async function syncMarket(db: SupabaseClient, lm: { id: string; market_id: string }): Promise<number> {
  const live = await getMarket(lm.market_id);
  if (!live) return 0;
  await db.from("league_markets").update({ prices: live.prices }).eq("id", lm.id);

  const winner = winningOutcome(live);
  if (!winner) return 0;

  await db
    .from("league_markets")
    .update({ resolved: true, winning_outcome: winner, resolved_at: new Date().toISOString() })
    .eq("id", lm.id);

  const { data: preds } = await db
    .from("predictions")
    .select("id, pick, price_at_pick")
    .eq("league_market_id", lm.id);
  await Promise.all(
    (preds ?? []).map((p: Row) =>
      db
        .from("predictions")
        .update({ points: p.pick === winner ? pointsForPrice(Number(p.price_at_pick)) : 0 })
        .eq("id", p.id)
    )
  );
  return 1;
}

async function syncPredictions(db: SupabaseClient, league: LeagueRow) {
  const { data: open } = await db
    .from("league_markets")
    .select("id, market_id")
    .eq("league_id", league.id)
    .eq("resolved", false);

  const results = await Promise.all((open ?? []).map((lm: Row) => syncMarket(db, lm)));

  // Rotation: unresolved events are never removed. When the number of OPEN events drops
  // (because some resolved or closed), add fresh ones for the topic.
  let added = 0;
  const { data: all } = await db.from("league_markets").select("market_id, resolved, end_date").eq("league_id", league.id);
  const now = Date.now();
  const openCount = (all ?? []).filter(
    (m: Row) => !m.resolved && (!m.end_date || Date.parse(m.end_date) > now)
  ).length;

  if (openCount < TARGET_OPEN_MARKETS && now - (lastTopUp.get(league.id) ?? 0) > TOPUP_COOLDOWN_MS) {
    lastTopUp.set(league.id, now);
    try {
      const fresh = await buildMarketPool(
        league.topic,
        new Set<string>((all ?? []).map((m: Row) => m.market_id as string)),
        TARGET_OPEN_MARKETS - openCount
      );
      if (fresh.length) {
        const { error } = await db.from("league_markets").insert(
          fresh.map((m) => ({
            league_id: league.id,
            market_id: m.marketId,
            question: m.question,
            event_title: m.eventTitle,
            end_date: m.endDate,
            outcomes: m.outcomes,
            prices: m.prices,
          }))
        );
        if (!error) added = fresh.length;
      }
    } catch {
      /* try again after the cooldown */
    }
  }

  return { checked: open?.length ?? 0, resolved: results.reduce((a, b) => a + b, 0), added };
}

/* ------------------------------------------------------------ draft leagues */

type EntRow = { id: string; market_id: string; event_id: string | null };

async function syncDraft(db: SupabaseClient, leagueId: string) {
  const { data: ents } = await db
    .from("draft_player_events")
    .select("id, market_id, event_id")
    .eq("league_id", leagueId)
    .eq("resolved", false);
  const rows = (ents ?? []) as EntRow[];

  // One request per Polymarket event (not per candidate) so odds can be re-normalised.
  const groups = new Map<string, EntRow[]>();
  for (const r of rows) {
    const k = r.event_id ?? `m:${r.market_id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const results = await Promise.all(
    Array.from(groups.entries()).map(async ([k, list]) => {
      const ev = k.startsWith("m:") ? null : await getEvent(k);
      let resolved = 0;
      for (const r of list) {
        const mk = ev ? ev.markets.find((m) => m.marketId === r.market_id) ?? null : await getMarket(r.market_id);
        if (!mk) continue;
        const raw = mk.prices[yesIndex(mk.outcomes)];
        const winner = winningOutcome(mk);
        if (winner) {
          await db
            .from("draft_player_events")
            .update({
              price: raw,
              resolved: true,
              won: winner.toLowerCase() === "yes",
              resolved_at: new Date().toISOString(),
            })
            .eq("id", r.id);
          resolved++;
        } else {
          const price = ev && !mk.closed ? normalizedYes(ev, mk) : raw;
          await db.from("draft_player_events").update({ price }).eq("id", r.id);
        }
      }
      return resolved;
    })
  );

  // Keep feeding players new events so users follow one player across many events.
  let added = 0;
  const now = Date.now();
  if (now - (lastTopUp.get(leagueId) ?? 0) > TOPUP_COOLDOWN_MS) {
    const [{ data: players }, { data: all }] = await Promise.all([
      db.from("draft_players").select("id, name, key").eq("league_id", leagueId),
      db.from("draft_player_events").select("player_id, market_id, resolved").eq("league_id", leagueId),
    ]);
    const known = new Set<string>((all ?? []).map((e: Row) => e.market_id as string));
    const active = new Map<string, number>();
    for (const e of all ?? []) {
      if (!e.resolved) active.set(e.player_id, (active.get(e.player_id) ?? 0) + 1);
    }
    const needy = (players ?? [])
      .filter((p: Row) => (active.get(p.id) ?? 0) < MIN_ACTIVE_EVENTS)
      .sort((a: Row, b: Row) => (active.get(a.id) ?? 0) - (active.get(b.id) ?? 0))
      .slice(0, 8);

    if (needy.length) {
      lastTopUp.set(leagueId, now);
      await Promise.all(
        needy.map(async (p: Row) => {
          try {
            const found = await findPlayerEvents(p.name, p.key, known, now);
            const room = MAX_EVENTS_PER_PLAYER - (active.get(p.id) ?? 0);
            const add = found.filter((c) => !known.has(c.marketId)).slice(0, Math.max(0, room));
            add.forEach((c) => known.add(c.marketId));
            if (!add.length) return;
            const { error } = await db.from("draft_player_events").insert(
              add.map((c) => ({
                league_id: leagueId,
                player_id: p.id,
                market_id: c.marketId,
                event_id: c.eventId,
                event_title: c.eventTitle,
                end_date: c.endDate,
                price: c.price,
              }))
            );
            if (!error) added += add.length;
          } catch {
            /* best-effort */
          }
        })
      );
    }
  }

  return { checked: rows.length, resolved: results.reduce((a, b) => a + b, 0), added };
}
