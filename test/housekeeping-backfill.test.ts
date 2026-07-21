/**
 * Housekeeping superseded_by backfill pass (#31).
 *
 * Decisions recorded before the back-link existed flipped their target's
 * status to "superseded" but never wrote superseded_by. The backfill pass
 * scans decisions carrying a supersedes link and writes the missing
 * back-link onto their targets — preview reports, execute applies, and
 * dangling targets (supersedes of since-deleted decisions) are counted
 * but never fabricated.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionStore } from "../src/storage/decision-store.js";
import { HousekeepingEngine } from "../src/engine/housekeeping.js";
import type { Archiver } from "../src/engine/archiver.js";
import type { IBlackboardStore } from "../src/storage/interfaces.js";
import type { Decision } from "../src/utils/types.js";

let tmpDir: string;
let decisionStore: DecisionStore;
let engine: HousekeepingEngine;

const stubBlackboardStore: IBlackboardStore = {
  append: async () => {
    throw new Error("not used");
  },
  read: async () => ({ entries: [], total_count: 0 }),
  recent: async () => [],
  dismiss: async () => ({ dismissed: [], not_found: [] }),
};

const stubArchiver = {
  archive: async () => ({ archived_count: 0, archive_file: "", kept_open_count: 0 }),
  plan: async () => ({ to_archive: [], kept_open_count: 0, cutoff: "" }),
} as unknown as Archiver;

function decisionInput(
  summary: string,
  overrides: Partial<Decision> = {},
): Omit<Decision, "id" | "timestamp" | "status"> {
  return {
    agent_id: "main",
    domain: "architecture",
    scope: "src/",
    summary,
    context: "ctx",
    rationale: "because",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    reversible: true,
    affected_files: [],
    affected_symbols: [],
    commit_hashes: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-hk-backfill-"));
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  decisionStore = new DecisionStore(tmpDir);
  engine = new HousekeepingEngine(
    tmpDir,
    stubBlackboardStore,
    decisionStore,
    stubArchiver,
    null,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("housekeeping superseded_by backfill", () => {
  it("preview reports missing back-links without writing them", async () => {
    const a = await decisionStore.create(decisionInput("old decision"));
    await decisionStore.updateStatus(a.id, "superseded");
    const b = await decisionStore.create(
      decisionInput("new decision", { supersedes: a.id }),
    );

    const result = await engine.run({});
    expect(result.dry_run).toBe(true);
    expect(result.superseded_backfill.fixed).toBe(1);
    expect(result.superseded_backfill.dangling).toBe(0);
    expect(result.superseded_backfill.items).toEqual([
      { id: a.id, superseded_by: b.id },
    ]);
    expect(result.summary).toContain("backfill 1 superseded_by back-link");

    // Nothing written in preview.
    const stored = await decisionStore.get(a.id);
    expect(stored!.superseded_by).toBeUndefined();
  });

  it("execute writes the back-link and preserves the target's status", async () => {
    const a = await decisionStore.create(decisionInput("old decision"));
    await decisionStore.updateStatus(a.id, "superseded");
    const b = await decisionStore.create(
      decisionInput("new decision", { supersedes: a.id }),
    );

    const result = await engine.run({ execute: true });
    expect(result.superseded_backfill.fixed).toBe(1);

    const stored = await decisionStore.get(a.id);
    expect(stored!.superseded_by).toBe(b.id);
    expect(stored!.status).toBe("superseded");
  });

  it("does not retire an active target — backfill only writes the pointer", async () => {
    // Historical edge: target was re-promoted (or never flipped). The backfill
    // writes the missing pointer but does not relitigate status.
    const a = await decisionStore.create(decisionInput("still active"));
    const b = await decisionStore.create(
      decisionInput("claims to supersede", { supersedes: a.id }),
    );

    await engine.run({ execute: true });

    const stored = await decisionStore.get(a.id);
    expect(stored!.superseded_by).toBe(b.id);
    expect(stored!.status).toBe("active");
  });

  it("counts dangling supersedes targets and skips them", async () => {
    await decisionStore.create(
      decisionInput("points at a ghost", {
        supersedes: "01GHOST00000000000000000000",
      }),
    );

    const result = await engine.run({ execute: true });
    expect(result.superseded_backfill.fixed).toBe(0);
    expect(result.superseded_backfill.dangling).toBe(1);
    expect(result.summary).toContain("1 dangling supersedes target");
  });

  it("skips targets whose back-link is already set and reports nothing on a clean rerun", async () => {
    const a = await decisionStore.create(decisionInput("old decision"));
    await decisionStore.create(
      decisionInput("new decision", { supersedes: a.id }),
    );

    await engine.run({ execute: true });
    const rerun = await engine.run({ execute: true });
    expect(rerun.superseded_backfill.fixed).toBe(0);
    expect(rerun.superseded_backfill.dangling).toBe(0);
    expect(rerun.superseded_backfill.items).toEqual([]);
  });

  it("when two decisions supersede the same target, the newest supersessor wins", async () => {
    const a = await decisionStore.create(decisionInput("contested target"));
    await decisionStore.create(
      decisionInput("older supersessor", { supersedes: a.id }),
    );
    const c = await decisionStore.create(
      decisionInput("newer supersessor", { supersedes: a.id }),
    );

    const result = await engine.run({ execute: true });
    expect(result.superseded_backfill.fixed).toBe(1);
    const stored = await decisionStore.get(a.id);
    expect(stored!.superseded_by).toBe(c.id);
  });
});
