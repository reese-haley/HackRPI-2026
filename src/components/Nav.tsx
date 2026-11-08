"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/client";

export default function Nav() {
  const [name, setName] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    async function load(userId: string | null, fallback?: string) {
      if (!userId) return setName(null);
      const { data } = await supabase.from("profiles").select("username").eq("id", userId).maybeSingle();
      setName(data?.username ?? fallback ?? "you");
    }
    supabase.auth.getSession().then(({ data }) => load(data.session?.user.id ?? null, data.session?.user.email));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => load(s?.user.id ?? null, s?.user.email));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <nav className="nav">
      <Link href="/" className="home" aria-label="Home" title="Home">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10h14V10" />
          <path d="M10 20v-6h4v6" />
        </svg>
      </Link>
      {name && (
        <div className="right">
          <span className="muted">{name}</span>
          <button
            className="link"
            onClick={async () => {
              await supabase.auth.signOut();
              router.push("/");
            }}
          >
            sign out
          </button>
        </div>
      )}
    </nav>
  );
}
