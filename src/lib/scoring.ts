/**
 * Prediction scoring: you earn points only if your pick is right, and the less likely
 * Polymarket thought it was when you picked, the more you earn.
 * A 20% pick that hits = 80 pts. A 90% pick that hits = 10 pts. Wrong = 0.
 */
export function pointsForPrice(price: number): number {
  const p = Math.min(Math.max(price, 0), 1);
  return Math.max(1, Math.round(100 * (1 - p)));
}

/**
 * Draft scoring: every event attached to a player is worth DRAFT_WIN_POINTS if it resolves
 * "Yes" (the player came through), so a player earns across all of their events.
 * While an event is open, its current chance is shown as projected points but does not
 * count toward the total.
 */
export const DRAFT_WIN_POINTS = 100;

type EventState = { resolved: boolean; won: boolean | null; price: number };

export function draftPoints(e: EventState): number {
  return e.resolved && e.won ? DRAFT_WIN_POINTS : 0;
}

export function draftProjected(e: EventState): number {
  if (e.resolved) return draftPoints(e);
  return Math.round(DRAFT_WIN_POINTS * Number(e.price));
}
