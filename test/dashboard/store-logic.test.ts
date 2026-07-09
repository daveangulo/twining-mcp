import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS ESM frontend module, no type declarations
import { createIndexStore } from "../../src/dashboard/public/js/store.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface Row {
  id: string;
  kind: "blackboard" | "decision";
  timestamp: string;
  entry_type?: string;
  scope: string;
  summary: string;
  tags?: string[];
  domain?: string;
  status?: string;
  confidence?: string;
}

function bb(id: string, ts: string, scope: string, extra: Partial<Row> = {}): Row {
  return { id, kind: "blackboard", timestamp: ts, entry_type: "finding", scope, summary: `bb ${id}`, ...extra };
}

function dec(id: string, ts: string, scope: string, extra: Partial<Row> = {}): Row {
  return { id, kind: "decision", timestamp: ts, scope, summary: `dec ${id}`, domain: "architecture", status: "active", confidence: "high", ...extra };
}

/** Compute total_counts the way the server does. */
function countsFor(rows: Row[]) {
  const decisions: Record<string, number> = {};
  let blackboard = 0;
  for (const r of rows) {
    if (r.kind === "blackboard") blackboard++;
    else decisions[r.status!] = (decisions[r.status!] ?? 0) + 1;
  }
  return { blackboard, decisions };
}

/** Fake fetch that serves /api/index from a mutable row set and records calls. */
function makeFetch(state: { rows: Row[] }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const parsed = new URL(url, "http://localhost");
    const since = parsed.searchParams.get("since");
    const body = {
      initialized: true,
      rows: state.rows
        .filter((r) => !since || r.timestamp > since)
        .slice()
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      total_counts: countsFor(state.rows),
      generated_at: "2026-07-09T00:00:00.000Z",
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, calls };
}

/** /api/status body matching a row set (only the fields poll() reads). */
function statusFor(rows: Row[], lastActivity?: string) {
  const decs = rows.filter((r) => r.kind === "decision");
  return {
    blackboard_entries: rows.filter((r) => r.kind === "blackboard").length,
    active_decisions: decs.filter((r) => r.status === "active").length,
    provisional_decisions: decs.filter((r) => r.status === "provisional").length,
    last_activity: lastActivity ?? rows.map((r) => r.timestamp).sort().at(-1) ?? "none",
  };
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T3 = "2026-03-01T00:00:00.000Z";
const T4 = "2026-04-01T00:00:00.000Z";

/* ------------------------------------------------------------------ */
/* load                                                                */
/* ------------------------------------------------------------------ */

describe("store.load", () => {
  it("populates rows sorted timestamp ascending and records counts", async () => {
    const state = { rows: [dec("D1", T3, "src/"), bb("B1", T1, "src/"), bb("B2", T2, "docs/")] };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    expect(store.rows.map((r: Row) => r.id)).toEqual(["B1", "B2", "D1"]);
    expect(store.counts.blackboard).toBe(2);
    expect(store.counts.decisions.active).toBe(1);
  });

  it("notifies subscribers on load", async () => {
    const state = { rows: [bb("B1", T1, "src/")] };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    let called = 0;
    store.subscribe(() => called++);
    await store.load();
    expect(called).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* poll                                                                */
/* ------------------------------------------------------------------ */

describe("store.poll", () => {
  it("issues no fetch when status counts and last_activity are unchanged", async () => {
    const state = { rows: [bb("B1", T1, "src/"), dec("D1", T2, "src/")] };
    const { fetchImpl, calls } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    const before = calls.length;
    await store.poll(statusFor(state.rows));
    expect(calls.length).toBe(before);
  });

  it("fetches delta with since=<latest local timestamp> and merges without duplicates", async () => {
    const state = { rows: [bb("B1", T1, "src/"), dec("D1", T2, "src/")] };
    const { fetchImpl, calls } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    state.rows.push(bb("B2", T3, "docs/"));
    await store.poll(statusFor(state.rows));
    const deltaCall = calls.at(-1)!;
    expect(deltaCall).toContain("since=" + encodeURIComponent(T2));
    expect(store.rows.map((r: Row) => r.id)).toEqual(["B1", "D1", "B2"]);
    // No duplicates on a second identical poll
    await store.poll(statusFor(state.rows));
    expect(store.rows.length).toBe(3);
  });

  it("does exactly one full refetch when merged counts mismatch server total_counts", async () => {
    const state = { rows: [bb("B1", T1, "src/"), dec("D1", T2, "src/")] };
    const { fetchImpl, calls } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    // Server-side: D1 flips active -> superseded AND a new entry lands.
    // The delta returns only the new row; local D1 still says "active" -> per-status mismatch.
    state.rows = [bb("B1", T1, "src/"), dec("D1", T2, "src/", { status: "superseded" }), bb("B2", T3, "docs/")];
    await store.poll(statusFor(state.rows));
    expect(store.rows.find((r: Row) => r.id === "D1")!.status).toBe("superseded");
    // load(1) + delta(1) + full refetch(1) = 3 total /api/index calls — no refetch loop
    expect(calls.length).toBe(3);
  });

  it("catches a pure status flip (no new rows) via active-count change in /api/status", async () => {
    const state = { rows: [bb("B1", T1, "src/"), dec("D1", T2, "src/")] };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    state.rows = [bb("B1", T1, "src/"), dec("D1", T2, "src/", { status: "superseded" })];
    await store.poll(statusFor(state.rows));
    expect(store.rows.find((r: Row) => r.id === "D1")!.status).toBe("superseded");
  });

  it("compares decision status keys generically (archived key triggers refetch)", async () => {
    const state = { rows: [dec("D1", T1, "src/"), dec("D2", T2, "src/")] };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    state.rows = [dec("D1", T1, "src/"), dec("D2", T2, "src/", { status: "archived" })];
    await store.poll(statusFor(state.rows));
    expect(store.rows.find((r: Row) => r.id === "D2")!.status).toBe("archived");
  });
});

/* ------------------------------------------------------------------ */
/* filter                                                              */
/* ------------------------------------------------------------------ */

describe("store.filter", () => {
  async function loaded() {
    const state = {
      rows: [
        bb("B1", T1, "src/auth/", { entry_type: "warning", tags: ["security"] }),
        bb("B2", T2, "src/db/", { entry_type: "finding" }), // no tags key
        dec("D1", T3, "src/auth/", { domain: "security", confidence: "low" }),
        dec("D2", T4, "docs/", { status: "superseded" }),
      ],
    };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    return store;
  }

  it("filters by kind, scope prefix, and text substring (case-insensitive)", async () => {
    const store = await loaded();
    expect(store.filter({ kinds: ["decision"] }).map((r: Row) => r.id)).toEqual(["D1", "D2"]);
    expect(store.filter({ scope: "src/" }).map((r: Row) => r.id)).toEqual(["B1", "B2", "D1"]);
    expect(store.filter({ text: "BB b1" }).map((r: Row) => r.id)).toEqual(["B1"]);
  });

  it("applies date range and AND-across / OR-within facet semantics", async () => {
    const store = await loaded();
    expect(store.filter({ from: T2, to: T3 }).map((r: Row) => r.id)).toEqual(["B2", "D1"]);
    expect(store.filter({ entryTypes: ["warning", "finding"] }).length).toBe(2);
    expect(store.filter({ entryTypes: ["warning"], scope: "src/auth/" }).map((r: Row) => r.id)).toEqual(["B1"]);
  });

  it("handles rows without a tags key when filtering by tags", async () => {
    const store = await loaded();
    expect(store.filter({ tags: ["security"] }).map((r: Row) => r.id)).toEqual(["B1"]);
  });
});

/* ------------------------------------------------------------------ */
/* facetCounts / scopeChildren                                         */
/* ------------------------------------------------------------------ */

describe("store.facetCounts", () => {
  it("counts a facet's values with the filter applied except that facet", async () => {
    const state = {
      rows: [
        bb("B1", T1, "src/", { entry_type: "warning" }),
        bb("B2", T2, "src/", { entry_type: "finding" }),
        bb("B3", T3, "docs/", { entry_type: "warning" }),
      ],
    };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    // entryTypes filter itself must NOT narrow the entry_type facet counts
    const counts = store.facetCounts({ scope: "src/", entryTypes: ["warning"] }, "entry_type");
    expect(counts.get("warning")).toBe(1);
    expect(counts.get("finding")).toBe(1);
    expect(counts.has("undefined")).toBe(false);
  });
});

describe("store.scopeChildren", () => {
  it("returns direct children of a prefix with counts, sorted by count desc", async () => {
    const state = {
      rows: [
        bb("B1", T1, "src/auth/"),
        bb("B2", T2, "src/auth/oauth/"),
        bb("B3", T3, "src/db/"),
        dec("D1", T4, "project"),
      ],
    };
    const { fetchImpl } = makeFetch(state);
    const store = createIndexStore({ fetchImpl });
    await store.load();
    const root = store.scopeChildren({}, "");
    expect(root).toEqual([
      { segment: "src/", scope: "src/", count: 3 },
      { segment: "project", scope: "project", count: 1 },
    ]);
    const src = store.scopeChildren({}, "src/");
    expect(src).toEqual([
      { segment: "auth/", scope: "src/auth/", count: 2 },
      { segment: "db/", scope: "src/db/", count: 1 },
    ]);
  });
});
