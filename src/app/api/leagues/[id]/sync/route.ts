import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, isMember, requireUser } from "@/lib/server";
import {
  EVENTS_PER_PLAYER,
  TARGET_MARKETS,
  buildMarketPool,
  findPlayerEvents,
  getMarket,
  winningOutcome,
  yesIndex,
} from "@/lib/polymarket";
import { pointsForPrice } from "@/lib/scoring";

// Per-league, in-memory guards so many open browsers don't hammer Polymarket.
const lastSync = new Map<string, number>();
const lastTopUp = new Map<string, number>();
const topUpRunning = new Set<string>();
const THROTTLE_MS = 15_000;
const TOPUP_MS = 10 * 60_000;

const isFuture = (d: string | null) => !d || Date.parse(d) > Date.now();

/**
 * Refresh odds and score anything that resolved. Then, when events have resolved (or every
 * few minutes), top the league back up with fresh events. Unresolved events always stay.
 * The league page calls this automatically on load and every minute.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(await isMember(params.id, user.id))) return NextResponse.json({ error: "Not a member" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const now = Date.now();
  if (!body.force && now - (lastSync.get(params.id) ?? 0) < THROTTLE_MS) {
    return NextResponse.json({ skipped: true });
  }
  lastSync.set(params.id, now);

  const db = admin();
  const { data: league } = await db
    .from("leagues")
    .select("topic, draft_enabled")
    .eq("id", params.id)
    .maybeSingle();
  if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });

  const resolved = league.draft_enabled ? await syncDraft(db, params.id) : await syncMarkets(db, params.id);

  const due = resolved > 0 || now - (lastTopUp.get(params.id) ?? 0) > TOPUP_MS;
  if (due && !topUpRunning.has(params.id)) {
    topUpRunning.add(params.id);
    lastTopUp.set(params.id, now);
    const job = league.draft_enabled
      ? topUpPlayers(db, params.id)
      : topUpMarkets(db, params.id, league.topic as string);
    // Runs in the background so the page stays fast; new events show up on the next refresh.
    job.catch(() => undefined).finally(() => topUpRunning.delete(params.id));
  }

  return NextResponse.json({ resolved });
}

async function syncMarkets(db: SupabaseClient, leagueId: string): Promise<number> {
  const { data: markets } = await db
    .from("league_markets")
    .select("id, market_id")
    .eq("league_id", leagueId)
    .eq("resolved", false);

  const results = await Promise.all(
    (markets ?? []).map(async (lm: { id: string; market_id: string }) => {
      const live = await getMarket(lm.market_id);
      if (!live) return 0;
      await db.from("league_markets").update({ prices: live.prices }).eq("id", lm.id);

      const winner = winningOutcome(live);
      if (!winner) return 0;

      await db.from("league_markets").update({ resolved: true, winning_outcome: winner }).eq("id", lm.id);
      const { data: preds } = await db
        .from("predictions")
        .select("id, pick, price_at_pick")
        .eq("league_market_id", lm.id);
      await Promise.all(
        (preds ?? []).map((p: { id: string; pick: string; price_at_pick: number }) =>
          db
            .from("predictions")
            .update({ points: p.pick === winner ? pointsForPrice(Number(p.price_at_pick)) : 0 })
            .eq("id", p.id)
        )
      );
      return 1;
    })
  );
  return results.reduce((a, b) => a + b, 0);
}

async function syncDraft(db: SupabaseClient, leagueId: string): Promise<number> {
  const { data: events } = await db
    .from("draft_events")
    .select("id, market_id")
    .eq("league_id", leagueId)
    .eq("resolved", false);

  const results = await Promise.all(
    (events ?? []).map(async (e: { id: string; market_id: string }) => {
      const live = await getMarket(e.market_id);
      if (!live) return 0;
      const price = live.prices[yesIndex(live.outcomes)];
      const winner = winningOutcome(live);
      if (!winner) {
        await db.from("draft_events").update({ price }).eq("id", e.id);
        return 0;
      }
      await db
        .from("draft_events")
        .update({ price, resolved: true, won: winner.toLowerCase() === "yes" })
        .eq("id", e.id);
      return 1;
    })
  );
  return results.reduce((a, b) => a + b, 0);
}

/** Non-draft: keep about TARGET_MARKETS open events. Resolved ones stay in history. */
async function topUpMarkets(db: SupabaseClient, leagueId: string, topic: string) {
  const { data: all } = await db
    .from("league_markets")
    .select("market_id, resolved, end_date")
    .eq("league_id", leagueId);
  const rows = (all ?? []) as { market_id: string; resolved: boolean; end_date: string | null }[];

  const open = rows.filter((r) => !r.resolved && isFuture(r.end_date)).length;
  const need = TARGET_MARKETS - open;
  if (need <= 0) return;

  const exclude = new Set(rows.map((r) => r.market_id));
  const fresh = await buildMarketPool(topic, need, exclude, true);
  if (!fresh.length) return;

  await db.from("league_markets").insert(
    fresh.map((m) => ({
      league_id: leagueId,
      market_id: m.marketId,
      question: m.question,
      event_title: m.eventTitle,
      end_date: m.endDate,
      outcomes: m.outcomes,
      prices: m.prices,
    }))
  );
}

/** Draft: keep every player attached to about EVENTS_PER_PLAYER open events. */
async function topUpPlayers(db: SupabaseClient, leagueId: string) {
  const [{ data: players }, { data: events }] = await Promise.all([
    db.from("draft_players").select("id, name").eq("league_id", leagueId),
    db.from("draft_events").select("player_id, market_id, resolved, end_date").eq("league_id", leagueId),
  ]);
  const evs = (events ?? []) as { player_id: string; market_id: string; resolved: boolean; end_date: string | null }[];
  const taken = new Set(evs.map((e) => e.market_id));

  for (const p of (players ?? []) as { id: string; name: string }[]) {
    const open = evs.filter((e) => e.player_id === p.id && !e.resolved && isFuture(e.end_date)).length;
    const need = EVENTS_PER_PLAYER - open;
    if (need <= 0) continue;
    try {
      const found = await findPlayerEvents(p.name, taken, need);
      if (!found.length) continue;
      found.forEach((f) => taken.add(f.marketId));
      await db.from("draft_events").insert(
        found.map((f) => ({
          league_id: leagueId,
          player_id: p.id,
          market_id: f.marketId,
          question: f.question,
          end_date: f.endDate,
          price: f.price,
        }))
      );
    } catch {
      /* try this player again next time */
    }
  }
}
