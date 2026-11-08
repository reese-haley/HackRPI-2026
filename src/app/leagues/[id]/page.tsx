"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { api, supabase } from "@/lib/client";
import { useUser } from "@/lib/useUser";
import { pointsForPrice } from "@/lib/scoring";
import { fmtDateTime, inTime, marketStatus, windowStatus } from "@/lib/format";
import type { DraftEvent, DraftPick, DraftPlayer, League, LeagueMarket, Prediction, Profile } from "@/lib/types";

const pct = (n: number) => `${Math.round(Number(n) * 100)}%`;
const byEndDesc = (a: { end_date: string | null }, b: { end_date: string | null }) =>
  (b.end_date ? Date.parse(b.end_date) : 0) - (a.end_date ? Date.parse(a.end_date) : 0);
const byEndAsc = (a: { end_date: string | null }, b: { end_date: string | null }) =>
  (a.end_date ? Date.parse(a.end_date) : Infinity) - (b.end_date ? Date.parse(b.end_date) : Infinity);

// ---- Draft scoring (tune these three numbers) ----
// An event pays UPSET_SCALE * (1 - chance it had when it was added to the league):
// a 50% event pays 100, a 20% longshot pays 160, an 80% favourite pays 40.
const UPSET_SCALE = 200;
// The more events a player is in, the less each extra one is worth (older events never change):
// 1st = 100%, 2nd = 80%, 3rd = 67%, 4th = 57%, ... never below MIN_EXPOSURE.
const EXPOSURE_DECAY = 0.25;
const MIN_EXPOSURE = 0.3;

type EventRow = DraftEvent & { start_price?: number | null; created_at?: string };
type EventScore = { win: number; points: number; projected: number };

/** Points for every draft event, keyed by event id. `win` = what it pays if it resolves Yes. */
function scoreDraftEvents(byPlayer: Map<string, DraftEvent[]>): Map<string, EventScore> {
  const out = new Map<string, EventScore>();
  byPlayer.forEach((list) => {
    const ordered = [...(list as EventRow[])].sort(
      (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id)
    );
    ordered.forEach((e, i) => {
      const raw = e.start_price == null ? 0.5 : Number(e.start_price);
      // Unknown or already-decided snapshots (older events) count as a neutral 50%.
      const start = raw <= 0.02 || raw >= 0.98 ? 0.5 : raw;
      const exposure = Math.max(MIN_EXPOSURE, 1 / (1 + EXPOSURE_DECAY * i));
      const win = Math.round(UPSET_SCALE * (1 - start) * exposure);
      const points = e.resolved && e.won ? win : 0;
      out.set(e.id, { win, points, projected: e.resolved ? points : Math.round(Number(e.price) * win) });
    });
  });
  return out;
}

function Dot({ s }: { s: string }) {
  return <span className={`dot ${s}`} aria-hidden="true" />;
}

export default function LeaguePage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useUser();

  const [league, setLeague] = useState<League | null>(null);
  const [markets, setMarkets] = useState<LeagueMarket[]>([]);
  const [preds, setPreds] = useState<Prediction[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);
  const [players, setPlayers] = useState<DraftPlayer[]>([]);
  const [events, setEvents] = useState<DraftEvent[]>([]);
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const [l, m, p, mem, pl, ev, pk] = await Promise.all([
      supabase.from("leagues").select("*").eq("id", id).maybeSingle(),
      supabase.from("league_markets").select("*").eq("league_id", id),
      supabase.from("predictions").select("*").eq("league_id", id),
      supabase.from("league_members").select("user_id").eq("league_id", id),
      supabase.from("draft_players").select("*").eq("league_id", id),
      supabase.from("draft_events").select("*").eq("league_id", id),
      supabase.from("draft_picks").select("*").eq("league_id", id),
    ]);
    setLeague((l.data as League) ?? null);
    setMarkets((m.data as LeagueMarket[]) ?? []);
    setPreds((p.data as Prediction[]) ?? []);
    setPlayers((pl.data as DraftPlayer[]) ?? []);
    setEvents(((ev.data as DraftEvent[]) ?? []).map((x) => ({ ...x, price: Number(x.price) })));
    setPicks((pk.data as DraftPick[]) ?? []);

    const ids = (mem.data ?? []).map((r: { user_id: string }) => r.user_id);
    if (ids.length) {
      const { data } = await supabase.from("profiles").select("id, username").in("id", ids);
      setMembers((data as Profile[]) ?? []);
    }
  }, [id]);

  // Check Polymarket for new odds/results (and rotate in new events), then refresh what we show.
  const autoSync = useCallback(
    async (force = false) => {
      try {
        await api(`/api/leagues/${id}/sync`, { force });
      } catch {
        /* a failed check shouldn't break the page */
      }
      await load();
      setUpdatedAt(new Date());
    },
    [id, load]
  );

  useEffect(() => {
    if (!user) return;
    load().then(() => autoSync());
    const poll = setInterval(() => autoSync(), 60_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [user, load, autoSync]);

  const nameOf = useCallback(
    (uid: string) => (uid === user?.id ? "you" : members.find((m) => m.id === uid)?.username ?? "?"),
    [members, user]
  );

  const myPreds = useMemo(() => {
    const map = new Map<string, Prediction>();
    preds.filter((p) => p.user_id === user?.id).forEach((p) => map.set(p.league_market_id, p));
    return map;
  }, [preds, user]);

  const predsByMarket = useMemo(() => {
    const map = new Map<string, Prediction[]>();
    preds.forEach((p) => map.set(p.league_market_id, [...(map.get(p.league_market_id) ?? []), p]));
    return map;
  }, [preds]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const ownerByPlayer = useMemo(() => new Map(picks.map((k) => [k.player_id, k.user_id])), [picks]);
  const eventsByPlayer = useMemo(() => {
    const map = new Map<string, DraftEvent[]>();
    events.forEach((e) => map.set(e.player_id, [...(map.get(e.player_id) ?? []), e]));
    return map;
  }, [events]);
  const scored = useMemo(() => scoreDraftEvents(eventsByPlayer), [eventsByPlayer]);
  const myRoster = useMemo(
    () =>
      picks
        .filter((k) => k.user_id === user?.id)
        .map((k) => playerById.get(k.player_id))
        .filter(Boolean) as DraftPlayer[],
    [picks, playerById, user]
  );

  const board = useMemo(
    () =>
      members
        .map((m) => {
          const mine = preds.filter((p) => p.user_id === m.id);
          const predPts = mine.reduce((s, p) => s + (p.points ?? 0), 0);
          const owned = picks.filter((k) => k.user_id === m.id);
          let draftPts = 0;
          let projected = 0;
          owned.forEach((k) =>
            (eventsByPlayer.get(k.player_id) ?? []).forEach((e) => {
              const s = scored.get(e.id);
              if (!s) return;
              draftPts += s.points;
              if (!e.resolved) projected += s.projected;
            })
          );
          return { ...m, picks: mine.length, roster: owned.length, projected, total: predPts + draftPts };
        })
        .sort((a, b) => b.total - a.total || b.picks + b.roster - (a.picks + a.roster)),
    [members, preds, picks, eventsByPlayer, scored]
  );

  async function pick(lm: LeagueMarket, outcome: string) {
    setBusyId(lm.id);
    setError(null);
    try {
      await api("/api/predictions", { leagueMarketId: lm.id, pick: outcome });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusyId(null);
  }

  async function draftAction(p: DraftPlayer, action: "pick" | "drop") {
    setBusyId(p.id);
    setError(null);
    try {
      await api("/api/draft", { playerId: p.id, action });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
    setBusyId(null);
  }

  async function refresh() {
    setSyncing(true);
    setError(null);
    await autoSync(true);
    setSyncing(false);
  }

  if (loading || !user) return null;
  if (!league) return <p className="muted">League not found, or you are not a member.</p>;

  const isDraft = league.draft_enabled;
  const inviteUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin}/join/${league.invite_code}`;

  // Active = not resolved yet (open or waiting on a result). Resolved ones live in History.
  const activeMarkets = markets.filter((m) => !m.resolved).sort(byEndAsc);
  const historyMarkets = markets.filter((m) => m.resolved).sort(byEndDesc);
  const historyEvents = events.filter((e) => e.resolved).sort(byEndDesc);

  // Schedule summary
  const pool: { end_date: string | null; resolved: boolean }[] = isDraft ? events : markets;
  const openItems = pool.filter((m) => ["open", "soon"].includes(marketStatus(m, now)));
  const nextClose =
    openItems
      .map((m) => m.end_date)
      .filter((d): d is string => Boolean(d))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const resolvedCount = pool.filter((m) => m.resolved).length;
  const predDot = openItems.length
    ? nextClose && Date.parse(nextClose) - now < 24 * 3600_000
      ? "soon"
      : "open"
    : pool.length > 0 && resolvedCount === pool.length
    ? "resolved"
    : "awaiting";
  const draftWin = windowStatus(league.draft_closes_at, now);
  const draftOpen = isDraft && draftWin !== "closed";
  const rosterFull = myRoster.length >= league.roster_size;

  // Draft players, strongest chances first
  const playerRows = players
    .map((p) => {
      const evs = eventsByPlayer.get(p.id) ?? [];
      const open = evs.filter((e) => !e.resolved).sort(byEndAsc);
      const earned = evs.reduce((s, e) => s + (scored.get(e.id)?.points ?? 0), 0);
      const strength = open.reduce((s, e) => s + e.price, 0);
      return { p, open, earned, strength };
    })
    .sort((a, b) => b.strength - a.strength || a.p.name.localeCompare(b.p.name));

  // How you did on resolved events
  const myPicksResolved = historyMarkets.filter((m) => myPreds.has(m.id));
  const myRight = myPicksResolved.filter((m) => (myPreds.get(m.id)?.points ?? 0) > 0).length;
  const myPredPts = myPicksResolved.reduce((s, m) => s + (myPreds.get(m.id)?.points ?? 0), 0);
  const myDraftEvents = historyEvents.filter((e) => ownerByPlayer.get(e.player_id) === user.id);
  const myHits = myDraftEvents.filter((e) => e.won).length;
  const myDraftPts = myDraftEvents.reduce((s, e) => s + (scored.get(e.id)?.points ?? 0), 0);

  return (
    <>
      <h1>{league.name}</h1>
      <p className="muted">Topic: {league.topic}</p>

      <h2>Schedule</h2>
      <div className="kv">
        <div className="k">{isDraft ? "Events" : "Predictions"}</div>
        <div>
          <Dot s={predDot} />
          {openItems.length
            ? `Each event closes at its own time. Next: ${fmtDateTime(nextClose)} ${
                inTime(nextClose, now) && `(${inTime(nextClose, now)})`
              }`
            : "No open events right now."}{" "}
          {isDraft
            ? "New events for your players are added as others resolve."
            : "A new event replaces each one that resolves; unresolved events stay."}
        </div>
        {isDraft && (
          <>
            <div className="k">Draft</div>
            <div>
              <Dot s={draftWin} />
              {draftWin === "closed" ? "Closed" : "Closes"} {fmtDateTime(league.draft_closes_at)}{" "}
              {inTime(league.draft_closes_at, now) && `(${inTime(league.draft_closes_at, now)})`}
            </div>
          </>
        )}
        <div className="k">Results</div>
        <div>
          <Dot s={pool.length > 0 && resolvedCount === pool.length ? "resolved" : "awaiting"} />
          Scored automatically when Polymarket resolves each event. {resolvedCount} of {pool.length} resolved so far.
        </div>
      </div>

      <h2>Leaderboard</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th className="num">{isDraft ? "Roster" : "Picks"}</th>
            <th className="num">Points</th>
          </tr>
        </thead>
        <tbody>
          {board.map((r, i) => (
            <tr key={r.id}>
              <td>{i + 1}</td>
              <td>
                {r.username}
                {r.id === user.id ? " (you)" : ""}
              </td>
              <td className="num">{isDraft ? r.roster : r.picks}</td>
              <td className="num">
                <strong>{r.total}</strong>
                {isDraft && r.projected > 0 && <span className="muted small"> +{r.projected} proj.</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Invite friends</h2>
      <div className="invite">
        <input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
        <button
          className="ghost"
          onClick={() => {
            navigator.clipboard.writeText(inviteUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="tools" style={{ marginTop: 40 }}>
        <span className="muted small">
          {updatedAt
            ? `Updates every minute · checked ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : ""}
        </span>
        <button className="ghost btn-sm" onClick={refresh} disabled={syncing}>
          {syncing ? "Checking..." : "Check now"}
        </button>
      </div>

      {isDraft ? (
        <>
          <h2 style={{ marginTop: 8 }}>Players</h2>
          {players.length === 0 ? (
            <p className="muted">
              This draft league was made with an older version and has no players. Create a new league to try the
              updated draft.
            </p>
          ) : (
            <>
              <p className="muted">
                <Dot s={draftWin} />
                {draftOpen
                  ? `Draft open until ${fmtDateTime(league.draft_closes_at)}. `
                  : `Draft closed ${fmtDateTime(league.draft_closes_at)}. `}
                Each player can be on one roster. An event pays more the less likely it was when it was added, and
                each extra event for the same player is worth a bit less than the one before.
              </p>
              <p>
                <strong>
                  Your roster {myRoster.length}/{league.roster_size}
                </strong>
                {myRoster.length > 0 && <span className="muted">: {myRoster.map((p) => p.name).join(", ")}</span>}
              </p>

              {playerRows.map(({ p, open, earned }) => {
                const owner = ownerByPlayer.get(p.id);
                const mine = owner === user.id;
                return (
                  <div className="card" key={p.id}>
                    <div className="phead">
                      <div>
                        <strong>{p.name}</strong>
                        {earned > 0 && <span className="muted small"> · +{earned} pts earned</span>}
                      </div>
                      <div>
                        {owner ? (
                          <>
                            <span className="muted">{mine ? "you" : nameOf(owner)}</span>
                            {mine && draftOpen && (
                              <>
                                {" "}
                                <button
                                  className="ghost btn-sm"
                                  disabled={busyId === p.id}
                                  onClick={() => draftAction(p, "drop")}
                                >
                                  Drop
                                </button>
                              </>
                            )}
                          </>
                        ) : draftOpen ? (
                          <button
                            className="btn-sm"
                            disabled={busyId === p.id || rosterFull}
                            onClick={() => draftAction(p, "pick")}
                          >
                            Draft
                          </button>
                        ) : (
                          <span className="muted">Undrafted</span>
                        )}
                      </div>
                    </div>
                    {open.length === 0 && <div className="muted small">No open events right now. New ones are added automatically.</div>}
                    {open.map((e) => {
                      const st = marketStatus(e, now);
                      return (
                        <div className="ev" key={e.id}>
                          <span>
                            <Dot s={st} />
                            {e.question}
                          </span>
                          <span className="muted nowrap">
                            {st === "awaiting"
                              ? "awaiting result"
                              : `${pct(e.price)} · worth ${scored.get(e.id)?.win ?? 0} pts · closes ${fmtDateTime(e.end_date)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </>
      ) : (
        <>
          <h2 style={{ marginTop: 8 }}>Predictions</h2>
          <p className="muted">
            A correct pick earns 100 minus the chance Polymarket gave it when you picked, so longshots pay more. You can
            change a pick until the event closes.
          </p>

          {activeMarkets.length === 0 && <p className="muted">No open events right now. New ones are added automatically.</p>}
          {activeMarkets.map((lm) => {
            const mine = myPreds.get(lm.id);
            const status = marketStatus(lm, now);
            const canPick = status === "open" || status === "soon";
            const ps = predsByMarket.get(lm.id) ?? [];

            const statusText =
              status === "awaiting"
                ? "Closed · waiting for the result"
                : `${status === "soon" ? "Closing soon" : "Open"} · closes ${fmtDateTime(lm.end_date)}${
                    inTime(lm.end_date, now) ? ` (${inTime(lm.end_date, now)})` : ""
                  }`;

            return (
              <div className="card" key={lm.id}>
                <div className="status">
                  <Dot s={status} />
                  {statusText}
                </div>
                <strong>{lm.question}</strong>

                <div className="row">
                  {lm.outcomes.map((o, i) => {
                    const selected = mine?.pick === o;
                    let sub = "";
                    if (selected && mine) sub = `your pick · locked at ${pct(mine.price_at_pick)}`;
                    else if (canPick) sub = `worth ${pointsForPrice(lm.prices[i])} pts`;
                    return (
                      <button
                        key={o}
                        className={`pick${selected ? " on" : ""}`}
                        disabled={!canPick || busyId === lm.id}
                        onClick={() => pick(lm, o)}
                      >
                        {o} · {pct(lm.prices[i])}
                        {sub && <small>{sub}</small>}
                      </button>
                    );
                  })}
                </div>

                <div className="votes">
                  {ps.length === 0
                    ? "No picks yet"
                    : lm.outcomes.map((o) => {
                        const who = ps.filter((p) => p.pick === o);
                        if (!who.length) return null;
                        return (
                          <div key={o}>
                            <b>{o}:</b> {who.map((p) => nameOf(p.user_id)).join(", ")}
                          </div>
                        );
                      })}
                </div>
              </div>
            );
          })}
        </>
      )}

      <h2>History</h2>
      {isDraft ? (
        historyEvents.length === 0 ? (
          <p className="muted">No events have resolved yet.</p>
        ) : (
          <>
            <p className="muted">
              {myDraftEvents.length === 0
                ? "None of your players have resolved events yet."
                : `Your players came through on ${myHits} of ${myDraftEvents.length} resolved events · ${myDraftPts} pts.`}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Player</th>
                  <th>Result</th>
                  <th className="num">Owner</th>
                </tr>
              </thead>
              <tbody>
                {historyEvents.map((e) => {
                  const owner = ownerByPlayer.get(e.player_id);
                  return (
                    <tr key={e.id}>
                      <td>{e.question}</td>
                      <td>{playerById.get(e.player_id)?.name ?? "?"}</td>
                      <td>{e.won ? "Yes" : "No"}</td>
                      <td className="num">
                        {owner ? `${nameOf(owner)}${e.won ? ` +${scored.get(e.id)?.win ?? 0}` : " 0"}` : <span className="muted">undrafted</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )
      ) : historyMarkets.length === 0 ? (
        <p className="muted">No events have resolved yet.</p>
      ) : (
        <>
          <p className="muted">
            {myPicksResolved.length === 0
              ? "You didn't pick any of the resolved events."
              : `You were right on ${myRight} of ${myPicksResolved.length} resolved picks · ${myPredPts} pts.`}
          </p>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Result</th>
                <th>Your pick</th>
                <th className="num">Points</th>
              </tr>
            </thead>
            <tbody>
              {historyMarkets.map((m) => {
                const mine = myPreds.get(m.id);
                return (
                  <tr key={m.id}>
                    <td>{m.question}</td>
                    <td>{m.winning_outcome}</td>
                    <td>{mine ? mine.pick : <span className="muted">no pick</span>}</td>
                    <td className="num">{mine ? `${mine.points ?? 0}` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
