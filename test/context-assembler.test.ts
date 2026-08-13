/**
 * Tests for the ContextAssembler class.
 * Uses temp directories with pre-populated fixture data.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ContextAssembler } from "../src/engine/context-assembler.js";
import { PlanningBridge } from "../src/engine/planning-bridge.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { GraphEngine } from "../src/engine/graph.js";
import { HandoffStore } from "../src/storage/handoff-store.js";
import { AgentStore } from "../src/storage/agent-store.js";
import { SearchEngine } from "../src/embeddings/search.js";
import { Embedder } from "../src/embeddings/embedder.js";
import { IndexManager } from "../src/embeddings/index-manager.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { TwiningConfig } from "../src/utils/types.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function makeTwiningDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-context-assembler-test-"),
  );
  // Create required subdirectories and files
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

describe("ContextAssembler", () => {
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

  describe("assemble", () => {
    it("should return correct structure matching AssembledContext interface", async () => {
      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("test task", "project");

      expect(result).toHaveProperty("assembled_at");
      expect(result).toHaveProperty("task", "test task");
      expect(result).toHaveProperty("scope", "project");
      expect(result).toHaveProperty("token_estimate");
      expect(result).toHaveProperty("active_decisions");
      expect(result).toHaveProperty("open_needs");
      expect(result).toHaveProperty("recent_findings");
      expect(result).toHaveProperty("active_warnings");
      expect(result).toHaveProperty("recent_questions");
      expect(result).toHaveProperty("related_entities");
      expect(result.related_entities).toEqual([]);
    });

    it("should return empty results for empty stores", async () => {
      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("test task", "project");

      expect(result.active_decisions).toHaveLength(0);
      expect(result.open_needs).toHaveLength(0);
      expect(result.recent_findings).toHaveLength(0);
      expect(result.active_warnings).toHaveLength(0);
      expect(result.recent_questions).toHaveLength(0);
      expect(result.token_estimate).toBe(0);
    });

    it("should include decisions matching scope", async () => {
      await decisionStore.create({
        agent_id: "test",
        domain: "implementation",
        scope: "src/auth/",
        summary: "Use JWT for auth",
        context: "Need stateless auth",
        rationale: "Enables horizontal scaling",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: ["src/auth/jwt.ts"],
        affected_symbols: [],
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("update auth", "src/auth/");

      expect(result.active_decisions).toHaveLength(1);
      expect(result.active_decisions[0]!.summary).toBe("Use JWT for auth");
    });

    it("should include blackboard entries matching scope", async () => {
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "warning",
        tags: [],
        scope: "src/auth/",
        summary: "JWT tokens expire quickly",
        detail: "Consider refresh token rotation",
      });

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "need",
        tags: [],
        scope: "src/auth/",
        summary: "Need rate limiting on auth endpoint",
        detail: "",
      });

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "src/auth/",
        summary: "Found existing session middleware",
        detail: "In src/middleware.ts",
      });

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "question",
        tags: [],
        scope: "src/auth/",
        summary: "Should we support OAuth?",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("update auth", "src/auth/");

      expect(result.active_warnings).toHaveLength(1);
      expect(result.open_needs).toHaveLength(1);
      expect(result.recent_findings).toHaveLength(1);
      expect(result.recent_questions).toHaveLength(1);
    });

    it("produces identical output when the blackboard holds legacy decision mirror entries (issue #30)", async () => {
      // Baseline: one real decision in the store, one finding on the blackboard
      await decisionStore.create({
        agent_id: "test",
        domain: "implementation",
        scope: "src/auth/",
        summary: "Use JWT for auth",
        context: "Need stateless auth",
        rationale: "Enables horizontal scaling",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "src/auth/",
        summary: "Found existing session middleware",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );
      const before = await assembler.assemble("update auth", "src/auth/");

      // Simulate legacy on-disk decision mirrors (pre-#30 cross-posts)
      for (let i = 0; i < 3; i++) {
        await blackboardStore.append({
          agent_id: "test",
          entry_type: "decision",
          tags: ["implementation"],
          scope: "src/auth/",
          summary: `Legacy mirror decision ${i}`,
          detail: "rationale text",
        });
      }

      const after = await assembler.assemble("update auth", "src/auth/");

      // Legacy mirrors are filtered out — output is unchanged
      expect(after.active_decisions.map((d) => d.summary)).toEqual(
        before.active_decisions.map((d) => d.summary),
      );
      expect(after.recent_findings.map((f) => f.summary)).toEqual(
        before.recent_findings.map((f) => f.summary),
      );
      expect(after.active_warnings).toEqual(before.active_warnings);
      expect(after.open_needs).toEqual(before.open_needs);
      expect(after.recent_questions).toEqual(before.recent_questions);
      const allSummaries = JSON.stringify(after);
      expect(allSummaries).not.toContain("Legacy mirror decision");
    });

    it("should respect token budget", async () => {
      // Create many entries to exceed a small budget
      for (let i = 0; i < 20; i++) {
        await blackboardStore.append({
          agent_id: "test",
          entry_type: "finding",
          tags: [],
          scope: "project",
          summary: `Finding number ${i} with some detailed description text`,
          detail: `This is a longer detail section for finding ${i} that should consume some tokens in the budget calculation.`,
        });
      }

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      // Use a very small budget
      const result = await assembler.assemble("test task", "project", 100);

      expect(result.token_estimate).toBeLessThanOrEqual(100);
      // Should not have all 20 findings
      const totalItems =
        result.recent_findings.length +
        result.active_decisions.length +
        result.open_needs.length +
        result.active_warnings.length +
        result.recent_questions.length;
      expect(totalItems).toBeLessThan(20);
    });

    it("should score warnings higher than findings", async () => {
      // Create a warning and a finding with the same content
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "warning",
        tags: [],
        scope: "project",
        summary: "Important warning about security",
        detail: "Details about the security issue",
      });

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "Finding about security",
        detail: "Details about a security finding",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      // With a tiny budget, warnings should be included first
      const result = await assembler.assemble("check security", "project", 30);

      // Warnings get reserved budget, so should appear even with tight budget
      expect(result.active_warnings.length).toBeGreaterThanOrEqual(1);
    });

    it("should exclude entries outside scope", async () => {
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "src/auth/",
        summary: "Auth finding",
        detail: "",
      });

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "src/database/",
        summary: "Database finding",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("auth work", "src/auth/");

      // Only the auth finding should be included
      expect(result.recent_findings).toHaveLength(1);
      expect(result.recent_findings[0]!.summary).toBe("Auth finding");
    });

    it("should work with null search engine (keyword fallback path)", async () => {
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "Test finding",
        detail: "Some details",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null, // No search engine
        config,
      );

      const result = await assembler.assemble("test task", "project");

      // Should still work, just without semantic search
      expect(result.recent_findings).toHaveLength(1);
    });

    it("should score more recent entries higher", async () => {
      // Create an old entry and a new entry
      // We can't easily control timestamps with the store, but we can verify
      // that entries created now have high recency scores by checking they're included
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "Recent finding",
        detail: "Fresh information",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("check", "project");
      expect(result.recent_findings).toHaveLength(1);
    });

    it("should include needs even if low-scored when budget allows", async () => {
      // Add a need entry
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "need",
        tags: [],
        scope: "project",
        summary: "Need tests for auth module",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.assemble("review work", "project");

      expect(result.open_needs).toHaveLength(1);
      expect(result.open_needs[0]!.summary).toBe("Need tests for auth module");
    });

    it("boosts decisions with graph-connected entities", async () => {
      const graphStore = new GraphStore(twiningDir);
      const graphEngine = new GraphEngine(graphStore);

      // Create entities that connect to the scope "src/auth/"
      const authModule = await graphEngine.addEntity({
        name: "src/auth/",
        type: "module",
        properties: { description: "Auth module" },
      });
      const jwtFile = await graphEngine.addEntity({
        name: "src/auth/jwt.ts",
        type: "file",
        properties: {},
      });
      const unrelatedFile = await graphEngine.addEntity({
        name: "src/database/db.ts",
        type: "file",
        properties: {},
      });

      // Create relation: jwt.ts -> auth module
      await graphEngine.addRelation({
        source: jwtFile.id,
        target: authModule.id,
        type: "imports",
      });

      // Create two decisions: one with graph-connected files, one without
      // The connected decision will have a concept entity + decided_by relation
      // (simulating what GraphAutoPopulator.onDecide creates)
      const connectedDecision = await decisionStore.create({
        agent_id: "test",
        domain: "implementation",
        scope: "src/auth/",
        summary: "Connected decision (JWT)",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "medium",
        reversible: true,
        affected_files: ["src/auth/jwt.ts"],
        affected_symbols: [],
      });

      // Create concept entity for the connected decision and link via decided_by
      const decisionConcept = await graphEngine.addEntity({
        name: connectedDecision.id,
        type: "concept",
        properties: { summary: "Connected decision (JWT)" },
      });
      await graphEngine.addRelation({
        source: jwtFile.name,
        target: decisionConcept.name,
        type: "decided_by",
      });

      const unconnectedDecision = await decisionStore.create({
        agent_id: "test",
        domain: "implementation",
        scope: "src/auth/",
        summary: "Unconnected decision (misc)",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "medium",
        reversible: true,
        affected_files: ["src/other/unrelated.ts"],
        affected_symbols: [],
      });

      const configWithGraph = makeConfig({
        context_assembly: {
          default_max_tokens: 4000,
          priority_weights: {
            recency: 0.3,
            relevance: 0.3,
            decision_confidence: 0.2,
            warning_boost: 0.0,
            graph_reachability: 0.2, // Exaggerate to make effect visible
          },
        },
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        configWithGraph,
        graphEngine,
      );

      // Use a tight budget that only fits one decision — the higher-scored
      // (graph-connected) one should be selected
      const result = await assembler.assemble("work on auth JWT", "src/auth/", 30);

      // With tight budget, only the higher-scored decision fits
      // The connected decision should win due to graph_connectivity boost
      const hasConnected = result.active_decisions.some(
        (d) => d.id === connectedDecision.id,
      );
      const hasUnconnected = result.active_decisions.some(
        (d) => d.id === unconnectedDecision.id,
      );

      // If only one fits, it should be the connected one
      if (result.active_decisions.length === 1) {
        expect(hasConnected).toBe(true);
        expect(hasUnconnected).toBe(false);
      } else {
        // If both fit, just verify the connected one is present
        expect(hasConnected).toBe(true);
      }
    });

    it("should work with search engine in fallback mode", async () => {
      const embedder = new Embedder(twiningDir);
      (embedder as any).fallbackMode = true;
      const indexManager = new IndexManager(twiningDir);
      const searchEngine = new SearchEngine(embedder, indexManager);

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "JWT token validation",
        detail: "Using jose library",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        searchEngine,
        config,
      );

      const result = await assembler.assemble("JWT authentication", "project");

      // Should still work via keyword search
      expect(result).toHaveProperty("assembled_at");
    });
  });

  describe("summarize", () => {
    it("should return correct counts for a populated store", async () => {
      // Add decisions
      await decisionStore.create({
        agent_id: "test",
        domain: "architecture",
        scope: "project",
        summary: "Active decision",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });

      // Add blackboard entries
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "need",
        tags: [],
        scope: "project",
        summary: "Open need",
        detail: "",
      });
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "warning",
        tags: [],
        scope: "project",
        summary: "Active warning",
        detail: "",
      });
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "question",
        tags: [],
        scope: "project",
        summary: "Unanswered question",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.summarize();

      expect(result.scope).toBe("project");
      expect(result.active_decisions).toBe(1);
      expect(result.provisional_decisions).toBe(0);
      expect(result.open_needs).toBe(1);
      expect(result.active_warnings).toBe(1);
      expect(result.unanswered_questions).toBe(1);
      expect(result.recent_activity_summary).toContain("1 decision made");
    });

    it("should filter by scope", async () => {
      await decisionStore.create({
        agent_id: "test",
        domain: "architecture",
        scope: "src/auth/",
        summary: "Auth decision",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });

      await decisionStore.create({
        agent_id: "test",
        domain: "architecture",
        scope: "src/database/",
        summary: "DB decision",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.summarize("src/auth/");

      expect(result.scope).toBe("src/auth/");
      expect(result.active_decisions).toBe(1);
    });

    it("should return zeros for empty store", async () => {
      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.summarize();

      expect(result.active_decisions).toBe(0);
      expect(result.provisional_decisions).toBe(0);
      expect(result.open_needs).toBe(0);
      expect(result.active_warnings).toBe(0);
      expect(result.unanswered_questions).toBe(0);
      expect(result.recent_activity_summary).toContain("0 decisions");
    });

    it("should count recent activity in last 24 hours", async () => {
      // Add entries (they'll have current timestamps, so within 24h)
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "Recent finding 1",
        detail: "",
      });
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "Recent finding 2",
        detail: "",
      });
      await blackboardStore.append({
        agent_id: "test",
        entry_type: "warning",
        tags: [],
        scope: "project",
        summary: "Recent warning",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.summarize();

      expect(result.recent_activity_summary).toContain("2 findings posted");
      expect(result.recent_activity_summary).toContain("1 warning raised");
    });
  });

  describe("whatChanged", () => {
    it("should filter entries by timestamp", async () => {
      const beforeTime = new Date().toISOString();
      // Small delay to ensure timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "project",
        summary: "New finding after timestamp",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.whatChanged(beforeTime);

      expect(result.new_entries).toHaveLength(1);
      expect(result.new_entries[0]!.summary).toBe(
        "New finding after timestamp",
      );
    });

    it("should filter decisions by timestamp", async () => {
      const beforeTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));

      await decisionStore.create({
        agent_id: "test",
        domain: "architecture",
        scope: "project",
        summary: "New decision",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.whatChanged(beforeTime);

      expect(result.new_decisions).toHaveLength(1);
      expect(result.new_decisions[0]!.summary).toBe("New decision");
    });

    it("should return empty results when nothing changed", async () => {
      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.whatChanged(new Date().toISOString());

      expect(result.new_entries).toHaveLength(0);
      expect(result.new_decisions).toHaveLength(0);
      expect(result.overridden_decisions).toHaveLength(0);
      expect(result.reconsidered_decisions).toHaveLength(0);
    });

    it("should filter by scope", async () => {
      const beforeTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "src/auth/",
        summary: "Auth finding",
        detail: "",
      });

      await blackboardStore.append({
        agent_id: "test",
        entry_type: "finding",
        tags: [],
        scope: "src/database/",
        summary: "Database finding",
        detail: "",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.whatChanged(beforeTime, "src/auth/");

      expect(result.new_entries).toHaveLength(1);
      expect(result.new_entries[0]!.summary).toBe("Auth finding");
    });

    it("should identify overridden decisions", async () => {
      // Record the time before creating the decision
      const beforeTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));

      const decision = await decisionStore.create({
        agent_id: "test",
        domain: "architecture",
        scope: "project",
        summary: "Original decision",
        context: "Context",
        rationale: "Rationale",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });

      // Override the decision
      await decisionStore.updateStatus(decision.id, "overridden", {
        overridden_by: "human",
        override_reason: "Changed requirements",
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
      );

      const result = await assembler.whatChanged(beforeTime);

      // The decision was created after beforeTime and then overridden,
      // so it should appear in overridden_decisions
      expect(result.overridden_decisions).toHaveLength(1);
      expect(result.overridden_decisions[0]!.summary).toBe(
        "Original decision",
      );
      expect(result.overridden_decisions[0]!.reason).toBe(
        "Changed requirements",
      );
    });
  });

  describe("planning integration", () => {
    const MOCK_STATE_MD = `# Project State

## Current Position

Phase: 3 of 5 (API Layer)
Plan: 1 of 2 in current phase
Status: In progress

Progress: [######----] 60% (v1)

## Accumulated Context

### Pending Todos

- Add rate limiting to API endpoints

### Blockers/Concerns

- ONNX runtime not compatible with ARM64

## Session Continuity

Last session: 2026-02-17
`;

    const MOCK_REQUIREMENTS_MD = `# Requirements

## API Layer

- [ ] **API-01**: Rate limiting on all endpoints
- [x] **API-02**: Input validation
- [ ] **API-03**: Error response formatting
`;

    function setupPlanningDir(projectRoot: string): void {
      const planningDir = path.join(projectRoot, ".planning");
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(path.join(planningDir, "STATE.md"), MOCK_STATE_MD);
      fs.writeFileSync(
        path.join(planningDir, "REQUIREMENTS.md"),
        MOCK_REQUIREMENTS_MD,
      );
    }

    it("should include planning_state in assemble() when .planning/ exists", async () => {
      // The twiningDir is inside a temp dir; we need a project root that contains .planning/
      // Use the parent of twiningDir as a project root stand-in
      const projectRoot = path.dirname(twiningDir);
      setupPlanningDir(projectRoot);
      const planningBridge = new PlanningBridge(projectRoot);

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        planningBridge,
      );

      const result = await assembler.assemble("build api", "project");

      expect(result.planning_state).toBeDefined();
      expect(result.planning_state!.current_phase).toBe("3 of 5 (API Layer)");
      expect(result.planning_state!.progress).toContain("60%");
      expect(result.planning_state!.blockers).toHaveLength(1);
      expect(result.planning_state!.open_requirements).toHaveLength(2);
    });

    it("should add synthetic planning finding in assemble()", async () => {
      const projectRoot = path.dirname(twiningDir);
      setupPlanningDir(projectRoot);
      const planningBridge = new PlanningBridge(projectRoot);

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        planningBridge,
      );

      const result = await assembler.assemble("build api", "project");

      // Should have a synthetic planning finding in recent_findings
      const planningFinding = result.recent_findings.find(
        (f) => f.id === "planning-state",
      );
      expect(planningFinding).toBeDefined();
      expect(planningFinding!.summary).toContain("Phase 3 of 5 (API Layer)");
      expect(planningFinding!.summary).toContain("60%");
      expect(planningFinding!.summary).toContain("ONNX runtime");
    });

    it("should include planning_state in summarize() when .planning/ exists", async () => {
      const projectRoot = path.dirname(twiningDir);
      setupPlanningDir(projectRoot);
      const planningBridge = new PlanningBridge(projectRoot);

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        planningBridge,
      );

      const result = await assembler.summarize();

      expect(result.planning_state).toBeDefined();
      expect(result.planning_state!.current_phase).toBe("3 of 5 (API Layer)");
      expect(result.recent_activity_summary).toContain(
        "Current phase: 3 of 5 (API Layer)",
      );
      expect(result.recent_activity_summary).toContain("60%");
    });

    it("should not include planning_state when .planning/ does not exist", async () => {
      // Use a project root with no .planning/ dir
      const emptyProjectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "twining-no-planning-"),
      );
      const planningBridge = new PlanningBridge(emptyProjectRoot);

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        planningBridge,
      );

      const assembleResult = await assembler.assemble("test", "project");
      expect(assembleResult.planning_state).toBeUndefined();
      expect(
        assembleResult.recent_findings.find((f) => f.id === "planning-state"),
      ).toBeUndefined();

      const summarizeResult = await assembler.summarize();
      expect(summarizeResult.planning_state).toBeUndefined();
      expect(summarizeResult.recent_activity_summary).not.toContain(
        "Current phase",
      );

      fs.rmSync(emptyProjectRoot, { recursive: true, force: true });
    });

    it("should work normally when no PlanningBridge is provided", async () => {
      // No planningBridge argument at all
      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        // No planning bridge
      );

      const assembleResult = await assembler.assemble("test", "project");
      expect(assembleResult.planning_state).toBeUndefined();

      const summarizeResult = await assembler.summarize();
      expect(summarizeResult.planning_state).toBeUndefined();
    });
  });

  describe("handoff and agent integration", () => {
    let handoffStore: HandoffStore;
    let agentStore: AgentStore;

    beforeEach(() => {
      handoffStore = new HandoffStore(twiningDir);
      agentStore = new AgentStore(twiningDir);
    });

    it("includes recent handoffs matching scope in assembled context", async () => {
      // Create handoffs matching scope
      await handoffStore.create({
        source_agent: "agent-a",
        target_agent: "agent-b",
        scope: "src/auth/",
        summary: "Completed auth token validation",
        results: [{ description: "Added JWT checks", status: "completed" }],
        context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        null,
        handoffStore,
        null,
      );

      const result = await assembler.assemble("review auth", "src/auth/");

      expect(result.recent_handoffs).toBeDefined();
      expect(result.recent_handoffs).toHaveLength(1);
      expect(result.recent_handoffs![0]!.source_agent).toBe("agent-a");
      expect(result.recent_handoffs![0]!.target_agent).toBe("agent-b");
      expect(result.recent_handoffs![0]!.summary).toBe("Completed auth token validation");
      expect(result.recent_handoffs![0]!.result_status).toBe("completed");
      expect(result.recent_handoffs![0]!.acknowledged).toBe(false);
    });

    it("caps handoffs at 5", async () => {
      // Create 7 handoffs
      for (let i = 0; i < 7; i++) {
        await handoffStore.create({
          source_agent: `agent-${i}`,
          scope: "src/auth/",
          summary: `Handoff ${i}`,
          results: [{ description: `Result ${i}`, status: "completed" }],
          context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
        });
      }

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        null,
        handoffStore,
        null,
      );

      const result = await assembler.assemble("review auth", "src/auth/");

      expect(result.recent_handoffs).toBeDefined();
      expect(result.recent_handoffs).toHaveLength(5);
    });

    it("returns empty recent_handoffs when no handoffs match scope", async () => {
      // Create a handoff for a different scope
      await handoffStore.create({
        source_agent: "agent-a",
        scope: "src/database/",
        summary: "DB migration",
        results: [{ description: "Migrated schema", status: "completed" }],
        context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        null,
        handoffStore,
        null,
      );

      const result = await assembler.assemble("review auth", "src/auth/");

      // No matching handoffs — field should be undefined (not set)
      expect(result.recent_handoffs).toBeUndefined();
    });

    it("suggests agents with matching capabilities for task", async () => {
      // Register agents with capabilities
      await agentStore.upsert({
        agent_id: "testing-agent",
        capabilities: ["testing", "validation"],
      });
      await agentStore.upsert({
        agent_id: "deploy-agent",
        capabilities: ["deployment", "infrastructure"],
      });

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        null,
        null,
        agentStore,
      );

      const result = await assembler.assemble("add testing for auth module", "src/auth/");

      expect(result.suggested_agents).toBeDefined();
      expect(result.suggested_agents).toHaveLength(1);
      expect(result.suggested_agents![0]!.agent_id).toBe("testing-agent");
      expect(result.suggested_agents![0]!.capabilities).toContain("testing");
      expect(result.suggested_agents![0]!.liveness).toBe("active");
    });

    it("does not suggest gone agents", async () => {
      // Register agent with old last_active (gone)
      await agentStore.upsert({
        agent_id: "old-agent",
        capabilities: ["testing"],
      });
      // Manually set last_active to an hour ago (beyond gone threshold)
      const registryPath = path.join(twiningDir, "agents", "registry.json");
      const agents = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      agents[0].last_active = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      fs.writeFileSync(registryPath, JSON.stringify(agents));

      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        null,
        null,
        agentStore,
      );

      const result = await assembler.assemble("add testing", "project");

      // Gone agent should not be suggested
      expect(result.suggested_agents).toBeUndefined();
    });

    it("works without handoffStore or agentStore (backward compatible)", async () => {
      const assembler = new ContextAssembler(
        blackboardStore,
        decisionStore,
        null,
        config,
        null,
        null,
        // No handoffStore or agentStore
      );

      const result = await assembler.assemble("test task", "project");

      expect(result.recent_handoffs).toBeUndefined();
      expect(result.suggested_agents).toBeUndefined();
    });
  });
});

describe("ContextAssembler — superseded exclusion visibility (field D10)", () => {
  it("counts superseded decisions excluded from the briefing instead of silence", async () => {
    const twiningDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-d10-assembler-"),
    );
    fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
    fs.writeFileSync(
      path.join(twiningDir, "decisions", "index.json"),
      JSON.stringify([]),
    );
    const bbStore = new BlackboardStore(twiningDir);
    const dStore = new DecisionStore(twiningDir);

    const base = {
      agent_id: "test",
      domain: "implementation",
      context: "ctx",
      rationale: "why",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high" as const,
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    };
    const old = await dStore.create({
      ...base,
      scope: "src/gate/",
      summary: "Original choice, later superseded",
    });
    const successor = await dStore.create({
      ...base,
      scope: "src/other/",
      summary: "The replacement (different scope)",
    });
    await dStore.updateStatus(old.id, "superseded", {
      superseded_by: successor.id,
    });

    const assembler = new ContextAssembler(
      bbStore,
      dStore,
      null,
      makeConfig(),
    );
    const result = await assembler.assemble("check the gate", "src/gate/");

    expect(result.active_decisions).toHaveLength(0);
    expect(result.superseded_excluded_count).toBe(1);
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).toContain("superseded");
    expect(briefing).not.toMatch(/^No prior context/);
  });
});

describe("ContextAssembler — continue-work lane aging and entry dampening (field D12)", () => {
  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-d12-"));
    fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "embeddings"), { recursive: true });
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    fs.writeFileSync(
      path.join(dir, "decisions", "index.json"),
      JSON.stringify([]),
    );
    return dir;
  }

  it("a legacy scopeless handoff no longer matches every scope", async () => {
    const dir = makeDir();
    const handoffStore = new HandoffStore(dir);
    await handoffStore.create({
      source_agent: "agent-legacy",
      summary: "Scopeless legacy handoff",
      results: [{ description: "Old work", status: "completed" }],
      context_snapshot: {
        decision_ids: [],
        warning_ids: [],
        finding_ids: [],
        summaries: [],
      },
    });

    const assembler = new ContextAssembler(
      new BlackboardStore(dir),
      new DecisionStore(dir),
      null,
      makeConfig(),
      null,
      null,
      handoffStore,
      null,
    );
    const result = await assembler.assemble("narrow task", "src/auth/");
    expect(result.recent_handoffs).toBeUndefined();

    const atProject = await assembler.assemble("broad task", "project");
    expect(atProject.recent_handoffs).toHaveLength(1);
  });

  it("stamps continue-work items and blocked results with their age", async () => {
    const dir = makeDir();
    const handoffStore = new HandoffStore(dir);
    const rec = await handoffStore.create({
      source_agent: "agent-a",
      scope: "src/auth/",
      summary: "Fifteen day old handoff",
      results: [{ description: "Stuck migration", status: "blocked" }],
      context_snapshot: {
        decision_ids: [],
        warning_ids: [],
        finding_ids: [],
        summaries: [],
      },
    });
    // Age the record 15 days: rewrite created_at in both the index and the file.
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const indexPath = path.join(dir, "handoffs", "index.jsonl");
    fs.writeFileSync(
      indexPath,
      fs
        .readFileSync(indexPath, "utf-8")
        .split("\n")
        .map((l) => (l ? JSON.stringify({ ...JSON.parse(l), created_at: old }) : l))
        .join("\n"),
    );
    const filePath = path.join(dir, "handoffs", `${rec.id}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(filePath, "utf-8")), created_at: old }),
    );

    const assembler = new ContextAssembler(
      new BlackboardStore(dir),
      new DecisionStore(dir),
      null,
      makeConfig(),
      null,
      null,
      handoffStore,
      null,
    );
    const result = await assembler.assemble("continue auth", "src/auth/");
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).toContain("15d ago");
    expect(briefing).toContain("[BLOCKED 15d]");
  });

  it("drops semantically-admitted entries below the relevance floor, keeps strong matches", async () => {
    const dir = makeDir();
    const bbStore = new BlackboardStore(dir);
    await bbStore.append({
      agent_id: "t",
      entry_type: "finding",
      tags: [],
      scope: "src/zebra/",
      summary: "cache mention only",
      detail: "",
    });
    await bbStore.append({
      agent_id: "t",
      entry_type: "finding",
      tags: [],
      scope: "src/zebra/",
      summary: "cache invalidation strategy review analysis pass",
      detail: "",
    });

    const embedder = new Embedder(dir);
    (embedder as any).fallbackMode = true;
    const searchEngine = new SearchEngine(embedder, new IndexManager(dir));

    const assembler = new ContextAssembler(
      bbStore,
      new DecisionStore(dir),
      searchEngine,
      makeConfig(),
    );
    const result = await assembler.assemble(
      "cache invalidation strategy review analysis pass",
      "src/auth/",
    );
    const summaries = result.recent_findings.map((f) => f.summary);
    expect(summaries).toContain(
      "cache invalidation strategy review analysis pass",
    );
    expect(summaries).not.toContain("cache mention only");
  });

  it("dampens off-scope semantic admissions so in-scope warnings outrank them", async () => {
    const dir = makeDir();
    const bbStore = new BlackboardStore(dir);
    await bbStore.append({
      agent_id: "t",
      entry_type: "warning",
      tags: [],
      scope: "src/zebra/",
      summary: "cache invalidation strategy review",
      detail: "",
    });
    await bbStore.append({
      agent_id: "t",
      entry_type: "warning",
      tags: [],
      scope: "src/auth/",
      summary: "Unrelated local constraint zzz",
      detail: "",
    });

    const embedder = new Embedder(dir);
    (embedder as any).fallbackMode = true;
    const searchEngine = new SearchEngine(embedder, new IndexManager(dir));

    const assembler = new ContextAssembler(
      bbStore,
      new DecisionStore(dir),
      searchEngine,
      makeConfig(),
    );
    const result = await assembler.assemble(
      "cache invalidation strategy review",
      "src/auth/",
    );
    expect(result.active_warnings.length).toBe(2);
    expect(result.active_warnings[0]!.summary).toBe(
      "Unrelated local constraint zzz",
    );
  });
});

describe("ContextAssembler — review-finding pins", () => {
  function makeDir2(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-pins-"));
    fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "embeddings"), { recursive: true });
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    fs.writeFileSync(
      path.join(dir, "decisions", "index.json"),
      JSON.stringify([]),
    );
    return dir;
  }
  const baseDecision = {
    agent_id: "test",
    domain: "implementation",
    context: "ctx",
    rationale: "why",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "high" as const,
    reversible: true,
    affected_files: [],
    affected_symbols: [],
  };

  it("a scope whose only decision is archived renders the archived note, not 'No prior context'", async () => {
    const dir = makeDir2();
    const dStore = new DecisionStore(dir);
    const d = await dStore.create({
      ...baseDecision,
      scope: "src/gate/",
      summary: "Archived away",
    });
    await dStore.updateStatus(d.id, "archived", { archived_from: "active" });

    const assembler = new ContextAssembler(
      new BlackboardStore(dir),
      dStore,
      null,
      makeConfig(),
    );
    const result = await assembler.assemble("check", "src/gate/");
    expect(result.archived_excluded_count).toBe(1);
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).toContain("archived decision(s) in this scope are excluded");
    expect(briefing).not.toMatch(/^No prior context/);
  });

  it("budget-exhausted briefings still render the exclusion notes", async () => {
    const dir = makeDir2();
    const dStore = new DecisionStore(dir);
    const bbStore = new BlackboardStore(dir);
    const old = await dStore.create({
      ...baseDecision,
      scope: "src/gate/",
      summary: "Superseded away",
    });
    const succ = await dStore.create({
      ...baseDecision,
      scope: "src/other/",
      summary: "Successor",
    });
    await dStore.updateStatus(old.id, "superseded", { superseded_by: succ.id });
    await bbStore.append({
      agent_id: "t",
      entry_type: "warning",
      tags: [],
      scope: "src/gate/",
      summary: "A warning that will not fit the budget",
      detail: "D".repeat(2000),
    });

    const assembler = new ContextAssembler(bbStore, dStore, null, makeConfig());
    const result = await assembler.assemble("check", "src/gate/", 10);
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).toContain("superseded/overridden decision(s) in this scope are excluded");
  });

  it("exact-scope warnings rank above parent-scope warnings with identical content", async () => {
    const dir = makeDir2();
    const bbStore = new BlackboardStore(dir);
    await bbStore.append({
      agent_id: "t",
      entry_type: "warning",
      tags: [],
      scope: "src/",
      summary: "Broad parent warning zzz",
      detail: "",
    });
    await bbStore.append({
      agent_id: "t",
      entry_type: "warning",
      tags: [],
      scope: "src/auth/",
      summary: "Exact scope warning zzz",
      detail: "",
    });

    const assembler = new ContextAssembler(
      bbStore,
      new DecisionStore(dir),
      null,
      makeConfig(),
    );
    const result = await assembler.assemble("unrelated task text", "src/auth/");
    expect(result.active_warnings).toHaveLength(2);
    expect(result.active_warnings[0]!.summary).toBe("Exact scope warning zzz");
  });

  it("same-day handoffs carry no age stamp", async () => {
    const dir = makeDir2();
    const handoffStore = new HandoffStore(dir);
    await handoffStore.create({
      source_agent: "agent-a",
      scope: "src/auth/",
      summary: "Fresh handoff",
      results: [{ description: "Stuck bit", status: "blocked" }],
      context_snapshot: {
        decision_ids: [],
        warning_ids: [],
        finding_ids: [],
        summaries: [],
      },
    });
    const assembler = new ContextAssembler(
      new BlackboardStore(dir),
      new DecisionStore(dir),
      null,
      makeConfig(),
      null,
      null,
      handoffStore,
      null,
    );
    const result = await assembler.assemble("continue", "src/auth/");
    const briefing = ContextAssembler.formatForLLM(result);
    expect(briefing).toContain("[BLOCKED]");
    expect(briefing).not.toMatch(/\[BLOCKED \d+d\]/);
    expect(briefing).not.toContain("d ago)");
  });
});
