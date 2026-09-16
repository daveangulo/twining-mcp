/**
 * Tests for formatForLLM output quality improvements:
 * - First-500-tokens: critical signals appear early
 * - No-redundancy: decisions and findings don't duplicate
 * - Diff-from-empty: populated state adds meaningful content
 * - Imperative framing: output uses directive language
 * - Warning priority: warnings appear before decisions
 * - Handoff checklists: structured continuation items
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createTwiningDir, createAssembler, estimateTokens } from "./helpers.js";
import { ContextAssembler } from "../../src/engine/context-assembler.js";
import * as bugInvestigation from "./fixtures/bug-investigation.js";
import * as contextRecovery from "./fixtures/context-recovery.js";
import * as architectureCascade from "./fixtures/architecture-cascade.js";
import * as conflictResolution from "./fixtures/conflict-resolution.js";
import * as refactoringHandoff from "./fixtures/refactoring-handoff.js";

let twiningDir: string;

beforeEach(() => {
  twiningDir = createTwiningDir();
});

afterEach(() => {
  fs.rmSync(twiningDir, { recursive: true, force: true });
});

describe("first-500-tokens: critical signals appear early", () => {
  it("bug-investigation: warning appears in first 500 tokens", async () => {
    await bugInvestigation.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("fix pagination bug", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    const first500 = text.slice(0, 500 * 4); // ~500 tokens at 4 chars/token
    expect(first500).toMatch(/Do NOT modify|search\.service/i);
  });

  it("context-recovery: handoff appears in first 500 tokens", async () => {
    await contextRecovery.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("continue auth work", "src/auth/");
    const text = ContextAssembler.formatForLLM(ctx);
    const first500 = text.slice(0, 500 * 4);
    // Either the warning or the handoff should appear early
    expect(first500).toMatch(/JWT secret|CONTINUE FROM|auth/i);
  });

  it("architecture-cascade: key decision appears in first 500 tokens", async () => {
    await architectureCascade.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("add repository", "src/repositories/");
    const text = ContextAssembler.formatForLLM(ctx);
    const first500 = text.slice(0, 500 * 4);
    expect(first500).toMatch(/repository pattern|BaseRepository/i);
  });

  it("warnings section appears before decisions section", async () => {
    await bugInvestigation.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("fix bug", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    const warningsIdx = text.indexOf("STOP — READ THESE WARNINGS");
    const decisionsIdx = text.indexOf("DECISIONS TO RESPECT");
    if (warningsIdx >= 0 && decisionsIdx >= 0) {
      expect(warningsIdx).toBeLessThan(decisionsIdx);
    }
  });
});

describe("no-redundancy: decisions and findings don't duplicate", () => {
  it("findings that overlap with decisions are filtered out", async () => {
    const kit = createAssembler(twiningDir);
    // Create a decision and a finding with overlapping content
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/mod/",
      summary: "Pagination bug is an off-by-one error in paginate() offset calculation",
      context: "Investigation",
      rationale: "The offset formula is wrong",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/mod/pagination.ts"],
      affected_symbols: [],
    });
    await kit.blackboard.append({
      agent_id: "a",
      entry_type: "finding",
      tags: [],
      scope: "src/mod/",
      // This finding substantially overlaps with the decision summary
      summary: "Pagination bug is an off-by-one error in the offset calculation",
      detail: "",
    });
    // Also add a unique finding that shouldn't be filtered
    await kit.blackboard.append({
      agent_id: "a",
      entry_type: "finding",
      tags: [],
      scope: "src/mod/",
      summary: "Performance profiling shows 200ms latency in database queries",
      detail: "",
    });

    const ctx = await kit.assembler.assemble("fix mod", "src/mod/");
    const text = ContextAssembler.formatForLLM(ctx);

    // The unique finding should appear
    expect(text).toContain("Performance profiling");
    // The FINDINGS section should NOT contain the redundant pagination finding
    const findingsSection = text.split("FINDINGS")[1] ?? "";
    expect(findingsSection).not.toMatch(/Pagination bug is an off-by-one/i);
  });

  it("non-overlapping findings are preserved", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/mod/",
      summary: "Use Redis for caching layer",
      context: "Perf",
      rationale: "Fast in-memory store",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "medium",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    });
    await kit.blackboard.append({
      agent_id: "a",
      entry_type: "finding",
      tags: [],
      scope: "src/mod/",
      summary: "Database connection pool exhaustion under load",
      detail: "",
    });

    const ctx = await kit.assembler.assemble("fix mod", "src/mod/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("Database connection pool");
  });
});

describe("diff-from-empty: populated state adds meaningful content", () => {
  it("empty state produces terse one-liner", async () => {
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    // Short-circuit: no sections, just a terse message
    expect(text).toContain("No prior context");
    expect(text.length).toBeLessThan(100);
  });

  it("populated state adds >3x content over empty", async () => {
    // Empty baseline
    const emptyKit = createAssembler(twiningDir);
    const emptyCtx = await emptyKit.assembler.assemble("task", "src/");
    const emptyLen = ContextAssembler.formatForLLM(emptyCtx).length;

    // Populated state
    const dir2 = createTwiningDir();
    await bugInvestigation.populate(dir2);
    const populatedKit = createAssembler(dir2);
    const populatedCtx = await populatedKit.assembler.assemble("fix bug", "src/");
    const populatedLen = ContextAssembler.formatForLLM(populatedCtx).length;

    // Populated should be at least 3x the empty boilerplate
    expect(populatedLen).toBeGreaterThan(emptyLen * 3);

    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it("every major section adds actionable content", async () => {
    await contextRecovery.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("continue auth", "src/auth/");
    const text = ContextAssembler.formatForLLM(ctx);

    // Should have warnings, handoffs, decisions, and needs
    expect(text).toContain("STOP — READ THESE WARNINGS");
    expect(text).toContain("CONTINUE FROM PREVIOUS WORK");
    expect(text).toContain("DECISIONS TO RESPECT");
    expect(text).toContain("REMAINING WORK");
  });
});

describe("imperative framing: output uses directive language", () => {
  it("decisions show Why: instead of passive Rationale:", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use strict mode",
      context: "Quality",
      rationale: "Prevents silent errors",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/config.ts"],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("Why:");
    expect(text).not.toContain("Rationale:");
  });

  it("decisions show Files: on separate line for visibility", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use repository pattern",
      context: "Architecture",
      rationale: "Clean separation",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/repos/base.ts", "src/repos/user.ts"],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toMatch(/Files:\s+src\/repos\/base\.ts/);
  });

  it("open needs rendered as checklist items", async () => {
    const kit = createAssembler(twiningDir);
    await kit.blackboard.append({
      agent_id: "a",
      entry_type: "need",
      tags: [],
      scope: "src/",
      summary: "Add unit tests for auth module",
      detail: "",
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("REMAINING WORK");
    expect(text).toContain("- [ ] Add unit tests for auth module");
  });

  it("warnings section title is urgent/imperative", async () => {
    const kit = createAssembler(twiningDir);
    await kit.blackboard.append({
      agent_id: "a",
      entry_type: "warning",
      tags: [],
      scope: "src/",
      summary: "Do not modify legacy.ts",
      detail: "",
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("STOP — READ THESE WARNINGS");
  });
});

describe("constraints and rejected alternatives in decisions", () => {
  it("decisions with constraints show MUST: line", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "architecture",
      scope: "src/",
      summary: "Use EventBus for all service communication",
      context: "Decoupling",
      rationale: "Event-driven decouples producers from consumers",
      constraints: ["All notifications must use EventBus.emit()", "No direct service-to-service calls"],
      alternatives: [
        { option: "Direct service calls", pros: [], cons: [], reason_rejected: "Tight coupling between services" },
        { option: "Message queue", pros: [], cons: [], reason_rejected: "Too complex for current scale" },
      ],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/events/bus.ts"],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("add notification", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    // SUPERSEDED BY LANE 04 (gap 6, render side). These briefings render 2.x
    // records, every one of which is `legacy_unverified` — nothing has verified
    // who wrote them. Imperatives ("MUST:", "DO NOT:", "Follow this decision
    // exactly") are now emitted only for a class that can actually qualify an
    // action; below that rank the same CONTENT is emitted under non-imperative
    // labels. The content assertions are unchanged and still the point of these
    // tests; only the label changed.
    expect(text).toContain("Constraint stated by the author (unverified):");
    expect(text).toContain("EventBus.emit()");
    expect(text).toContain("Alternatives the author rejected (unverified):");
    expect(text).toContain("Direct service calls");
    expect(text).toContain("Tight coupling");
  });

  it("constraints survive through AssembledContext", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use repository pattern",
      context: "Data access",
      rationale: "Clean separation",
      constraints: ["All DB access through repositories"],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    expect(ctx.active_decisions[0]!.constraints).toEqual(["All DB access through repositories"]);
  });

  it("decisions without constraints omit MUST/DO NOT lines", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use strict mode",
      context: "Quality",
      rationale: "Safety",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).not.toContain("MUST:");
    expect(text).not.toContain("DO NOT:");
  });
});

describe("handoff checklists: structured continuation items", () => {
  it("handoff results appear as checklist with status icons", async () => {
    await contextRecovery.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("continue auth work", "src/auth/");
    const text = ContextAssembler.formatForLLM(ctx);

    // Completed items show [x]
    expect(text).toMatch(/\[x\].*JWT generation/i);
    // Blocked items show [BLOCKED]
    expect(text).toMatch(/\[BLOCKED\].*Refresh token/i);
  });

  it("refactoring handoff shows completed and partial items", async () => {
    await refactoringHandoff.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("continue refactoring", "src/services/");
    const text = ContextAssembler.formatForLLM(ctx);

    // Completed item
    expect(text).toMatch(/\[x\].*user\.service\.ts|user\.validator/i);
    // Partial item (not done)
    expect(text).toMatch(/\[ \].*order\.service\.ts|order\.validator/i);
  });

  it("handoff results include notes when present", async () => {
    await contextRecovery.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("continue auth", "src/auth/");
    const text = ContextAssembler.formatForLLM(ctx);

    // The blocked result has notes about what needs to happen
    expect(text).toMatch(/rotateRefresh|DB token invalidation/i);
  });

  it("handoff without results still shows summary", async () => {
    // Create a handoff with no results array
    const kit = createAssembler(twiningDir);
    await kit.handoffs.create({
      source_agent: "agent-a",
      scope: "src/",
      summary: "General project handoff with context",
      results: [],
      context_snapshot: {
        decision_ids: [],
        warning_ids: [],
        finding_ids: [],
        summaries: ["Work in progress"],
      },
    });

    const ctx = await kit.assembler.assemble("continue work", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("CONTINUE FROM PREVIOUS WORK");
    expect(text).toContain("General project handoff");
  });
});

describe("assumptions: prescriptive when assumptions hold", () => {
  it("decisions with assumptions show Assumes: line", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "architecture",
      scope: "src/",
      summary: "Use eventEmitter pattern for notifications",
      context: "Decoupling services",
      rationale: "Event-driven decouples producers from consumers",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/events/bus.ts"],
      affected_symbols: [],
      assumptions: ["Services need loose coupling", "No strict ordering required"],
    });

    const ctx = await kit.assembler.assemble("add notification", "src/");
    expect(ctx.active_decisions[0]!.assumptions_status).toBe("hold");
    const text = ContextAssembler.formatForLLM(ctx);
    // SUPERSEDED BY LANE 04 (gap 6, render side). These briefings render 2.x
    // records, every one of which is `legacy_unverified` — nothing has verified
    // who wrote them. Imperatives ("MUST:", "DO NOT:", "Follow this decision
    // exactly") are now emitted only for a class that can actually qualify an
    // action; below that rank the same CONTENT is emitted under non-imperative
    // labels. The content assertions are unchanged and still the point of these
    // tests; only the label changed.
    expect(text).toContain("Assumes:");
    expect(text).toContain("loose coupling");
    expect(text).toContain("Assumptions stated by the author; nothing has verified them.");
  });

  it("decisions without assumptions omit Assumes: line", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use strict TypeScript",
      context: "Quality",
      rationale: "Prevents runtime errors",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).not.toContain("Assumes:");
    expect(text).not.toContain("follow it exactly");
  });

  it("assumptions survive through AssembledContext", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "architecture",
      scope: "src/",
      summary: "Use REST API",
      context: "API design",
      rationale: "Simpler for CRUD",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/api/routes.ts"],
      affected_symbols: [],
      assumptions: ["CRUD-heavy workload", "No real-time subscriptions needed"],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    expect(ctx.active_decisions[0]!.assumptions).toEqual([
      "CRUD-heavy workload",
      "No real-time subscriptions needed",
    ]);
  });
});

describe("assumption validation: challenged vs hold", () => {
  it("flags assumptions as challenged when findings contradict them", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "architecture",
      scope: "src/",
      summary: "Use REST API for all endpoints",
      context: "API design",
      rationale: "REST is simpler for CRUD",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/api/routes.ts"],
      affected_symbols: [],
      assumptions: ["CRUD-heavy workload", "No real-time subscriptions needed"],
    });
    // Finding that contradicts the "no real-time" assumption
    await kit.blackboard.append({
      agent_id: "b",
      entry_type: "finding",
      tags: [],
      scope: "src/",
      summary: "Real-time subscriptions are now required for the dashboard — changed requirements",
      detail: "Product team confirmed real-time updates are not optional anymore.",
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    expect(ctx.active_decisions[0]!.assumptions_status).toBe("challenged");
    expect(ctx.active_decisions[0]!.challenged_assumptions).toContain("No real-time subscriptions needed");

    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("ASSUMPTIONS CHALLENGED");
    expect(text).toContain("RECONSIDER");
  });

  it("keeps assumptions as hold when no contradicting evidence", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "architecture",
      scope: "src/",
      summary: "Use PostgreSQL for persistence",
      context: "Database choice",
      rationale: "Strong relational support",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: false,
      affected_files: ["src/db/connection.ts"],
      affected_symbols: [],
      assumptions: ["Data is relational", "ACID compliance required"],
    });
    // Unrelated finding — doesn't challenge assumptions
    await kit.blackboard.append({
      agent_id: "b",
      entry_type: "finding",
      tags: [],
      scope: "src/",
      summary: "Logging should use structured JSON format",
      detail: "",
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    expect(ctx.active_decisions[0]!.assumptions_status).toBe("hold");
    expect(ctx.active_decisions[0]!.challenged_assumptions).toBeUndefined();

    const text = ContextAssembler.formatForLLM(ctx);
    // SUPERSEDED BY LANE 04 (gap 6, render side). These briefings render 2.x
    // records, every one of which is `legacy_unverified` — nothing has verified
    // who wrote them. Imperatives ("MUST:", "DO NOT:", "Follow this decision
    // exactly") are now emitted only for a class that can actually qualify an
    // action; below that rank the same CONTENT is emitted under non-imperative
    // labels. The content assertions are unchanged and still the point of these
    // tests; only the label changed.
    expect(text).toContain("Assumptions stated by the author; nothing has verified them.");
    expect(text).not.toContain("RECONSIDER");
  });

  it("challenges assumptions when a newer decision contradicts them", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "architecture",
      scope: "src/services/",
      summary: "Services communicate via direct calls",
      context: "Simplicity",
      rationale: "Direct calls are simpler when ordering matters",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/services/order.ts"],
      affected_symbols: [],
      assumptions: ["Strict ordering required between services", "Low service count"],
    });
    // Newer decision that contradicts the ordering assumption
    await kit.decisions.create({
      agent_id: "b",
      domain: "architecture",
      scope: "src/services/",
      summary: "Use event bus — ordering is not required, services are decoupled",
      context: "Requirements changed",
      rationale: "Strict ordering was removed from requirements",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/services/event-bus.ts"],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("work on services", "src/services/");
    const directCallDecision = ctx.active_decisions.find((d) => d.summary.includes("direct calls"));
    if (directCallDecision) {
      expect(directCallDecision.assumptions_status).toBe("challenged");
      expect(directCallDecision.challenged_assumptions).toContain("Strict ordering required between services");
    }
  });

  it("decisions without assumptions get no status", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use strict TypeScript",
      context: "Quality",
      rationale: "Safety",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    expect(ctx.active_decisions[0]!.assumptions_status).toBeUndefined();
  });
});

describe("FILES TO CHECK section", () => {
  it("lists affected_files from decisions as read directives", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use eventEmitter pattern",
      context: "Architecture",
      rationale: "Decoupling",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/events/bus.ts", "src/services/order.ts"],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("FILES TO CHECK BEFORE WRITING");
    expect(text).toContain("Read `src/events/bus.ts`");
    expect(text).toContain("Read `src/services/order.ts`");
  });

  it("includes handoff artifacts in files to check", async () => {
    await contextRecovery.populate(twiningDir);
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("continue auth", "src/auth/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("FILES TO CHECK");
    expect(text).toContain("src/auth/jwt.ts");
  });

  it("no FILES TO CHECK section when no affected files", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "a",
      domain: "implementation",
      scope: "src/",
      summary: "Use strict mode",
      context: "Quality",
      rationale: "Safety",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
    });

    const ctx = await kit.assembler.assemble("task", "src/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).not.toContain("FILES TO CHECK");
  });
});
