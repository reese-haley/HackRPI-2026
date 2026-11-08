export type Status = "open" | "soon" | "awaiting" | "resolved";

const HOUR = 3600_000;

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "in 3h", "in 2d", "in 12m". Empty string when already past or unknown. */
export function inTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const diff = Date.parse(iso) - now;
  if (diff <= 0) return "";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hours = Math.round(diff / HOUR);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(diff / (24 * HOUR))}d`;
}

/** Prediction market lifecycle: open -> (closing soon) -> awaiting result -> resolved. */
export function marketStatus(m: { resolved: boolean; end_date: string | null }, now: number): Status {
  if (m.resolved) return "resolved";
  if (!m.end_date) return "open";
  const diff = Date.parse(m.end_date) - now;
  if (diff <= 0) return "awaiting";
  return diff < 24 * HOUR ? "soon" : "open";
}

/** Draft window lifecycle: open -> closing soon -> closed. */
export function windowStatus(closesAt: string | null, now: number): "open" | "soon" | "closed" {
  if (!closesAt) return "closed";
  const diff = Date.parse(closesAt) - now;
  if (diff <= 0) return "closed";
  return diff < 6 * HOUR ? "soon" : "open";
}
