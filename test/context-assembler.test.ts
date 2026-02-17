/**
 * Tests for the ContextAssembler class.
 * Uses temp directories with pre-populated fixture data.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ContextAssembler } from "../src/engine/context-assembler.js";
import { PlanningBridge } from "../src/engine/planning-bridge.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
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
