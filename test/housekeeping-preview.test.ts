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

    const preview = await engine.run({ execute: false });

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

    const preview = await engine.run({ execute: false });
    const execute = await engine.run({ execute: true });

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

    const preview = await engine.run({ execute: false });

    expect(preview.dangling_warnings.count).toBe(1);
    expect(preview.dangling_warnings.items[0]!.summary).toBe("Open warning");
  });

  it("reports how many open needs/warnings the archive pass kept (#40)", async () => {
    seedEntry("need", "Open need", OLD);
    seedEntry("warning", "Open warning", OLD);
    seedEntry("finding", "Old finding", OLD);

    const preview = await engine.run({ execute: false });
    expect(preview.archived.kept_open).toBe(2);

    const execute = await engine.run({ execute: true });
    expect(execute.archived.kept_open).toBe(2);
    expect(execute.archived.count).toBe(1);

    // The open entries survived execute.
    const { entries } = await blackboardStore.read();
    const types = entries.map((e) => e.entry_type).sort();
    expect(types).toContain("need");
    expect(types).toContain("warning");
  });
});
