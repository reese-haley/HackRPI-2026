import { NextResponse } from "next/server";
import { admin, isMember, requireUser } from "@/lib/server";
import { getMarket } from "@/lib/polymarket";

/** Make or change a pick. The price is read live from Polymarket, never trusted from the client. */
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { leagueMarketId, pick } = (await req.json()) as { leagueMarketId?: string; pick?: string };
  if (!leagueMarketId || !pick) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const db = admin();
  const { data: lm } = await db.from("league_markets").select("*").eq("id", leagueMarketId).maybeSingle();
  if (!lm) return NextResponse.json({ error: "Market not found" }, { status: 404 });
  if (!(await isMember(lm.league_id, user.id))) return NextResponse.json({ error: "Not a member" }, { status: 403 });
  if (lm.resolved) return NextResponse.json({ error: "This market has already resolved" }, { status: 400 });
  if (lm.end_date && new Date(lm.end_date).getTime() <= Date.now()) {
    return NextResponse.json({ error: "This market has closed" }, { status: 400 });
  }

  const live = await getMarket(lm.market_id);
  if (!live) return NextResponse.json({ error: "Could not reach Polymarket" }, { status: 502 });
  if (live.closed) return NextResponse.json({ error: "This market has closed" }, { status: 400 });

  const idx = live.outcomes.indexOf(pick);
  if (idx < 0) return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });

  await db.from("league_markets").update({ prices: live.prices }).eq("id", lm.id);

  const { error } = await db.from("predictions").upsert(
    {
      league_id: lm.league_id,
      league_market_id: lm.id,
      user_id: user.id,
      pick,
      price_at_pick: live.prices[idx],
      points: null,
    },
    { onConflict: "league_market_id,user_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, price: live.prices[idx] });
}
