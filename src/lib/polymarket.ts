const GAMMA = "https://gamma-api.polymarket.com";

/** Minimum total USD traded on a market for it to be included. Override with MIN_MARKET_VOLUME. */
export const MIN_VOLUME = Number(process.env.MIN_MARKET_VOLUME ?? 10000);
/** Open prediction events a non-draft league tries to keep available. */
export const TARGET_MARKETS = 12;
/** Open events each draft player tries to keep attached. */
export const EVENTS_PER_PLAYER = 3;
export const MAX_PLAYERS = 12;

export type PMMarket = {
  marketId: string;
  question: string;
  eventTitle: string | null;
  groupTitle: string | null; // e.g. a candidate's name inside a "who will win" event
  endDate: string | null;
  outcomes: string[];
  prices: number[];
  closed: boolean;
  volume: number | null; // null when Polymarket doesn't report it
};

export type PMEvent = { title: string; markets: PMMarket[] };

export type PMPlayerEvent = {
  marketId: string;
  question: string;
  endDate: string | null;
  price: number; // current "Yes" probability
};

export type PMPlayer = { name: string; events: PMPlayerEvent[] };

// Gamma returns `outcomes` and `outcomePrices` as JSON-encoded strings.
function parseArr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMarket(m: any, eventTitle: string | null): PMMarket | null {
  if (!m || m.id == null || !m.question) return null;
  const outcomes = parseArr(m.outcomes).map(String);
  const prices = parseArr(m.outcomePrices).map(Number);
  if (outcomes.length < 2 || outcomes.length !== prices.length) return null;
  if (prices.some((p) => !Number.isFinite(p))) return null;
  const rawVol = m.volumeNum ?? m.volume;
  const vol = rawVol == null || rawVol === "" ? null : Number(rawVol);
  return {
    marketId: String(m.id),
    question: String(m.question),
    eventTitle,
    groupTitle: m.groupItemTitle ? String(m.groupItemTitle) : null,
    endDate: m.endDate ?? null,
    outcomes,
    prices,
    closed: Boolean(m.closed),
    volume: vol !== null && Number.isFinite(vol) ? vol : null,
  };
}

export function yesIndex(outcomes: string[]): number {
  return Math.max(0, outcomes.findIndex((o) => o.toLowerCase() === "yes"));
}

/** 1 = perfectly even odds, 0 = a certainty. A 50/50 scores 1, 95/5 scores 0.1. */
export function balance(m: { prices: number[] }): number {
  const n = m.prices.length;
  if (n < 2) return 0;
  const maxP = Math.max(...m.prices);
  const score = 1 - (maxP - 1 / n) / (1 - 1 / n);
  return Math.min(1, Math.max(0, score));
}

function isOpen(m: PMMarket): boolean {
  if (m.closed) return false;
  if (m.endDate && new Date(m.endDate).getTime() <= Date.now()) return false;
  return true;
}

/** Enough trading activity to be worth including. Unknown volume is let through. */
export function eligible(m: PMMarket): boolean {
  return m.volume === null || m.volume >= MIN_VOLUME;
}

// ---------- Player identification ----------

// Polymarket uses stand-ins for options that aren't known yet ("Person A", "Candidate B", "Other").
const PLACEHOLDER = /^(person|candidate|player|team|option|woman|man|individual|choice|entry|nominee|runner)\s*[a-z0-9]{0,2}$/i;
const NOT_A_NAME =
  /^(other|others|another|any other|anyone else|someone else|someone|no one|nobody|none|tie|draw|field|the field|rest|unknown|tbd|n\/a|not|no|yes)\b/i;
const BAD_CHARS = /[\d↑↓$%<>=+?!:;/]/;
const BAD_WORDS = /\b(bps|above|below|between|before|after|over|under|increase|decrease|hike|cut|unchanged|more|less)\b/i;
const NAME_JOINERS = /^(de|da|del|di|van|von|bin|al|el|la|le|of|the|and|&|jr\.?|sr\.?|ii|iii)$/i;

/** True only for something that looks like a real person/team name, not a placeholder or a bracket. */
export function isRealName(name: string): boolean {
  const n = name.trim();
  if (n.length < 3 || n.length > 40) return false;
  if (PLACEHOLDER.test(n) || NOT_A_NAME.test(n) || BAD_CHARS.test(n) || BAD_WORDS.test(n)) return false;
  const words = n.split(/\s+/);
  if (words.length > 5) return false;
  return words.every((w) => /^[A-ZÀ-Þ]/.test(w) || NAME_JOINERS.test(w));
}

/**
 * The named options of a "who will win" event, but only when they are mutually exclusive.
 * Exclusive options' Yes prices add up to about 100%; if they add up to a lot more, the
 * options overlap (e.g. "by March / by June / by December") and can't be treated as rivals.
 */
export function exclusiveGroup(e: PMEvent): PMMarket[] {
  const grouped = e.markets.filter((m) => m.groupTitle);
  const sum = grouped.reduce((s, m) => s + m.prices[yesIndex(m.outcomes)], 0);
  return grouped.length >= 3 && sum <= 1.1 ? grouped : [];
}

// ---------- Search ----------

async function searchEvents(q: string): Promise<PMEvent[]> {
  const url = `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=10&events_status=active`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Polymarket search failed (${res.status})`);
  const json = await res.json();
  const out: PMEvent[] = [];
  for (const ev of json.events ?? []) {
    const title = String(ev.title ?? "");
    const markets: PMMarket[] = [];
    for (const m of ev.markets ?? []) {
      const mk = toMarket(m, title || null);
      if (mk && isOpen(mk)) markets.push(mk);
    }
    if (markets.length) out.push({ title, markets });
  }
  return out;
}

async function gatherEvents(topic: string, enough: (events: PMEvent[]) => boolean): Promise<PMEvent[]> {
  const seen = new Set<string>();
  const events: PMEvent[] = [];
  const add = (list: PMEvent[]) => {
    for (const e of list) {
      if (seen.has(e.title)) continue;
      seen.add(e.title);
      events.push(e);
    }
  };

  add(await searchEvents(topic));
  if (!enough(events)) {
    const words = Array.from(new Set(topic.split(/\s+/).filter((w) => w.length > 3))).slice(0, 3);
    for (const w of words) {
      try {
        add(await searchEvents(w));
      } catch {
        /* ignore single-word failures */
      }
      if (enough(events)) break;
    }
  }
  return events;
}

// ---------- Prediction events (non-draft leagues) ----------

const MAX_PER_EVENT = 3;
const BALANCED_MIN = 0.2; // max outcome <= ~90% for a binary market

/**
 * Pick prediction markets, favouring balanced odds and capping per event for variety.
 * `strict` returns only balanced ones (used when rotating new events in).
 */
export function selectMarkets(
  events: PMEvent[],
  max = TARGET_MARKETS,
  exclude: Set<string> = new Set(),
  strict = false
): PMMarket[] {
  const cands = events
    .flatMap((e) => e.markets)
    .filter((m) => eligible(m) && !exclude.has(m.marketId) && Math.max(...m.prices) < 0.98)
    .sort((a, b) => balance(b) - balance(a));

  const perEvent = new Map<string, number>();
  const picked: PMMarket[] = [];
  for (const m of cands) {
    const key = m.eventTitle ?? m.marketId;
    const c = perEvent.get(key) ?? 0;
    if (c >= MAX_PER_EVENT) continue;
    picked.push(m);
    perEvent.set(key, c + 1);
    if (picked.length >= max) break;
  }
  const balanced = picked.filter((m) => balance(m) >= BALANCED_MIN);
  if (strict) return balanced;
  // Quality over quantity, but never leave a new league nearly empty.
  return balanced.length >= Math.min(6, max) ? balanced : picked;
}

export async function buildMarketPool(
  topic: string,
  max = TARGET_MARKETS,
  exclude: Set<string> = new Set(),
  strict = false
): Promise<PMMarket[]> {
  const events = await gatherEvents(
    topic,
    (evs) => selectMarkets(evs, max, exclude, strict).length >= Math.min(8, max)
  );
  return selectMarkets(events, max, exclude, strict);
}

// ---------- Draft players ----------

/** Seed players from "who will win" events whose options are real names and mutually exclusive. */
export function seedPlayers(events: PMEvent[], max = MAX_PLAYERS): PMPlayer[] {
  const byName = new Map<string, PMPlayer>();
  let used = 0;
  for (const e of events) {
    if (byName.size >= max || used >= 3) break;
    const named = exclusiveGroup(e)
      .filter((m) => isRealName(m.groupTitle as string) && eligible(m))
      .map((m) => ({ m, price: m.prices[yesIndex(m.outcomes)] }))
      .filter((x) => x.price >= 0.03 && x.price < 0.98)
      .sort((a, b) => b.price - a.price)
      .slice(0, 8);
    if (named.length < 3) continue;
    used++;
    for (const { m, price } of named) {
      const name = (m.groupTitle as string).trim();
      const key = name.toLowerCase();
      if (!byName.has(key) && byName.size >= max) continue;
      const player = byName.get(key) ?? { name, events: [] };
      if (!player.events.some((x) => x.marketId === m.marketId)) {
        player.events.push({ marketId: m.marketId, question: m.question, endDate: m.endDate, price });
      }
      byName.set(key, player);
    }
  }
  return Array.from(byName.values());
}

/**
 * Open Yes/No events about a specific player: their own option in an exclusive "who will win"
 * event, or a question that starts with "Will <name> ...". Balanced odds come first.
 */
export async function findPlayerEvents(
  name: string,
  exclude: Set<string>,
  need: number
): Promise<PMPlayerEvent[]> {
  if (need <= 0) return [];
  const lname = name.toLowerCase();
  const prefix = `will ${lname}`;
  const evs = await searchEvents(name);
  const found: (PMPlayerEvent & { score: number })[] = [];
  const seen = new Set<string>();

  for (const e of evs) {
    const exclusiveIds = new Set(exclusiveGroup(e).map((m) => m.marketId));
    for (const m of e.markets) {
      if (exclude.has(m.marketId) || seen.has(m.marketId) || !eligible(m)) continue;
      const yi = m.outcomes.findIndex((o) => o.toLowerCase() === "yes");
      if (yi < 0) continue;
      const price = m.prices[yi];
      if (price < 0.03 || price >= 0.98) continue;

      const q = m.question.toLowerCase();
      const subject = q.startsWith(prefix) && !/[a-z]/.test(q.charAt(prefix.length));
      const option = exclusiveIds.has(m.marketId) && (m.groupTitle ?? "").trim().toLowerCase() === lname;
      if (!subject && !option) continue;

      seen.add(m.marketId);
      found.push({
        marketId: m.marketId,
        question: m.question,
        endDate: m.endDate,
        price,
        score: balance({ prices: [price, 1 - price] }),
      });
    }
  }

  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, need)
    .map(({ score: _score, ...rest }) => rest);
}

/** Build the player pool for a topic, giving each player several events to be scored on. */
export async function buildPlayerPool(topic: string): Promise<PMPlayer[]> {
  const events = await gatherEvents(topic, (evs) => seedPlayers(evs).length >= 6);
  const players = seedPlayers(events);

  const taken = new Set(players.flatMap((p) => p.events.map((e) => e.marketId)));
  for (const p of players) {
    try {
      const extra = await findPlayerEvents(p.name, taken, EVENTS_PER_PLAYER - p.events.length);
      extra.forEach((x) => taken.add(x.marketId));
      p.events.push(...extra);
    } catch {
      /* a failed lookup just leaves this player with fewer events for now */
    }
  }
  return players;
}

// ---------- Live data ----------

export async function getMarket(marketId: string): Promise<PMMarket | null> {
  const res = await fetch(`${GAMMA}/markets/${encodeURIComponent(marketId)}`, { cache: "no-store" });
  if (!res.ok) return null;
  return toMarket(await res.json(), null);
}

/** A closed market with one outcome at ~100% has resolved to that outcome. */
export function winningOutcome(m: PMMarket): string | null {
  if (!m.closed) return null;
  const idx = m.prices.findIndex((p) => p >= 0.99);
  return idx >= 0 ? m.outcomes[idx] : null;
}
