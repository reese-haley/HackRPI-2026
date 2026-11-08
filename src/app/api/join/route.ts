import { NextResponse } from "next/server";
import { admin, requireUser } from "@/lib/server";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { code } = (await req.json()) as { code?: string };
  if (!code) return NextResponse.json({ error: "Missing invite code" }, { status: 400 });

  const db = admin();
  const { data: league } = await db.from("leagues").select("id, name").eq("invite_code", code).maybeSingle();
  if (!league) return NextResponse.json({ error: "Invite link is not valid" }, { status: 404 });

  const { error } = await db
    .from("league_members")
    .upsert({ league_id: league.id, user_id: user.id }, { onConflict: "league_id,user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ id: league.id, name: league.name });
}
