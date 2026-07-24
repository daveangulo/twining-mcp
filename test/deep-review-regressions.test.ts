/**
 * Regressions for defects found in the 2026-07 deep review. Each test pins a
 * behavior the full suite was green through — the point is that these bugs
 * shipped while every existing test passed, so the tests below assert the
 * specific property that was missing rather than a broad happy path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextAssembler } from "../src/engine/context-assembler.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";
import { migrateReverse } from "../src/migrate/reverse.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { TwiningConfig } from "../src/utils/types.js";

let twiningDir: string;
let blackboardStore: BlackboardStore;
let decisionStore: DecisionStore;
let config: TwiningConfig;

beforeEach(() => {
  twiningDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-deep-review-"));
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
  fs.writeFileSync(
    path.join(twiningDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  blackboardStore = new BlackboardStore(twiningDir);
  decisionStore = new DecisionStore(twiningDir);
  config = { ...DEFAULT_CONFIG };
});

function assembler(): ContextAssembler {
  return new ContextAssembler(blackboardStore, decisionStore, null, config);
}

describe("assemble presents in score order, not store order", () => {
  it("leads with the highest-scoring decision regardless of store position", async () => {
    const engine = new DecisionEngine(
      decisionStore,
      new BlackboardEngine(blackboardStore),
    );
    // Confidence is a scoring input (weight 0.15: high=1.0, low=0.3) while
    // these are recorded milliseconds apart, so recency contributes ~equally
    // and confidence decides the ranking. The high-confidence decision is
    // written FIRST and the low-confidence one LAST, so whichever end of the
    // store the iteration starts from, presentation order can only be correct
    // if the score is actually applied.
    await engine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Well-researched choice",
      context: "ctx",
      rationale: "why",
      confidence: "high",
    });
    await engine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Middling choice",
      context: "ctx",
      rationale: "why",
      confidence: "medium",
    });
    await engine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Best guess",
      context: "ctx",
      rationale: "why",
      confidence: "low",
    });

    const ctx = await assembler().assemble("work on auth", "src/auth/");
    expect(ctx.active_decisions).toHaveLength(3);
    expect(ctx.active_decisions.map((d) => d.summary)).toEqual([
      "Well-researched choice",
      "Middling choice",
      "Best guess",
    ]);
  });
});

describe("assemble hides obligations another entry has resolved", () => {
  it("drops a resolved need and warning, including a cross-scope resolver", async () => {
    const bb = new BlackboardEngine(blackboardStore);
    const need = await bb.post({
      entry_type: "need",
      summary: "Migration script needed",
      detail: "d",
      scope: "src/db/",
      agent_id: "a1",
      tags: [],
    });
    const warn = await bb.post({
      entry_type: "warning",
      summary: "Connection pool leaks under load",
      detail: "d",
      scope: "src/db/",
      agent_id: "a1",
      tags: [],
    });
    // Resolver posted against a DIFFERENT scope — the reason resolution must be
    // computed from the whole board rather than the scope slice.
    await bb.post({
      entry_type: "status",
      summary: "Wrote the migration and replaced the pool",
      detail: "d",
      scope: "src/api/",
      agent_id: "a2",
      tags: [],
      relates_to: [need.id, warn.id],
    });

    const ctx = await assembler().assemble("touch db", "src/db/");
    expect(ctx.open_needs.map((n) => n.id)).not.toContain(need.id);
    expect(ctx.active_warnings.map((w) => w.id)).not.toContain(warn.id);
  });

  it("still surfaces an unresolved need", async () => {
    const bb = new BlackboardEngine(blackboardStore);
    const need = await bb.post({
      entry_type: "need",
      summary: "Still open work",
      detail: "d",
      scope: "src/db/",
      agent_id: "a1",
      tags: [],
    });
    const ctx = await assembler().assemble("touch db", "src/db/");
    expect(ctx.open_needs.map((n) => n.id)).toContain(need.id);
  });
});

describe("assemble never claims 'no constraints' when warnings were dropped", () => {
  it("reports omitted warnings instead of an all-clear", async () => {
    const bb = new BlackboardEngine(blackboardStore);
    const big = "x".repeat(4000);
    for (let i = 0; i < 6; i++) {
      await bb.post({
        entry_type: "warning",
        summary: `Warning ${i}`,
        detail: big,
        scope: "src/auth/",
        agent_id: "a1",
        tags: [],
      });
    }

    // A budget too small for the details forces the degrade/drop path.
    const ctx = await assembler().assemble("work", "src/auth/", 120);
    const shown = ctx.active_warnings.length;
    const omitted = ctx.warnings_omitted ?? 0;
    expect(shown + omitted).toBe(6);

    const text = ContextAssembler.formatForLLM(ctx);
    if (omitted > 0) {
      expect(text).not.toContain("No prior context constraints");
      expect(text).not.toBe(`No prior context for scope: ${ctx.scope}`);
      expect(text).toMatch(/warning/i);
    }
  });

  it("degrades an oversized warning to summary-only rather than dropping it", async () => {
    const bb = new BlackboardEngine(blackboardStore);
    await bb.post({
      entry_type: "warning",
      summary: "Short but critical",
      detail: "y".repeat(8000),
      scope: "src/auth/",
      agent_id: "a1",
      tags: [],
    });
    const ctx = await assembler().assemble("work", "src/auth/", 200);
    expect(ctx.active_warnings).toHaveLength(1);
    expect(ctx.active_warnings[0].summary).toBe("Short but critical");
    expect(ctx.active_warnings[0].detail).toBe("");
  });
});

describe("why() hides non-authoritative decisions", () => {
  it("excludes overridden and archived decisions by default", async () => {
    const engine = new DecisionEngine(
      decisionStore,
      new BlackboardEngine(blackboardStore),
    );
    const live = await engine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Live decision",
      context: "c",
      rationale: "r",
    });
    const gone = await engine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Rejected decision",
      context: "c",
      rationale: "r",
    });
    const shelved = await engine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Shelved decision",
      context: "c",
      rationale: "r",
    });
    await decisionStore.updateStatus(gone.id, "overridden");
    await decisionStore.updateStatus(shelved.id, "archived");

    const why = await engine.why("src/auth/");
    const surfaced = [
      ...why.decisions.map((d) => d.id),
      ...(why.more ?? []).map((d) => d.id),
    ];
    expect(surfaced).toContain(live.id);
    expect(surfaced).not.toContain(gone.id);
    expect(surfaced).not.toContain(shelved.id);
    expect(why.superseded_count).toBe(2);
  });
});

describe("reverse migrate refuses to wipe the file backend", () => {
  it("throws when export_records is off and no database exists", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-rev-guard-"),
    );
    const dir = path.join(projectRoot, ".twining");
    fs.mkdirSync(path.join(dir, "records", "posts"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      "version: 2\nproject_name: t\nstorage:\n  backend: sqlite\n  export_records: false\n",
    );
    // records/ exists, twining.db does not — previously this created an empty
    // database and exported nothing over the file backend, exiting 0.
    await expect(migrateReverse({ projectRoot, dryRun: false })).rejects.toThrow(
      /export_records is disabled/,
    );
  });
});
