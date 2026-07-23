/**
 * Pure time-bucketing and coordinate math for the density timeline.
 * No DOM access — unit-tested in vitest (test/dashboard/timeline-scale.test.ts).
 *
 * Buckets are epoch-multiple aligned (floor(t / bucketMs) * bucketMs, UTC).
 * "month" and "year" are fixed 30d/365d approximations — the histogram needs
 * visual density, not calendar precision; axis labels come from real Dates.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Ascending bucket units. */
export const UNITS = [
  { unit: "hour", ms: HOUR },
  { unit: "day", ms: DAY },
  { unit: "week", ms: 7 * DAY },
  { unit: "month", ms: 30 * DAY },
  { unit: "year", ms: 365 * DAY },
];

const MAX_BUCKETS = 120;

/** Smallest unit that renders the span in <= 120 buckets (largest as fallback). */
export function chooseBucket(spanMs) {
  for (const u of UNITS) {
    if (spanMs / u.ms <= MAX_BUCKETS) return u;
  }
  return UNITS[UNITS.length - 1];
}

/**
 * Aggregate rows in [fromMs, toMs] into sparse, sorted buckets:
 * [{t0, counts: Map<key, n>, total}]. The color key falls back to
 * entry_type (blackboard rows carry no domain/status), then "other".
 */
export function bucketize(rows, fromMs, toMs, bucketMs, colorKey) {
  const byStart = new Map();
  for (const row of rows) {
    const t = Date.parse(row.timestamp);
    if (isNaN(t) || t < fromMs || t > toMs) continue;
    const t0 = Math.floor(t / bucketMs) * bucketMs;
    let bucket = byStart.get(t0);
    if (!bucket) {
      bucket = { t0, counts: new Map(), total: 0 };
      byStart.set(t0, bucket);
    }
    const key = row[colorKey] ?? row.entry_type ?? "other";
    bucket.counts.set(key, (bucket.counts.get(key) || 0) + 1);
    bucket.total++;
  }
  return [...byStart.values()].sort((a, b) => a.t0 - b.t0);
}

/** Linear time<->pixel transforms for a viewport width. */
export function makeScale(fromMs, toMs, widthPx) {
  const span = toMs - fromMs || 1;
  return {
    x: (t) => ((t - fromMs) / span) * widthPx,
    t: (x) => fromMs + (x / widthPx) * span,
  };
}
