/**
 * Housekeeping preview/execute parity (#39) and the open-needs/warnings
 * archive exemption as seen through housekeeping (#40).
 *
 * Preview must predict what execute will do: pass 1 (archive) previously ran
 * only under execute, so preview computed dedup and dangling warnings on
 * pre-archive state and its counts were non-binding — the field run that
 * motivated #39 reported 44 dedups in preview and 0 in execute.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { Archiver } from "../src/engine/archiver.js";
import { HousekeepingEngine } from "../src/engine/housekeeping.js";
import { GraphEngine } from "../src/engine/graph.js";
import { GraphStore } from "../src/storage/graph-store.js";
import type { IGraphStore } from "../src/storage/interfaces.js";
import type { BlackboardEntry } from "../src/utils/types.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let engine: HousekeepingEngine;

const OLD = "2025-01-01T00:00:00.000Z";

function seedEntry(
  type: string,
  summary: string,
  timestamp: string,
  extra: Partial<BlackboardEntry> = {},
): string {
  const entry = {
    id: `test-${Math.random().toString(36).slice(2, 10)}`,
    timestamp,
    agent_id: "test",
    entry_type: type,
    tags: ["test"],
    scope: "project",
    summary,
    detail: "",
    ...extra,
  };
  fs.appendFileSync(
    path.join(tmpDir, "blackboard.jsonl"),
    JSON.stringify(entry) + "\n",
  );
  return entry.id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-hk-preview-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  blackboardStore = new BlackboardStore(tmpDir);
  const decisionStore = new DecisionStore(tmpDir);
  const blackboardEngine = new BlackboardEngine(blackboardStore);
  const archiver = new Archiver(tmpDir, blackboardStore, blackboardEngine, null);
  engine = new HousekeepingEngine(
    tmpDir,
    blackboardStore,
    decisionStore,
    archiver,
    null,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("housekeeping preview/execute parity (#39)", () => {
  it("preview predicts the archive count without touching the store", async () => {
    seedEntry("finding", "Old finding A", OLD);
    seedEntry("finding", "Old finding B", OLD);

    const preview = await engine.run({ execute: false, archive: true });

    expect(preview.dry_run).toBe(true);
    expect(preview.archived.count).toBe(2);
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(2);
    expect(fs.existsSync(path.join(tmpDir, "archive"))).toBe(false);
  });

  it("preview counts match execute counts on identical state", async () => {
    // Two old findings: absorbed by the archive pass (they are also dupes —
    // the field bug was preview counting these as dedup candidates).
    seedEntry("finding", "Duplicate finding", OLD);
    seedEntry("finding", "Duplicate finding", OLD);
    // Two open needs with the same key: exempt from archive (#40), so the
    // dedup pass is what removes one of them — in BOTH preview and execute.
    seedEntry("need", "Open duplicate need", OLD);
    seedEntry("need", "Open duplicate need", OLD);

    const preview = await engine.run({ execute: false, archive: true });
    const execute = await engine.run({ execute: true, archive: true });

    expect(preview.archived.count).toBe(execute.archived.count);
    expect(preview.deduplicated.removed).toBe(execute.deduplicated.removed);
    // The archive pass absorbs the duplicate findings; dedup only sees the
    // surviving needs.
    expect(execute.archived.count).toBe(2);
    expect(execute.deduplicated.removed).toBe(1);
  });

  it("preview dangling warnings reflect post-archive state", async () => {
    // Unresolved warning: exempt from archive, should be reported.
    seedEntry("warning", "Open warning", OLD);
    // Resolved warning: gets archived, should NOT be reported as dangling.
    const resolvedId = seedEntry("warning", "Resolved warning", OLD);
    seedEntry("status", "Fixed it", "2025-01-02T00:00:00.000Z", {
      relates_to: [resolvedId],
    });

    const preview = await engine.run({ execute: false, archive: true });

    expect(preview.dangling_warnings.count).toBe(1);
    expect(preview.dangling_warnings.items[0]!.summary).toBe("Open warning");
  });

  it("reports how many open needs/warnings the archive pass kept (#40)", async () => {
    seedEntry("need", "Open need", OLD);
    seedEntry("warning", "Open warning", OLD);
    seedEntry("finding", "Old finding", OLD);

    const preview = await engine.run({ execute: false, archive: true });
    expect(preview.archived.kept_open).toBe(2);

    const execute = await engine.run({ execute: true, archive: true });
    expect(execute.archived.kept_open).toBe(2);
    expect(execute.archived.count).toBe(1);

    // The open entries survived execute.
    const { entries } = await blackboardStore.read();
    const types = entries.map((e) => e.entry_type).sort();
    expect(types).toContain("need");
    expect(types).toContain("warning");
  });
});

describe("relation dedup wiring — never a silent no-op", () => {
  function buildEngine(graphEngine: GraphEngine | null): HousekeepingEngine {
    const decisionStore = new DecisionStore(tmpDir);
    const blackboardEngine = new BlackboardEngine(blackboardStore);
    const archiver = new Archiver(tmpDir, blackboardStore, blackboardEngine, null);
    return new HousekeepingEngine(
      tmpDir,
      blackboardStore,
      decisionStore,
      archiver,
      graphEngine,
    );
  }

  it("reports relation_dedup_error when no graph engine is configured", async () => {
    const result = await engine.run({ dedup_relations: true });
    expect(result.relation_dedup).toBeUndefined();
    expect(result.relation_dedup_error).toMatch(/no graph engine/);
  });

  it("reports relation_dedup_error when the pass crashes", async () => {
    const exploding = {
      getRelations: async () => {
        throw new Error("graph store exploded");
      },
    } as unknown as IGraphStore;
    const hk = buildEngine(new GraphEngine(exploding));
    const result = await hk.run({ dedup_relations: true });
    expect(result.relation_dedup).toBeUndefined();
    expect(result.relation_dedup_error).toBe("graph store exploded");
  });

  it("attaches the report when a graph engine exists", async () => {
    const hk = buildEngine(new GraphEngine(new GraphStore(tmpDir)));
    const result = await hk.run({ dedup_relations: true });
    expect(result.relation_dedup_error).toBeUndefined();
    expect(result.relation_dedup).toEqual({
      duplicate_groups: 0,
      duplicate_relations: 0,
      removed: 0,
      skipped_id_collisions: 0,
      failed_groups: 0,
      errors: [],
      by_type: {},
    });
  });
});

describe("promote_provisionals attribution (D15)", () => {
  it("stamps promoted_by/promoted_at on bulk-promoted records", async () => {
    const id = "stale-prov-1";
    const record = {
      id,
      timestamp: OLD,
      agent_id: "test",
      domain: "implementation",
      scope: "src/x/",
      summary: "stale provisional awaiting ratification",
      context: "c",
      rationale: "r",
      alternatives: [],
      depends_on: [],
      confidence: "medium",
      status: "provisional",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
      commit_hashes: [],
    };
    fs.writeFileSync(
      path.join(tmpDir, "decisions", `${id}.json`),
      JSON.stringify(record, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpDir, "decisions", "index.json"),
      JSON.stringify([
        {
          id,
          timestamp: OLD,
          domain: "implementation",
          scope: "src/x/",
          summary: record.summary,
          confidence: "medium",
          status: "provisional",
          affected_files: [],
          affected_symbols: [],
          commit_hashes: [],
        },
      ]),
    );

    const result = await engine.run({ promote_provisionals: true, execute: true });
    expect(result.promoted_provisionals.ids).toEqual([id]);

    const after = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "decisions", `${id}.json`), "utf-8"),
    );
    expect(after.status).toBe("active");
    expect(after.promoted_by).toBe("housekeeping-promote_provisionals");
    expect(after.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
