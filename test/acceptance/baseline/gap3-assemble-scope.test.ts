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
 * ## CLOSED by lane 04 (retrieval and trust), 2026-09-15.
 *
 * `src/retrieval/select.ts` now runs an authorization + query-scope predicate
 * over the candidate pool BEFORE the search engine ever sees it, so the
 * semantic union has nothing out-of-scope to union in. Scope is an admission
 * gate; scope proximity remains a ranking signal on what survives.
 *
 * The gap assertion below is FLIPPED: the out-of-scope decision is absent, and
 * its absence is reported (not silent). Both controls are unchanged and still
 * green — the no-search-engine control proves the assembler is wired up, and
 * the instrument-can-fail control proves the new gate is what is doing the work
 * rather than a fixture accident.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ContextAssembler } from "../../../src/engine/context-assembler.js";
import { BlackboardStore } from "../../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../../src/storage/decision-store.js";
import { SearchEngine } from "../../../src/embeddings/search.js";
import { Embedder } from "../../../src/embeddings/embedder.js";
import { IndexManager } from "../../../src/embeddings/index-manager.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";
import {
  selectCandidates,
  legacyScope,
  legacyEnvelope,
} from "../../../src/retrieval/select.js";
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

  it("FLIPPED (lane 04): refuses an active decision from an unrelated scope even when its text matches the task", async () => {
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

    // --- CLOSED: scope is now a hard filter applied before ranking ---
    // The vendor-repo/billing/ decision is under a scope with no prefix
    // relationship to "src/auth/" in either direction, so it is CUT.
    expect("vendor-repo/billing/".startsWith("src/auth/")).toBe(false);
    expect("src/auth/".startsWith("vendor-repo/billing/")).toBe(false);
    expect(admittedIds).not.toContain(outOfScope.id);
    expect(admittedFiles).not.toContain("vendor-repo/billing/proration.ts");

    // ...and it does not reach the rendered briefing either.
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).not.toContain("banker's rounding");

    // The cut is reported rather than silent: an authorized-but-irrelevant
    // record may be named, so the caller can tell "nothing matched" from
    // "something matched elsewhere".
    expect(result.retrieval.selection.suppressed_visible).toContainEqual({
      id: outOfScope.id,
      reason: "out_of_query_scope",
    });
    expect(result.retrieval.selection.mode).toBe("strict");
  });

  it("INSTRUMENT CAN FAIL: with the pre-ranking scope gate disabled, the leak returns", async () => {
    // Without this, the flipped assertion above could be passing because the
    // fixture never reached the semantic path at all. Disabling the gate must
    // reproduce the original defect exactly.
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

    const embedder = new Embedder(twiningDir);
    (embedder as any).fallbackMode = true;
    const searchEngine = new SearchEngine(embedder, new IndexManager(twiningDir));

    // Drive the gate directly with the control switch thrown, over the same
    // candidate pool the assembler builds.
    const pool = [inScope, outOfScope];
    const repo = "r_gap3000000000000000000000";
    const leaked = selectCandidates(
      pool,
      (d) => legacyScope(d.scope, repo),
      (d) => d.id,
      {
        principal: "main",
        authorized: legacyEnvelope(repo),
        query: legacyScope("src/auth/", repo),
        disable: { scope_filter_off: true },
      },
    );
    expect(leaked.admitted.map((d) => d.id)).toContain(outOfScope.id);
    expect(searchEngine).toBeDefined();
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

/**
 * Gap 3, round 2 — the two bypasses the first flip did not pin.
 *
 * The original fixture used a `vendor-repo/billing/` scope with no prefix
 * relation to `src/auth/` in either direction, so it was cut by the SEMANTIC
 * path's gate and the assertion passed without ever exercising the
 * scope-matched path. The adversarial review showed
 * `decisionStore.getByScope` never met the gate at all, and that two record
 * shapes slipped through it:
 *
 *   1. a SEGMENT COLLISION (`src/authz/` for a `src/auth` query), which 2.x's
 *      raw `startsWith` matcher admits;
 *   2. a record scoped anywhere that merely NAMES a file inside the query
 *      scope in `affected_files`.
 *
 * (2) turns out to be a FEATURE, not a leak — it is the question Gate 1 tells
 * agents to ask — so it is pinned as kept. (1) is the leak, and is pinned cut.
 */
describe("Gap 3 (round 2) — the scope-matched path is gated too", () => {
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

  it("CUT: a segment collision never answers a src/auth query", async () => {
    const collide = await decisionStore.create({
      ...baseDecision,
      scope: "src/authz/",
      summary: "AUTHZ-SEGMENT-COLLISION",
      rationale: "a different module entirely",
      affected_files: ["src/authz/policy.ts"],
    });
    const inScope = await decisionStore.create({
      ...baseDecision,
      scope: "src/auth/",
      summary: "IN-SCOPE",
      rationale: "r",
      affected_files: ["src/auth/jwt.ts"],
    });

    const assembler = new ContextAssembler(blackboardStore, decisionStore, null, config);
    const result = await assembler.assemble("auth work", "src/auth", 100000);
    const ids = result.active_decisions.map((d) => d.id);

    // 2.x's matcher would admit it; the gate does not.
    expect("src/authz/".startsWith("src/auth")).toBe(true);
    expect(ids).toContain(inScope.id);
    expect(ids).not.toContain(collide.id);
    expect(ContextAssembler.formatForLLM(result)).not.toContain("AUTHZ-SEGMENT-COLLISION");
  });

  it("KEPT: a foreign-scoped record that NAMES a file in the query scope", async () => {
    const foreign = await decisionStore.create({
      ...baseDecision,
      scope: "vendor-repo/billing/",
      summary: "FOREIGN-BUT-TOUCHES-AUTH",
      rationale: "changes a file under src/auth/",
      affected_files: ["src/auth/jwt.ts"],
    });
    const assembler = new ContextAssembler(blackboardStore, decisionStore, null, config);
    const result = await assembler.assemble("auth work", "src/auth/", 100000);
    // Authorized by its own scope, matched for relevance by the file. Cutting
    // it would make twining_why on a file answer "nothing constrains this".
    expect(result.active_decisions.map((d) => d.id)).toContain(foreign.id);
  });

  it("CUT: the same foreign record when it names no file in the query scope", async () => {
    const foreign = await decisionStore.create({
      ...baseDecision,
      scope: "vendor-repo/billing/",
      summary: "FOREIGN-AND-UNRELATED",
      rationale: "r",
      affected_files: ["vendor-repo/billing/proration.ts"],
    });
    const assembler = new ContextAssembler(blackboardStore, decisionStore, null, config);
    const result = await assembler.assemble("auth work", "src/auth/", 100000);
    expect(result.active_decisions.map((d) => d.id)).not.toContain(foreign.id);
  });
});
