/**
 * Full §10 test suite for buildTriage (TRIAGE-SPEC.md §10 items 1–13).
 * Parameterized over BOTH backends per test/sqlite-backend.test.ts parity
 * conventions (describe.skipIf(!HAS_SQLITE)); the clock is injected
 * everywhere. Item 14 (adapter tests) lands with the tool/HTTP adapters,
 * as does the HTTP `initialized: false` half of item 11.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, type SqliteDatabase } from "../src/storage/sqlite/db.js";
import {
  SqliteBlackboardStore,
  SqliteDecisionStore,
} from "../src/storage/sqlite/sqlite-stores.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";
import { buildTriage, type TriageStores } from "../src/engine/triage.js";
import { computeResolvedIds } from "../src/engine/resolution.js";
import type {
  BlackboardEntry,
  Decision,
  DecisionIndexEntry,
  TriageItem,
} from "../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const NOW = new Date("2026-07-23T12:00:00.000Z");
const now = () => NOW;
// Default window is 7 days: cutoff = NOW − 604_800_000 ms, strict >.
const WINDOW_CUTOFF = "2026-07-16T12:00:00.000Z";
const WINDOW_CUTOFF_PLUS_1MS = "2026-07-16T12:00:00.001Z";
const IN_WINDOW = "2026-07-20T00:00:00.000Z";
const IN_WINDOW_LATER = "2026-07-21T00:00:00.000Z";
const OUT_OF_WINDOW = "2026-07-01T00:00:00.000Z";

function ids(items: TriageItem[] | undefined): string[] {
  return (items ?? []).map((i) => i.id);
}

function makeEntry(
  id: string,
  type: BlackboardEntry["entry_type"],
  summary: string,
  extra: Partial<BlackboardEntry>,
): BlackboardEntry {
  return {
    id,
    timestamp: IN_WINDOW,
    agent_id: "main",
    entry_type: type,
    tags: ["test"],
    scope: "src/",
    summary,
    detail: "",
    ...extra,
  };
}

function makeDecision(
  id: string,
  summary: string,
  extra: Partial<Decision>,
): Decision {
  return {
    id,
    timestamp: IN_WINDOW,
    agent_id: "main",
    domain: "test",
    scope: "src/",
    summary,
    context: "",
    rationale: "because reasons",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    status: "active",
    reversible: true,
    affected_files: [],
    affected_symbols: [],
    commit_hashes: [],
    ...extra,
  };
}

interface TriageFixture {
  stores(): TriageStores;
  makeDecisionEngine(): DecisionEngine;
  postEntry(
    type: BlackboardEntry["entry_type"],
    summary: string,
    extra?: Partial<BlackboardEntry>,
  ): string;
  writeDecision(summary: string, extra?: Partial<Decision>): string;
  cleanup(): void;
}

function makeFileFixture(): TriageFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-triage-file-"));
  fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(dir, "decisions"));
  fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
  let entrySeq = 0;
  let decisionSeq = 0;
  return {
    // Fresh store instances per call: direct fs writes bypass the stores'
    // mtime caches, and same-millisecond appends could otherwise serve
    // stale reads.
    stores: () => ({
      decisionStore: new DecisionStore(dir),
      blackboardStore: new BlackboardStore(dir),
    }),
    makeDecisionEngine: () =>
      new DecisionEngine(
        new DecisionStore(dir),
        new BlackboardEngine(new BlackboardStore(dir)),
      ),
    postEntry(type, summary, extra = {}) {
      const entry = makeEntry(
        `bb-${String(entrySeq++).padStart(4, "0")}`,
        type,
        summary,
        extra,
      );
      fs.appendFileSync(
        path.join(dir, "blackboard.jsonl"),
        JSON.stringify(entry) + "\n",
      );
      return entry.id;
    },
    writeDecision(summary, extra = {}) {
      const decision = makeDecision(
        `dec-${String(decisionSeq++).padStart(4, "0")}`,
        summary,
        extra,
      );
      const decisionsDir = path.join(dir, "decisions");
      fs.writeFileSync(
        path.join(decisionsDir, `${decision.id}.json`),
        JSON.stringify(decision, null, 2),
      );
      const indexPath = path.join(decisionsDir, "index.json");
      const index = JSON.parse(
        fs.readFileSync(indexPath, "utf-8"),
      ) as DecisionIndexEntry[];
      index.push({
        id: decision.id,
        timestamp: decision.timestamp,
        domain: decision.domain,
        scope: decision.scope,
        summary: decision.summary,
        confidence: decision.confidence,
        status: decision.status,
        affected_files: decision.affected_files,
        affected_symbols: decision.affected_symbols,
        commit_hashes: decision.commit_hashes,
      });
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      return decision.id;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSqliteFixture(): TriageFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-triage-sqlite-"));
  const db: SqliteDatabase = openDatabase(dir);
  let entrySeq = 0;
  let decisionSeq = 0;
  return {
    stores: () => ({
      decisionStore: new SqliteDecisionStore(db),
      blackboardStore: new SqliteBlackboardStore(db),
    }),
    makeDecisionEngine: () =>
      new DecisionEngine(
        new SqliteDecisionStore(db),
        new BlackboardEngine(new SqliteBlackboardStore(db)),
      ),
    postEntry(type, summary, extra = {}) {
      const entry = makeEntry(
        `bb-${String(entrySeq++).padStart(4, "0")}`,
        type,
        summary,
        extra,
      );
      db.prepare(
        "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
      ).run(
        entry.id,
        entry.entry_type,
        entry.scope,
        entry.timestamp,
        JSON.stringify(entry),
      );
      return entry.id;
    },
    writeDecision(summary, extra = {}) {
      const decision = makeDecision(
        `dec-${String(decisionSeq++).padStart(4, "0")}`,
        summary,
        extra,
      );
      db.prepare(
        "INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)",
      ).run(
        decision.id,
        decision.status,
        decision.timestamp,
        JSON.stringify(decision),
      );
      return decision.id;
    },
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BACKENDS: Array<{
  name: string;
  skip: boolean;
  make: () => TriageFixture;
}> = [
  { name: "file", skip: false, make: makeFileFixture },
  { name: "sqlite", skip: !HAS_SQLITE, make: makeSqliteFixture },
];

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`buildTriage — ${backend.name} backend`, () => {
    let fx: TriageFixture;

    beforeEach(() => {
      fx = backend.make();
    });

    afterEach(() => {
      fx.cleanup();
    });

    describe("§10.1 openness predicate", () => {
      it("excludes back-referenced need/question/warning and agrees with the shared computeResolvedIds helper", async () => {
        const openNeed = fx.postEntry("need", "unresolved need");
        const resolvedNeed = fx.postEntry("need", "resolved need");
        fx.postEntry("status", "need resolver", { relates_to: [resolvedNeed] });
        const openQuestion = fx.postEntry("question", "open question");
        const resolvedQuestion = fx.postEntry("question", "answered question");
        fx.postEntry("answer", "the answer", {
          relates_to: [resolvedQuestion],
        });
        const openWarning = fx.postEntry("warning", "open warning");
        const resolvedWarning = fx.postEntry("warning", "resolved warning");
        fx.postEntry("status", "warning resolver", {
          relates_to: [resolvedWarning],
        });

        const result = await buildTriage(fx.stores(), {}, now);

        expect(ids(result.open).sort()).toEqual(
          [openNeed, openQuestion, openWarning].sort(),
        );

        // Verified via the SHARED helper — the expectation is computed with
        // computeResolvedIds itself, not a reimplemented predicate.
        const { entries } = await fx.stores().blackboardStore.read();
        const resolved = computeResolvedIds(entries);
        const expectedOpen = entries
          .filter(
            (e) =>
              ["need", "question", "warning"].includes(e.entry_type) &&
              !resolved.has(e.id),
          )
          .map((e) => e.id)
          .sort();
        expect(ids(result.open).sort()).toEqual(expectedOpen);
      });

      it("resolves via a back-reference from an entry with an EARLIER timestamp (order-agnostic)", async () => {
        const need = fx.postEntry("need", "late need", {
          timestamp: IN_WINDOW_LATER,
        });
        fx.postEntry("status", "earlier resolver", {
          timestamp: IN_WINDOW,
          relates_to: [need],
        });

        const result = await buildTriage(fx.stores(), {}, now);

        expect(result.open).toEqual([]);
      });
    });

    describe("§10.2 resolution corpus", () => {
      it("resolves an in-scope need via an out-of-scope resolver on a scoped call (corpus never scope-filtered)", async () => {
        const resolved = fx.postEntry("need", "in-scope need", {
          scope: "src/auth/",
        });
        fx.postEntry("status", "out-of-scope resolver", {
          scope: "docs/",
          relates_to: [resolved],
        });

        const result = await buildTriage(fx.stores(), { scope: "src/auth/" }, now);

        expect(result.open).toEqual([]);
      });

      it("resolves via status and finding entries — types triage never emits (corpus never type-filtered)", async () => {
        const byStatus = fx.postEntry("need", "status-resolved need");
        fx.postEntry("status", "status resolver", { relates_to: [byStatus] });
        const byFinding = fx.postEntry("need", "finding-resolved need");
        fx.postEntry("finding", "finding resolver", {
          relates_to: [byFinding],
        });
        const stillOpen = fx.postEntry("need", "still open");

        const result = await buildTriage(fx.stores(), {}, now);

        expect(ids(result.open)).toEqual([stillOpen]);
      });
    });

    describe("§10.3 delegation-expiry boundary", () => {
      it("excludes delegation needs at the INCLUSIVE expiry boundary and keeps 1ms-later expiries with urgency/expires_at and no detail_preview", async () => {
        const expiredMeta = {
          type: "delegation",
          required_capabilities: [],
          urgency: "high",
          expires_at: NOW.toISOString(), // now === expires_at → expired
        };
        fx.postEntry("need", "expired delegation", {
          detail: JSON.stringify(expiredMeta),
        });
        const liveExpiry = new Date(NOW.getTime() + 1).toISOString();
        const live = fx.postEntry("need", "live delegation", {
          detail: JSON.stringify({ ...expiredMeta, expires_at: liveExpiry }),
        });

        const result = await buildTriage(fx.stores(), {}, now);

        expect(ids(result.open)).toEqual([live]);
        const item = result.open![0]!;
        expect(item.urgency).toBe("high");
        expect(item.expires_at).toBe(liveExpiry);
        expect(item.detail_preview).toBeUndefined();
      });
    });

    describe("§10.4 decision status placement", () => {
      it("places provisional in open, in-window active in recent, and superseded/overridden/archived nowhere", async () => {
        const provisional = fx.writeDecision("provisional", {
          status: "provisional",
        });
        const active = fx.writeDecision("active");
        fx.writeDecision("superseded", { status: "superseded" });
        fx.writeDecision("overridden", { status: "overridden" });
        fx.writeDecision("archived", { status: "archived" });
        fx.writeDecision("aged out", {
          status: "active",
          timestamp: OUT_OF_WINDOW,
        });

        const result = await buildTriage(fx.stores(), {}, now);

        expect(ids(result.open)).toEqual([provisional]);
        expect(result.open![0]!.status).toBe("provisional");
        expect(ids(result.recent)).toEqual([active]);
        expect(result.recent![0]!.status).toBe("active");
        expect(result.counts.open.total + result.counts.recent.total).toBe(2);
      });
    });

    describe("creation-time provisional status (2.5.0 decide input)", () => {
      it("a decision born provisional sits in open until promoted; default creation stays active", async () => {
        const engine = fx.makeDecisionEngine();
        const prov = await engine.decide({
          domain: "architecture",
          scope: "src/",
          summary: "born provisional — awaiting ratification",
          context: "c",
          rationale: "r",
          reversible: false,
          status: "provisional",
        });
        const act = await engine.decide({
          domain: "architecture",
          scope: "src/",
          summary: "born active by default",
          context: "c",
          rationale: "r",
        });

        const stores = fx.stores();
        expect((await stores.decisionStore.get(prov.id))!.status).toBe("provisional");
        expect((await stores.decisionStore.get(act.id))!.status).toBe("active");
        const idx = await stores.decisionStore.getIndex();
        expect(idx.find((e) => e.id === prov.id)!.status).toBe("provisional");

        // open is unwindowed, so these assertions are clock-safe despite the
        // engine's real-time timestamps.
        const result = await buildTriage(stores, {}, now);
        expect(ids(result.open)).toContain(prov.id);
        expect(ids(result.open)).not.toContain(act.id);

        await engine.promote([prov.id]);
        const after = await buildTriage(fx.stores(), {}, now);
        expect(ids(after.open)).not.toContain(prov.id);
        // Persisted status must agree on BOTH read surfaces post-promote —
        // buildTriage would also drop the item if only one surface flipped.
        expect((await fx.stores().decisionStore.get(prov.id))!.status).toBe("active");
        const idxAfter = await fx.stores().decisionStore.getIndex();
        expect(idxAfter.find((e) => e.id === prov.id)!.status).toBe("active");
      });
    });

    describe("§10.5 reconsider cross-bucket transition + companion warning", () => {
      it("moves a reconsidered decision recent→open, keeps the companion warning open through promote, and drains it via relates_to or dismissal", async () => {
        const decisionId = fx.writeDecision("audit me", {
          status: "active",
          reversible: false,
        });
        expect(ids((await buildTriage(fx.stores(), {}, now)).recent)).toEqual([
          decisionId,
        ]);

        const engine = fx.makeDecisionEngine();
        await engine.reconsider(decisionId, "needs a longer look");

        let result = await buildTriage(fx.stores(), {}, now);
        expect(ids(result.open)).toContain(decisionId);
        expect(ids(result.recent)).not.toContain(decisionId);
        const companion = result.open!.find(
          (i) =>
            i.kind === "warning" &&
            i.summary.startsWith("Reconsideration flagged:"),
        );
        expect(companion).toBeDefined();

        // Promote's status post carries no relates_to — the companion
        // warning stays open (§3.2 limitation 3, pinned).
        await engine.promote([decisionId]);
        result = await buildTriage(fx.stores(), {}, now);
        expect(ids(result.open)).not.toContain(decisionId);
        expect(ids(result.open)).toContain(companion!.id);

        // Drain 1: a relates_to back-reference resolves it.
        fx.postEntry("status", "operator resolves companion", {
          relates_to: [companion!.id],
        });
        result = await buildTriage(fx.stores(), {}, now);
        expect(ids(result.open)).not.toContain(companion!.id);

        // Drain 2: dismissal removes a fresh companion warning.
        await engine.reconsider(decisionId, "second look");
        result = await buildTriage(fx.stores(), {}, now);
        const second = result.open!.find(
          (i) =>
            i.kind === "warning" &&
            i.id !== companion!.id &&
            i.summary.startsWith("Reconsideration flagged:"),
        );
        expect(second).toBeDefined();
        await fx.stores().blackboardStore.dismiss([second!.id]);
        result = await buildTriage(fx.stores(), {}, now);
        expect(ids(result.open)).not.toContain(second!.id);
      });
    });

    describe("§10.6 limit/counts interaction + truncation selection", () => {
      it("keeps counts pre-truncation with fully-enumerated by_kind", async () => {
        fx.writeDecision("p1", { status: "provisional", reversible: false });
        fx.writeDecision("p2", { status: "provisional" });
        fx.writeDecision("a1", { reversible: false });
        fx.postEntry("need", "n1");
        fx.postEntry("artifact", "art1");

        const result = await buildTriage(fx.stores(), { limit: 1 }, now);

        expect(result.open).toHaveLength(1);
        expect(result.recent).toHaveLength(1);
        expect(result.counts).toEqual({
          open: {
            total: 3,
            irreversible: 1,
            by_kind: { decision: 2, need: 1, question: 0, warning: 0 },
          },
          recent: {
            total: 2,
            irreversible: 1,
            by_kind: { decision: 1, artifact: 1 },
          },
        });
      });

      it("retains the N oldest open and N newest recent by (timestamp, id) as SET membership, including tie-breaks", async () => {
        const n1 = fx.postEntry("need", "n1", {
          timestamp: "2026-07-18T00:00:00.000Z",
        });
        const n2 = fx.postEntry("need", "n2", {
          timestamp: "2026-07-19T00:00:00.000Z",
        });
        const n3a = fx.postEntry("need", "n3a", {
          timestamp: "2026-07-20T00:00:00.000Z",
        });
        const n3b = fx.postEntry("need", "n3b", {
          timestamp: "2026-07-20T00:00:00.000Z", // tie with n3a; higher id
        });
        const a1 = fx.postEntry("artifact", "a1", {
          timestamp: "2026-07-18T00:00:00.000Z",
        });
        const a2a = fx.postEntry("artifact", "a2a", {
          timestamp: "2026-07-19T00:00:00.000Z",
        });
        const a2b = fx.postEntry("artifact", "a2b", {
          timestamp: "2026-07-19T00:00:00.000Z", // tie with a2a; higher id
        });
        const a3 = fx.postEntry("artifact", "a3", {
          timestamp: "2026-07-20T00:00:00.000Z",
        });

        // open ascending: at the tie, the LOWER id survives.
        const open3 = await buildTriage(fx.stores(), { limit: 3 }, now);
        expect(new Set(ids(open3.open))).toEqual(new Set([n1, n2, n3a]));
        expect(ids(open3.open)).not.toContain(n3b);

        // recent descending: at the tie, the HIGHER id survives.
        const recent2 = await buildTriage(fx.stores(), { limit: 2 }, now);
        expect(new Set(ids(recent2.recent))).toEqual(new Set([a3, a2b]));
        expect(ids(recent2.recent)).not.toContain(a2a);
        expect(ids(recent2.recent)).not.toContain(a1);
      });

      it("counts a truncated newest provisional irreversible decision in counts.open.irreversible (ratify lane)", async () => {
        const needs = [
          fx.postEntry("need", "old 1", {
            timestamp: "2026-07-18T00:00:00.000Z",
          }),
          fx.postEntry("need", "old 2", {
            timestamp: "2026-07-19T00:00:00.000Z",
          }),
          fx.postEntry("need", "old 3", {
            timestamp: "2026-07-20T00:00:00.000Z",
          }),
        ];
        const risky = fx.writeDecision("newest irreversible", {
          status: "provisional",
          reversible: false,
          timestamp: "2026-07-21T00:00:00.000Z",
        });

        const result = await buildTriage(fx.stores(), { limit: 3 }, now);

        expect(new Set(ids(result.open))).toEqual(new Set(needs));
        expect(ids(result.open)).not.toContain(risky);
        expect(result.counts.open.total).toBe(4);
        expect(result.counts.open.irreversible).toBe(1);
        expect(result.counts.open.by_kind.decision).toBe(1);
      });

      it("defaults limit to 25 and clamps to [1, 200] inside buildTriage", async () => {
        const needIds: string[] = [];
        for (let i = 0; i < 205; i++) {
          needIds.push(
            fx.postEntry("need", `need ${i}`, {
              timestamp: new Date(
                Date.parse("2026-07-18T00:00:00.000Z") + i * 1000,
              ).toISOString(),
            }),
          );
        }

        const defaulted = await buildTriage(fx.stores(), {}, now);
        expect(defaulted.open).toHaveLength(25);
        expect(defaulted.counts.open.total).toBe(205);

        const clampedHigh = await buildTriage(fx.stores(), { limit: 999 }, now);
        expect(clampedHigh.open).toHaveLength(200);
        expect(ids(clampedHigh.open)).not.toContain(needIds[204]);
        expect(clampedHigh.counts.open.total).toBe(205);

        const clampedLow = await buildTriage(fx.stores(), { limit: 0 }, now);
        expect(ids(clampedLow.open)).toEqual([needIds[0]]);
      });
    });

    describe("§10.7 section semantics", () => {
      it("leaves unrequested arrays ABSENT (not empty) while counts stay full", async () => {
        fx.writeDecision("p1", { status: "provisional" });
        fx.postEntry("artifact", "art1");

        const openOnly = await buildTriage(fx.stores(), { section: "open" }, now);
        expect(openOnly.section).toBe("open");
        expect(openOnly.open).toHaveLength(1);
        expect("recent" in openOnly).toBe(false);
        expect(openOnly.counts.recent.total).toBe(1);

        const recentOnly = await buildTriage(
          fx.stores(),
          { section: "recent" },
          now,
        );
        expect(recentOnly.section).toBe("recent");
        expect(recentOnly.recent).toHaveLength(1);
        expect("open" in recentOnly).toBe(false);
        expect(recentOnly.counts.open.total).toBe(1);
      });

      it("returns present-but-empty arrays for requested sections — distinguishable from absent", async () => {
        const result = await buildTriage(fx.stores(), { section: "all" }, now);
        expect(result.open).toEqual([]);
        expect(result.recent).toEqual([]);
      });
    });

    describe("§10.8 since cursor", () => {
      it("applies since as a strict > cutoff max()ed with the window", async () => {
        // Window governs: since older than the window cutoff.
        fx.postEntry("artifact", "before window", {
          timestamp: "2026-07-12T00:00:00.000Z",
        });
        const inWindow = fx.postEntry("artifact", "in window", {
          timestamp: IN_WINDOW,
        });
        const windowGoverns = await buildTriage(
          fx.stores(),
          { since: "2026-07-10T00:00:00.000Z" },
          now,
        );
        expect(ids(windowGoverns.recent)).toEqual([inWindow]);

        // Since governs: strict > excludes the same-instant item.
        const after = fx.postEntry("artifact", "after cursor", {
          timestamp: IN_WINDOW_LATER,
        });
        fx.postEntry("need", "old open need", { timestamp: OUT_OF_WINDOW });
        const sinceGoverns = await buildTriage(
          fx.stores(),
          { since: IN_WINDOW },
          now,
        );
        expect(sinceGoverns.since).toBe(IN_WINDOW);
        expect(ids(sinceGoverns.recent)).toEqual([after]);
        // open is never windowed or since-filtered.
        expect(sinceGoverns.counts.open.total).toBe(1);
      });

      it("ignores unparseable since without echoing it", async () => {
        const result = await buildTriage(fx.stores(), { since: "not-a-date" }, now);
        expect("since" in result).toBe(false);
      });

      it("round-trips generated_at as the next since without re-returning same-instant items", async () => {
        const first = await buildTriage(fx.stores(), {}, now);
        expect(first.generated_at).toBe(NOW.toISOString());

        fx.postEntry("artifact", "same instant", {
          timestamp: NOW.toISOString(),
        });
        const afterCursor = fx.postEntry("artifact", "one ms later", {
          timestamp: new Date(NOW.getTime() + 1).toISOString(),
        });

        const later = () => new Date(NOW.getTime() + 3_600_000);
        const second = await buildTriage(
          fx.stores(),
          { since: first.generated_at },
          later,
        );
        expect(second.since).toBe(first.generated_at);
        expect(ids(second.recent)).toEqual([afterCursor]);
      });

      it("epoch-normalizes offset-form since against Z-form store timestamps", async () => {
        // 2026-07-22T10:00:00+02:00 === 2026-07-22T08:00:00Z. A raw string
        // comparison would exclude the 09:00Z artifact ("09" < "10").
        fx.postEntry("artifact", "at cutoff", {
          timestamp: "2026-07-22T08:00:00.000Z",
        });
        const justAfter = fx.postEntry("artifact", "just after", {
          timestamp: "2026-07-22T08:00:00.001Z",
        });
        const anHourAfter = fx.postEntry("artifact", "an hour after", {
          timestamp: "2026-07-22T09:00:00.000Z",
        });

        const offsetSince = "2026-07-22T10:00:00+02:00";
        const result = await buildTriage(fx.stores(), { since: offsetSince }, now);

        expect(result.since).toBe(offsetSince);
        expect(ids(result.recent).sort()).toEqual(
          [justAfter, anHourAfter].sort(),
        );
      });
    });

    describe("§10.9 for_agent", () => {
      it("excludes self-posted items across all four blackboard kinds, never decisions, matching the self-reported agent_id convention", async () => {
        const workerItems = {
          need: fx.postEntry("need", "worker need", { agent_id: "worker-1" }),
          question: fx.postEntry("question", "worker question", {
            agent_id: "worker-1",
          }),
          warning: fx.postEntry("warning", "worker warning", {
            agent_id: "worker-1",
          }),
          artifact: fx.postEntry("artifact", "worker artifact", {
            agent_id: "worker-1",
          }),
        };
        const mainItems = {
          need: fx.postEntry("need", "main need"),
          question: fx.postEntry("question", "main question"),
          warning: fx.postEntry("warning", "main warning"),
          artifact: fx.postEntry("artifact", "main artifact"),
        };
        const workerDecision = fx.writeDecision("worker decision", {
          status: "provisional",
          agent_id: "worker-1",
        });

        const forWorker = await buildTriage(
          fx.stores(),
          { for_agent: "worker-1" },
          now,
        );
        expect(forWorker.for_agent).toBe("worker-1");
        expect(ids(forWorker.open).sort()).toEqual(
          [
            mainItems.need,
            mainItems.question,
            mainItems.warning,
            workerDecision,
          ].sort(),
        );
        expect(ids(forWorker.recent)).toEqual([mainItems.artifact]);

        // The default "main" convention: for_agent "main" filters entries
        // posted without an explicit agent_id.
        const forMain = await buildTriage(
          fx.stores(),
          { for_agent: "main" },
          now,
        );
        expect(ids(forMain.open).sort()).toEqual(
          [
            workerItems.need,
            workerItems.question,
            workerItems.warning,
            workerDecision,
          ].sort(),
        );
        expect(ids(forMain.recent)).toEqual([workerItems.artifact]);
      });
    });

    describe("§10.10 ordering determinism", () => {
      it("matches the golden (timestamp, id) fixture including tie-breaks and the detail_preview boundary, and is poll-stable under a moved clock", async () => {
        // open (ascending, oldest first):
        const d1 = fx.writeDecision("ancient provisional", {
          status: "provisional",
          timestamp: "2026-07-02T00:00:00.000Z",
        });
        const n1 = fx.postEntry("need", "n1", {
          timestamp: "2026-07-18T00:00:00.000Z",
        });
        const q1 = fx.postEntry("question", "q1", {
          timestamp: "2026-07-19T00:00:00.000Z",
        });
        const w1 = fx.postEntry("warning", "w1", {
          timestamp: "2026-07-19T00:00:00.000Z", // tie with q1; higher id → second
        });
        // Raw length 240 > 200 but collapsed length 199 ≤ 200 → complete
        // preview, no detail_truncated (collapse-then-truncate, §4).
        const boundaryDetail = "word  ".repeat(40);
        const n2 = fx.postEntry("need", "n2 boundary preview", {
          timestamp: "2026-07-20T00:00:00.000Z",
          detail: boundaryDetail,
        });
        // recent (descending, newest first):
        const a1 = fx.writeDecision("older active", {
          status: "active",
          timestamp: "2026-07-19T06:00:00.000Z",
        });
        const r1 = fx.postEntry("artifact", "r1", {
          timestamp: "2026-07-21T00:00:00.000Z",
        });
        const r2 = fx.postEntry("artifact", "r2", {
          timestamp: "2026-07-21T00:00:00.000Z", // tie with r1; higher id → first
        });
        const a2 = fx.writeDecision("newest active", {
          status: "active",
          timestamp: "2026-07-22T00:00:00.000Z",
        });

        const result = await buildTriage(fx.stores(), {}, now);

        expect(ids(result.open)).toEqual([d1, n1, q1, w1, n2]);
        expect(ids(result.recent)).toEqual([a2, r2, r1, a1]);

        const boundaryItem = result.open!.find((i) => i.id === n2)!;
        expect(boundaryItem.detail_preview).toBe("word  ".repeat(40).replace(/\s+/g, " ").trim());
        expect(boundaryItem.detail_preview!.length).toBe(199);
        expect(boundaryItem.detail_truncated).toBeUndefined();

        // Poll-stability: ordering is a pure function of store contents —
        // a moved clock changes age_ms but never the order.
        const movedClock = () => new Date(NOW.getTime() + 2 * 3_600_000);
        const later = await buildTriage(fx.stores(), {}, movedClock);
        expect(ids(later.open)).toEqual(ids(result.open));
        expect(ids(later.recent)).toEqual(ids(result.recent));
      });
    });

    describe("§10.11 initialized-empty zero shape", () => {
      it("returns the exact zero-value shape field-for-field on an initialized empty store", async () => {
        const result = await buildTriage(fx.stores(), {}, now);

        expect(result).toStrictEqual({
          generated_at: NOW.toISOString(),
          window_ms: 604_800_000,
          section: "all",
          open: [],
          recent: [],
          counts: {
            open: {
              total: 0,
              irreversible: 0,
              by_kind: { decision: 0, need: 0, question: 0, warning: 0 },
            },
            recent: {
              total: 0,
              irreversible: 0,
              by_kind: { decision: 0, artifact: 0 },
            },
          },
        });
      });
    });

    describe("§10.12 window boundary + clock plumbing", () => {
      it("excludes items at the exact cutoff and includes 1ms past it (strict >) for artifacts and active decisions", async () => {
        fx.postEntry("artifact", "artifact at cutoff", {
          timestamp: WINDOW_CUTOFF,
        });
        const artifactIn = fx.postEntry("artifact", "artifact past cutoff", {
          timestamp: WINDOW_CUTOFF_PLUS_1MS,
        });
        fx.writeDecision("decision at cutoff", {
          status: "active",
          timestamp: WINDOW_CUTOFF,
        });
        const decisionIn = fx.writeDecision("decision past cutoff", {
          status: "active",
          timestamp: WINDOW_CUTOFF_PLUS_1MS,
        });

        const result = await buildTriage(fx.stores(), {}, now);

        expect(new Set(ids(result.recent))).toEqual(
          new Set([artifactIn, decisionIn]),
        );
      });

      it("computes age_ms EXACTLY as injectedNow − item.timestamp", async () => {
        // A far-future injected clock: an implementation hard-coding
        // Date.now() is off by ~4 years and must fail the exact equality.
        const farNow = new Date("2030-06-15T08:30:00.000Z");
        const age = 123_456_789;
        const ts = new Date(farNow.getTime() - age).toISOString();
        fx.postEntry("need", "aged need", { timestamp: ts });
        fx.writeDecision("aged provisional", {
          status: "provisional",
          timestamp: ts,
        });

        const result = await buildTriage(fx.stores(), {}, () => farNow);

        expect(result.generated_at).toBe(farNow.toISOString());
        expect(result.open).toHaveLength(2);
        for (const item of result.open!) {
          expect(item.age_ms).toBe(age);
        }
      });
    });

    describe("§10.13 scope filter", () => {
      it("matches bidirectionally in BOTH directions across decisions and blackboard kinds via the shared scopeMatches", async () => {
        const broadNeed = fx.postEntry("need", "broad", { scope: "src/" });
        const narrowNeed = fx.postEntry("need", "narrow", {
          scope: "src/auth/login/",
        });
        fx.postEntry("need", "elsewhere", { scope: "docs/" });
        const broadDecision = fx.writeDecision("broad decision", {
          status: "provisional",
          scope: "src/",
        });
        const narrowDecision = fx.writeDecision("narrow decision", {
          status: "provisional",
          scope: "src/auth/token/",
        });
        fx.writeDecision("out of scope", {
          status: "provisional",
          scope: "docs/",
        });

        const result = await buildTriage(fx.stores(), { scope: "src/auth/" }, now);

        expect(result.scope).toBe("src/auth/");
        expect(ids(result.open).sort()).toEqual(
          [broadNeed, narrowNeed, broadDecision, narrowDecision].sort(),
        );
      });

      it("EXCLUDES a decision matching only via affected_files (documented getByScope divergence)", async () => {
        fx.writeDecision("files-only match", {
          status: "provisional",
          scope: "docs/",
          affected_files: ["src/auth/login.ts"],
        });

        const result = await buildTriage(fx.stores(), { scope: "src/auth/" }, now);

        expect(result.open).toEqual([]);
        expect(result.counts.open.total).toBe(0);
      });

      it("treats scope: \"\" as absent — identical result to omitting the param, no echo", async () => {
        fx.postEntry("need", "a need", { scope: "src/" });
        fx.writeDecision("a decision", { status: "provisional", scope: "docs/" });

        const emptyScope = await buildTriage(fx.stores(), { scope: "" }, now);
        const omitted = await buildTriage(fx.stores(), {}, now);

        expect("scope" in emptyScope).toBe(false);
        expect(emptyScope).toStrictEqual(omitted);
        expect(emptyScope.counts.open.total).toBe(2);
      });
    });

    describe("input normalization (shared in buildTriage, §4.1)", () => {
      it("defaults window_ms <= 0 and treats empty-string for_agent as absent", async () => {
        const result = await buildTriage(
          fx.stores(),
          { window_ms: -1, for_agent: "" },
          now,
        );

        expect(result.window_ms).toBe(604_800_000);
        expect("for_agent" in result).toBe(false);
        expect(result.section).toBe("all");
      });

      it("applies window_ms: Infinity as an unbounded window (§4.1: > 0 is applied, no upper clamp)", async () => {
        fx.postEntry("artifact", "old artifact", { timestamp: OUT_OF_WINDOW });

        const result = await buildTriage(
          fx.stores(),
          { window_ms: Infinity },
          now,
        );

        // Engine-level echo is the applied value; the JSON adapters
        // serialize it as null (Infinity has no JSON representation).
        expect(result.window_ms).toBe(Infinity);
        // Unbounded: the out-of-window artifact is inside recent.
        expect(result.counts.recent.total).toBe(1);
      });

      it("defaults NaN window_ms (NaN is not > 0)", async () => {
        fx.postEntry("artifact", "old artifact", { timestamp: OUT_OF_WINDOW });

        const result = await buildTriage(fx.stores(), { window_ms: NaN }, now);

        expect(result.window_ms).toBe(604_800_000);
        expect(result.counts.recent.total).toBe(0);
      });
    });

    describe("detail_preview construction (§4)", () => {
      it("truncates when the collapsed string exceeds 200 and omits preview for empty detail", async () => {
        const long = fx.postEntry("need", "long need", {
          detail: "x".repeat(250),
        });
        const empty = fx.postEntry("need", "empty need", { detail: "" });

        const result = await buildTriage(fx.stores(), {}, now);

        const longItem = result.open!.find((i) => i.id === long)!;
        expect(longItem.detail_preview).toBe("x".repeat(200));
        expect(longItem.detail_truncated).toBe(true);
        const emptyItem = result.open!.find((i) => i.id === empty)!;
        expect("detail_preview" in emptyItem).toBe(false);
        expect("detail_truncated" in emptyItem).toBe(false);
      });
    });
  });
}
