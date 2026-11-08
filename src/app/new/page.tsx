"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useUser } from "@/lib/useUser";

export default function NewLeague() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState(false);
  const [draftWindowHours, setDraftWindowHours] = useState(24);
  const [rosterSize, setRosterSize] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/leagues", {
        topic,
        name,
        draft,
        draftWindowHours,
        rosterSize,
      });
      router.push(`/leagues/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (loading || !user) return null;

  return (
    <>
      <h1>New league</h1>
      <p className="muted">Describe any topic: "US politics", "bitcoin", "Premier League", "AI".</p>
      <form onSubmit={create} style={{ marginTop: 20 }}>
        <label htmlFor="topic">Topic</label>
        <input id="topic" required value={topic} onChange={(e) => setTopic(e.target.value)} />
        <label htmlFor="name">League name (optional)</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} />

        <label className="check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Enable draft
        </label>
        {draft && (
          <div className="card">
            <p className="muted small" style={{ marginTop: 0 }}>
              Draft leagues have no predictions. Instead, you draft players (the named people or teams in "who will
              win" events). Each player is followed across several events, and earns points whenever one resolves in
              their favour. New events for your players are added automatically.
            </p>
            <label htmlFor="window">Draft window</label>
            <select id="window" value={draftWindowHours} onChange={(e) => setDraftWindowHours(Number(e.target.value))}>
              <option value={1}>Closes in 1 hour</option>
              <option value={24}>Closes in 1 day</option>
              <option value={72}>Closes in 3 days</option>
              <option value={168}>Closes in 7 days</option>
            </select>
            <label htmlFor="roster">Roster size</label>
            <select
              id="roster"
              style={{ marginBottom: 0 }}
              value={rosterSize}
              onChange={(e) => setRosterSize(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} player{n > 1 ? "s" : ""} each
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <div className="error">{error}</div>}
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button disabled={busy}>{busy ? "Gathering events..." : "Generate league"}</button>
          <Link href="/" className="muted">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
