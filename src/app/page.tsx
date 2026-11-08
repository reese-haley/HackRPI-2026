"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/client";
import AuthForm from "@/components/AuthForm";
import type { League } from "@/lib/types";

function MyLeagues() {
  const [leagues, setLeagues] = useState<League[] | null>(null);

  useEffect(() => {
    supabase
      .from("leagues")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => setLeagues((data as League[]) ?? []));
  }, []);

  return (
    <>
      <div className="tools" style={{ marginTop: 0 }}>
        <h1 style={{ margin: 0 }}>Your leagues</h1>
        <Link href="/new" className="btn">
          New league
        </Link>
      </div>

      {leagues === null && <p className="muted">Loading...</p>}
      {leagues?.length === 0 && <p className="muted">No leagues yet. Create one or open an invite link.</p>}
      {leagues?.map((l) => (
        <Link key={l.id} href={`/leagues/${l.id}`} className="card">
          <strong>{l.name}</strong>
          <div className="muted">
            {l.topic}
            {l.draft_enabled ? " · draft" : ""}
          </div>
        </Link>
      ))}
    </>
  );
}

export default function Home() {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "out" | "in">("loading");

  useEffect(() => {
    function apply(session: Session | null) {
      if (!session) return setState("out");
      // Came here from an invite or deep link before signing in? Continue there.
      const next = new URLSearchParams(window.location.search).get("next");
      if (next && next.startsWith("/") && !next.startsWith("//")) {
        router.replace(next);
        return;
      }
      setState("in");
    }
    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => apply(s));
    return () => sub.subscription.unsubscribe();
  }, [router]);

  // Render nothing until we know, so a signed-in user never sees the sign-in form.
  if (state === "loading") return null;
  if (state === "out") return <AuthForm />;
  return <MyLeagues />;
}
