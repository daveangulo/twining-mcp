import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS ESM frontend module, no type declarations
import { chooseBucket, bucketize, makeScale, UNITS } from "../../src/dashboard/public/js/timeline-scale.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function row(ts: string, extra: Record<string, unknown> = {}) {
  return { id: ts, kind: "decision", timestamp: ts, scope: "src/", summary: "x", status: "active", domain: "architecture", ...extra };
}

describe("chooseBucket", () => {
  it("picks the smallest unit yielding <= 120 buckets", () => {
    expect(chooseBucket(3 * DAY).unit).toBe("hour"); // 72 buckets
    expect(chooseBucket(5 * DAY).unit).toBe("hour"); // exactly 120
    expect(chooseBucket(6 * DAY).unit).toBe("day"); // 144 hours > 120
    expect(chooseBucket(90 * DAY).unit).toBe("day"); // 90 buckets
    expect(chooseBucket(730 * DAY).unit).toBe("week"); // 104 weeks
    expect(chooseBucket(9 * 365 * DAY).unit).toBe("month"); // ~110 month-buckets
  });

  it("returns the unit's bucket width in ms", () => {
    expect(chooseBucket(3 * DAY).ms).toBe(HOUR);
    expect(chooseBucket(90 * DAY).ms).toBe(DAY);
  });

  it("falls back to the largest unit for absurd spans", () => {
    expect(chooseBucket(1000 * 365 * DAY).unit).toBe("year");
  });
});

describe("bucketize", () => {
  const from = Date.parse("2026-01-01T00:00:00.000Z");
  const to = Date.parse("2026-01-03T00:00:00.000Z");

  it("floors timestamps to epoch-aligned bucket starts and counts by colorKey", () => {
    const rows = [
      row("2026-01-01T10:15:00.000Z", { domain: "security" }),
      row("2026-01-01T10:45:00.000Z", { domain: "security" }),
      row("2026-01-01T11:05:00.000Z", { domain: "testing" }),
    ];
    const buckets = bucketize(rows, from, to, HOUR, "domain");
    expect(buckets.length).toBe(2);
    const b10 = buckets.find((b: { t0: number }) => b.t0 === Date.parse("2026-01-01T10:00:00.000Z"))!;
    expect(b10.total).toBe(2);
    expect(b10.counts.get("security")).toBe(2);
    const b11 = buckets.find((b: { t0: number }) => b.t0 === Date.parse("2026-01-01T11:00:00.000Z"))!;
    expect(b11.counts.get("testing")).toBe(1);
  });

  it("excludes rows outside [fromMs, toMs] and returns [] for empty input", () => {
    const rows = [row("2025-12-31T23:59:59.000Z"), row("2026-01-03T00:00:01.000Z")];
    expect(bucketize(rows, from, to, HOUR, "domain")).toEqual([]);
    expect(bucketize([], from, to, HOUR, "domain")).toEqual([]);
  });

  it("keys blackboard rows (no domain) by entry_type under any colorKey", () => {
    const rows = [row("2026-01-01T10:00:00.000Z", { kind: "blackboard", domain: undefined, status: undefined, entry_type: "warning" })];
    const byDomain = bucketize(rows, from, to, HOUR, "domain");
    expect(byDomain[0].counts.get("warning")).toBe(1);
    const byStatus = bucketize(rows, from, to, HOUR, "status");
    expect(byStatus[0].counts.get("warning")).toBe(1);
  });

  it("returns buckets sorted by t0", () => {
    const rows = [row("2026-01-02T05:00:00.000Z"), row("2026-01-01T01:00:00.000Z")];
    const buckets = bucketize(rows, from, to, HOUR, "domain");
    expect(buckets[0].t0).toBeLessThan(buckets[1].t0);
  });
});

describe("makeScale", () => {
  it("maps time to x and back (round trip)", () => {
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const to = from + 10 * DAY;
    const scale = makeScale(from, to, 1000);
    expect(scale.x(from)).toBe(0);
    expect(scale.x(to)).toBe(1000);
    const mid = from + 5 * DAY;
    expect(scale.x(mid)).toBe(500);
    expect(scale.t(scale.x(mid))).toBe(mid);
  });

  it("exposes UNITS for renderers (hour..year ascending)", () => {
    expect(UNITS.map((u: { unit: string }) => u.unit)).toEqual(["hour", "day", "week", "month", "year"]);
    expect(UNITS[1].ms).toBe(DAY);
    expect(UNITS[2].ms).toBe(WEEK);
  });
});
