/**
 * Gap 3 — assemble scope is not a hard filter (requirements R01, R13, R14).
 *
 * Baseline reproduction. `ContextAssembler.assemble(task, scope)` unions two
 * candidate sets for decisions: the scope-matched set
 * (`decisionStore.getByScope(scope)`) and a *semantic* set produced by
 * `SearchEngine.searchDecisions(task, <every active decision in the store>)`.
 * The semantic union has no scope predicate and — unlike blackboard entries,
 * which are gated by SEMANTIC_ADMISSION_FLOOR — no relevance floor either.
 * So an active decision recorded under a completely unrelated scope is
 * admitted into `active_decisions` purely because its text matches the task
 * string. Scope is only a *ranking* signal (scopeProximity dampening), never
 * an admission gate.
 *
 * Positive control: the in-scope decision is present (the instrument works and
 * the assembler is wired up correctly).
 * Gap assertion: the out-of-scope decision is ALSO present.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ContextAssembler } from "../../../src/engine/context-assembler.js";
import { BlackboardStore } from "../../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../../src/storage/decision-store.js";
import { SearchEngine } from "../../../src/embeddings/search.js";
import { Embedder } from "../../../src/embeddings/embedder.js";
import { IndexManager } from "../../../src/embeddings/index-manager.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";
import type { TwiningConfig } from "../../../src/utils/types.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function makeTwiningDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap3-scope-"));
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "embeddings"), { recursive: true });
  fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
  fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
  fs.writeFileSync(
    path.join(dir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  return dir;
}

function makeConfig(overrides?: Partial<TwiningConfig>): TwiningConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const baseDecision = {
  agent_id: "test",
  domain: "implementation" as const,
  context: "ctx",
  constraints: [],
  alternatives: [],
  depends_on: [],
  confidence: "high" as const,
  reversible: true,
  affected_symbols: [],
};

describe("Gap 3 — assemble() scope is not a hard filter (R01, R13, R14)", () => {
  let twiningDir: string;
  let blackboardStore: BlackboardStore;
  let decisionStore: DecisionStore;
  let config: TwiningConfig;

  beforeEach(() => {
    twiningDir = makeTwiningDir();
    blackboardStore = new BlackboardStore(twiningDir);
    decisionStore = new DecisionStore(twiningDir);
    config = makeConfig();
    Embedder.resetInstances();
  });

  it("admits an active decision from an unrelated scope when its text matches the task", async () => {
    // In-scope decision. Deliberately shares NO distinctive vocabulary with
    // the task string, so its admission can only come from scope matching.
    const inScope = await decisionStore.create({
      ...baseDecision,
      scope: "src/auth/",
      summary: "Use JWT for auth",
      rationale: "Enables horizontal scaling",
      affected_files: ["src/auth/jwt.ts"],
    });

    // Out-of-scope decision in a completely unrelated part of the tree, whose
    // summary/rationale strongly match the task string.
    const outOfScope = await decisionStore.create({
      ...baseDecision,
      scope: "vendor-repo/billing/",
      summary: "Proration rounding uses banker's rounding for invoice totals",
      rationale:
        "Proration rounding drift across invoice totals reconciles cleanly with banker's rounding",
      affected_files: ["vendor-repo/billing/proration.ts"],
    });

    // Keyword-fallback search engine (no ONNX model needed).
    const embedder = new Embedder(twiningDir);
    (embedder as any).fallbackMode = true;
    const searchEngine = new SearchEngine(embedder, new IndexManager(twiningDir));

    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      searchEngine,
      config,
    );

    const task = "proration rounding drift across invoice totals";
    const result = await assembler.assemble(task, "src/auth/");

    const admittedIds = result.active_decisions.map((d) => d.id);
    // The projected decision shape carries no `scope` field, so the off-scope
    // origin is observed through the files it names instead.
    const admittedFiles = result.active_decisions.flatMap(
      (d) => d.affected_files,
    );

    // --- POSITIVE CONTROL: the instrument works ---
    // The in-scope decision is assembled, so the stores, search engine and
    // assembler are wired correctly and the budget is not starving the lane.
    expect(admittedIds).toContain(inScope.id);

    // --- GAP: scope was not applied as a hard filter before ranking ---
    // The vendor-repo/billing/ decision is under a scope with no prefix
    // relationship to "src/auth/" in either direction, yet it is admitted.
    expect("vendor-repo/billing/".startsWith("src/auth/")).toBe(false);
    expect("src/auth/".startsWith("vendor-repo/billing/")).toBe(false);
    expect(admittedIds).toContain(outOfScope.id);
    expect(admittedFiles).toContain("vendor-repo/billing/proration.ts");

    // And it reaches the rendered briefing the agent actually reads.
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).toContain("banker's rounding");
  });

  it("control: with no search engine the out-of-scope decision is correctly excluded", async () => {
    // Isolates the admission path: the ONLY route by which the out-of-scope
    // decision enters is the unfiltered semantic union. Remove the search
    // engine and scope behaves as a hard filter — which is what the gap says
    // should also hold when a search engine is present.
    const inScope = await decisionStore.create({
      ...baseDecision,
      scope: "src/auth/",
      summary: "Use JWT for auth",
      rationale: "Enables horizontal scaling",
      affected_files: ["src/auth/jwt.ts"],
    });
    const outOfScope = await decisionStore.create({
      ...baseDecision,
      scope: "vendor-repo/billing/",
      summary: "Proration rounding uses banker's rounding for invoice totals",
      rationale:
        "Proration rounding drift across invoice totals reconciles cleanly with banker's rounding",
      affected_files: ["vendor-repo/billing/proration.ts"],
    });

    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      null,
      config,
    );

    const result = await assembler.assemble(
      "proration rounding drift across invoice totals",
      "src/auth/",
    );
    const admittedIds = result.active_decisions.map((d) => d.id);

    expect(admittedIds).toContain(inScope.id);
    expect(admittedIds).not.toContain(outOfScope.id);
  });
});
