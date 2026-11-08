import { NextResponse } from "next/server";
import { admin, isMember, requireUser } from "@/lib/server";

/**
 * Draft or drop a player. First come, first served: each player can be on one roster only,
 * and each member can hold up to the league's roster size. Only allowed while the window is open.
 */
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { playerId, action } = (await req.json()) as { playerId?: string; action?: "pick" | "drop" };
  if (!playerId || (action !== "pick" && action !== "drop")) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const db = admin();
  const { data: player } = await db.from("draft_players").select("id, league_id").eq("id", playerId).maybeSingle();
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });
  if (!(await isMember(player.league_id, user.id))) return NextResponse.json({ error: "Not a member" }, { status: 403 });

  const { data: league } = await db
    .from("leagues")
    .select("draft_enabled, draft_closes_at, roster_size")
    .eq("id", player.league_id)
    .maybeSingle();
  if (!league?.draft_enabled) return NextResponse.json({ error: "Draft is not enabled for this league" }, { status: 400 });
  if (!league.draft_closes_at || Date.now() >= Date.parse(league.draft_closes_at)) {
    return NextResponse.json({ error: "The draft window has closed" }, { status: 400 });
  }

  if (action === "drop") {
    await db.from("draft_picks").delete().eq("player_id", playerId).eq("user_id", user.id);
    return NextResponse.json({ ok: true });
  }

  const { count } = await db
    .from("draft_picks")
    .select("id", { count: "exact", head: true })
    .eq("league_id", player.league_id)
    .eq("user_id", user.id);
  if ((count ?? 0) >= league.roster_size) {
    return NextResponse.json(
      { error: `Your roster is full (${league.roster_size}). Drop a player first.` },
      { status: 400 }
    );
  }

  const { error } = await db
    .from("draft_picks")
    .insert({ league_id: player.league_id, player_id: playerId, user_id: user.id });
  if (error) {
    const taken = error.code === "23505";
    return NextResponse.json(
      { error: taken ? "Someone else already drafted that player" : error.message },
      { status: taken ? 409 : 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
