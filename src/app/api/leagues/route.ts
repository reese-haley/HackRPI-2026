import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { admin, requireUser } from "@/lib/server";
import { buildMarketPool, buildPlayerPool } from "@/lib/polymarket";

const WINDOW_HOURS = [1, 24, 72, 168];

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await req.json()) as {
    name?: string;
    topic?: string;
    draft?: boolean;
    draftWindowHours?: number;
    rosterSize?: number;
  };
  const cleanTopic = (body.topic ?? "").trim();
  const cleanName = (body.name ?? "").trim() || `${cleanTopic} league`;
  const wantDraft = Boolean(body.draft);
  if (!cleanTopic) return NextResponse.json({ error: "Enter a topic" }, { status: 400 });

  // Build the pool first so a failed search never leaves an empty league behind.
  let markets: Awaited<ReturnType<typeof buildMarketPool>> = [];
  let players: Awaited<ReturnType<typeof buildPlayerPool>> = [];
  try {
    if (wantDraft) players = await buildPlayerPool(cleanTopic);
    else markets = await buildMarketPool(cleanTopic);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  if (wantDraft && players.length < 4) {
    return NextResponse.json(
      {
        error: `Couldn't find enough named players for "${cleanTopic}". Draft works best with topics that have "who will win" style events (politics, awards, sports). Try a broader topic or turn draft off.`,
      },
      { status: 404 }
    );
  }
  if (!wantDraft && markets.length === 0) {
    return NextResponse.json(
      { error: `No open Polymarket markets found for "${cleanTopic}". Try a broader topic.` },
      { status: 404 }
    );
  }

  const hours = WINDOW_HOURS.includes(Number(body.draftWindowHours)) ? Number(body.draftWindowHours) : 24;
  const draftClosesAt = wantDraft ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
  const rosterSize = Math.min(5, Math.max(1, Math.round(Number(body.rosterSize) || 3)));

  const db = admin();
  const { data: league, error } = await db
    .from("leagues")
    .insert({
      name: cleanName,
      topic: cleanTopic,
      owner_id: user.id,
      invite_code: randomBytes(4).toString("hex"),
      draft_enabled: wantDraft,
      draft_closes_at: draftClosesAt,
      roster_size: rosterSize,
    })
    .select("id")
    .single();
  if (error || !league) {
    return NextResponse.json({ error: error?.message ?? "Could not create league" }, { status: 500 });
  }

  await db.from("league_members").insert({ league_id: league.id, user_id: user.id });

  if (wantDraft) {
    const { data: rows, error: pErr } = await db
      .from("draft_players")
      .insert(players.map((p) => ({ league_id: league.id, name: p.name })))
      .select("id, name");
    if (pErr || !rows) return NextResponse.json({ error: pErr?.message ?? "Could not add players" }, { status: 500 });

    const idByName = new Map<string, string>(rows.map((r: { id: string; name: string }) => [r.name, r.id]));
    const { error: eErr } = await db.from("draft_events").insert(
      players.flatMap((p) =>
        p.events.map((e) => ({
          league_id: league.id,
          player_id: idByName.get(p.name),
          market_id: e.marketId,
          question: e.question,
          end_date: e.endDate,
          price: e.price,
        }))
      )
    );
    if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 });
  } else {
    const { error: mErr } = await db.from("league_markets").insert(
      markets.map((m) => ({
        league_id: league.id,
        market_id: m.marketId,
        question: m.question,
        event_title: m.eventTitle,
        end_date: m.endDate,
        outcomes: m.outcomes,
        prices: m.prices,
      }))
    );
    if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
  }

  return NextResponse.json({ id: league.id });
}
