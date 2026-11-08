"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useUser } from "@/lib/useUser";

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const { user, loading } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ id: string }>("/api/join", { code })
      .then(({ id }) => router.replace(`/leagues/${id}`))
      .catch((e) => setError((e as Error).message));
  }, [user, code, router]);

  if (error) return <div className="error">{error}</div>;
  return <p className="muted">{loading ? "Loading..." : "Joining league..."}</p>;
}
