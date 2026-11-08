import { createClient, SupabaseClient, User } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** Service-role client. Server only (API routes). Bypasses RLS. */
export function admin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars. See .env.example");
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

/** Resolve the signed-in user from the `Authorization: Bearer <token>` header. */
export async function requireUser(req: Request): Promise<User | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

export async function isMember(leagueId: string, userId: string): Promise<boolean> {
  const { data } = await admin()
    .from("league_members")
    .select("user_id")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}
