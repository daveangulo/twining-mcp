import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";
import { TwiningError } from "../src/utils/errors.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let decisionStore: DecisionStore;
let blackboardEngine: BlackboardEngine;
let decisionEngine: DecisionEngine;

function validDecisionInput(overrides: Record<string, unknown> = {}) {
  return {
    domain: "architecture",
    scope: "src/auth/",
    summary: "Use JWT for auth",
    context: "Need stateless auth",
    rationale: "Enables horizontal scaling",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-dcsn-eng-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  blackboardStore = new BlackboardStore(tmpDir);
  decisionStore = new DecisionStore(tmpDir);
  blackboardEngine = new BlackboardEngine(blackboardStore);
  decisionEngine = new DecisionEngine(decisionStore, blackboardEngine);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DecisionEngine.decide", () => {
  it("creates a decision and returns id and timestamp", async () => {
    const result = await decisionEngine.decide(validDecisionInput());
    expect(result.id).toHaveLength(26);
    expect(result.timestamp).toBeTruthy();
  });

  it("cross-posts decision to blackboard", async () => {
    await decisionEngine.decide(validDecisionInput());
    const { entries } = await blackboardEngine.read({
      entry_types: ["decision"],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Use JWT for auth");
    expect(entries[0]!.detail).toBe("Enables horizontal scaling");
    expect(entries[0]!.tags).toEqual(["architecture"]);
  });

  it("throws TwiningError for missing domain", async () => {
    await expect(
      decisionEngine.decide(validDecisionInput({ domain: "" })),
    ).rejects.toThrow(TwiningError);
    try {
      await decisionEngine.decide(validDecisionInput({ domain: "" }));
    } catch (e) {
      expect((e as TwiningError).code).toBe("INVALID_INPUT");
    }
  });

  it("throws TwiningError for missing summary", async () => {
    await expect(
      decisionEngine.decide(validDecisionInput({ summary: "" })),
    ).rejects.toThrow(TwiningError);
  });

  it("throws TwiningError for missing context", async () => {
    await expect(
      decisionEngine.decide(validDecisionInput({ context: "" })),
    ).rejects.toThrow(TwiningError);
  });

  it("throws TwiningError for missing rationale", async () => {
    await expect(
      decisionEngine.decide(validDecisionInput({ rationale: "" })),
    ).rejects.toThrow(TwiningError);
  });

  it("marks old decision as superseded when supersedes is set", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "First decision" }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Second decision",
        supersedes: first.id,
      }),
    );
    const { decisions } = await decisionEngine.why("src/auth/");
    const firstDecision = decisions.find((d) => d.summary === "First decision");
    expect(firstDecision!.status).toBe("superseded");
  });

  it("applies defaults (confidence, reversible, agent_id)", async () => {
    const result = await decisionEngine.decide(validDecisionInput());
    const { decisions } = await decisionEngine.why("src/auth/");
    const decision = decisions.find((d) => d.id === result.id);
    expect(decision!.confidence).toBe("medium");
  });

  it("accepts alternatives with optional pros/cons", async () => {
    const result = await decisionEngine.decide(
      validDecisionInput({
        alternatives: [
          {
            option: "Alternative A",
            reason_rejected: "Too complex",
          },
          {
            option: "Alternative B",
            pros: ["Simple"],
            cons: ["Limited"],
            reason_rejected: "Not scalable",
          },
        ],
      }),
    );
    expect(result.id).toHaveLength(26);
  });
});

describe("DecisionEngine.decide with commit_hash", () => {
  it("creates decision with commit_hashes when commit_hash provided", async () => {
    const result = await decisionEngine.decide(
      validDecisionInput({ commit_hash: "abc123" }),
    );
    const decision = await decisionStore.get(result.id);
    expect(decision!.commit_hashes).toEqual(["abc123"]);
  });

  it("creates decision with empty commit_hashes when commit_hash not provided", async () => {
    const result = await decisionEngine.decide(validDecisionInput());
    const decision = await decisionStore.get(result.id);
    expect(decision!.commit_hashes).toEqual([]);
  });
});

describe("DecisionEngine.linkCommit", () => {
  it("links commit to existing decision and returns summary", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.linkCommit(d1.id, "abc123");

    expect(result.linked).toBe(true);
    expect(result.decision_summary).toBe("Use JWT for auth");

    // Verify the commit hash was persisted
    const decision = await decisionStore.get(d1.id);
    expect(decision!.commit_hashes).toContain("abc123");
  });

  it("throws NOT_FOUND for nonexistent decision", async () => {
    await expect(
      decisionEngine.linkCommit("nonexistent", "abc123"),
    ).rejects.toThrow(TwiningError);

    try {
      await decisionEngine.linkCommit("nonexistent", "abc123");
    } catch (e) {
      expect((e as TwiningError).code).toBe("NOT_FOUND");
    }
  });

  it("posts a status entry to blackboard", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    await decisionEngine.linkCommit(d1.id, "abc123def456");

    const { entries } = await blackboardEngine.read({
      entry_types: ["status"],
    });
    const statusEntry = entries.find((e) =>
      e.summary.includes("abc123d"),
    );
    expect(statusEntry).toBeTruthy();
    expect(statusEntry!.summary).toContain("linked to decision");
  });
});

describe("DecisionEngine.getByCommitHash", () => {
  it("returns matching decisions", async () => {
    await decisionEngine.decide(
      validDecisionInput({ commit_hash: "abc123" }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Another decision",
        domain: "testing",
        commit_hash: "def456",
      }),
    );

    const result = await decisionEngine.getByCommitHash("abc123");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.summary).toBe("Use JWT for auth");
    expect(result.decisions[0]!.commit_hashes).toContain("abc123");
  });

  it("returns empty decisions array for unknown hash", async () => {
    const result = await decisionEngine.getByCommitHash("unknown");
    expect(result.decisions).toHaveLength(0);
  });

  it("returns full metadata shape for each decision", async () => {
    await decisionEngine.decide(
      validDecisionInput({ commit_hash: "full123" }),
    );

    const result = await decisionEngine.getByCommitHash("full123");
    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0]!;
    expect(d).toHaveProperty("id");
    expect(d).toHaveProperty("summary");
    expect(d).toHaveProperty("domain");
    expect(d).toHaveProperty("scope");
    expect(d).toHaveProperty("confidence");
    expect(d).toHaveProperty("timestamp");
    expect(d).toHaveProperty("commit_hashes");
    expect(d.id).toHaveLength(26);
    expect(d.domain).toBe("architecture");
    expect(d.scope).toBe("src/auth/");
    expect(d.confidence).toBe("medium");
    expect(d.commit_hashes).toEqual(["full123"]);
  });

  it("returns all decisions linked to the same commit hash", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        summary: "First linked decision",
        commit_hash: "shared999",
      }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Second linked decision",
        domain: "testing",
        commit_hash: "shared999",
      }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Unrelated decision",
        domain: "ops",
        commit_hash: "other111",
      }),
    );

    const result = await decisionEngine.getByCommitHash("shared999");
    expect(result.decisions).toHaveLength(2);
    const summaries = result.decisions.map((d) => d.summary);
    expect(summaries).toContain("First linked decision");
    expect(summaries).toContain("Second linked decision");
  });
});

describe("DecisionEngine.why", () => {
  it("returns decisions matching scope with correct counts", async () => {
    await decisionEngine.decide(validDecisionInput());
    await decisionEngine.decide(
      validDecisionInput({ summary: "Second decision", domain: "testing" }),
    );
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions).toHaveLength(2);
    expect(result.active_count).toBe(2);
    expect(result.provisional_count).toBe(0);
  });

  it("returns empty for non-matching scope", async () => {
    await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.why("src/database/");
    expect(result.decisions).toHaveLength(0);
    expect(result.active_count).toBe(0);
  });

  it("includes alternatives_count in response", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        alternatives: [
          { option: "A", reason_rejected: "No" },
          { option: "B", reason_rejected: "No" },
        ],
      }),
    );
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions[0]!.alternatives_count).toBe(2);
  });

  it("includes commit_hashes for decisions with linked commits", async () => {
    await decisionEngine.decide(
      validDecisionInput({ commit_hash: "abc123" }),
    );
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions[0]!.commit_hashes).toEqual(["abc123"]);
  });

  it("returns empty commit_hashes for decisions without linked commits", async () => {
    await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions[0]!.commit_hashes).toEqual([]);
  });
});

describe("DecisionEngine.trace", () => {
  it("follows depends_on chain upstream", async () => {
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Foundation decision" }),
    );
    const d2 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Middle decision",
        depends_on: [d1.id],
      }),
    );
    const d3 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Leaf decision",
        depends_on: [d2.id],
      }),
    );

    const result = await decisionEngine.trace(d3.id, "upstream");
    expect(result.chain).toHaveLength(2);
    const ids = result.chain.map((c) => c.id);
    expect(ids).toContain(d2.id);
    expect(ids).toContain(d1.id);
  });

  it("finds dependents downstream", async () => {
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Root decision" }),
    );
    const d2 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Child decision",
        depends_on: [d1.id],
      }),
    );
    const d3 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Grandchild decision",
        depends_on: [d2.id],
      }),
    );

    const result = await decisionEngine.trace(d1.id, "downstream");
    expect(result.chain).toHaveLength(2);
    const ids = result.chain.map((c) => c.id);
    expect(ids).toContain(d2.id);
    expect(ids).toContain(d3.id);
  });

  it("combines upstream and downstream when direction is both", async () => {
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Parent" }),
    );
    const d2 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Center",
        depends_on: [d1.id],
      }),
    );
    const d3 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Child",
        depends_on: [d2.id],
      }),
    );

    const result = await decisionEngine.trace(d2.id, "both");
    expect(result.chain).toHaveLength(2);
    const ids = result.chain.map((c) => c.id);
    expect(ids).toContain(d1.id);
    expect(ids).toContain(d3.id);
  });

  it("handles circular dependencies without infinite loops", async () => {
    // Create two decisions that depend on each other (circular)
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Decision A" }),
    );
    const d2 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Decision B",
        depends_on: [d1.id],
      }),
    );
    // Manually add circular dependency by updating d1's depends_on
    const d1Full = await decisionStore.get(d1.id);
    d1Full!.depends_on = [d2.id];
    fs.writeFileSync(
      path.join(tmpDir, "decisions", `${d1.id}.json`),
      JSON.stringify(d1Full, null, 2),
    );

    // Should not hang — visited set prevents infinite loop
    const result = await decisionEngine.trace(d1.id, "both");
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0]!.id).toBe(d2.id);
  });

  it("throws NOT_FOUND for missing decision ID", async () => {
    await expect(
      decisionEngine.trace("nonexistent-id"),
    ).rejects.toThrow(TwiningError);

    try {
      await decisionEngine.trace("nonexistent-id");
    } catch (e) {
      expect((e as TwiningError).code).toBe("NOT_FOUND");
    }
  });

  it("returns empty chain when decision has no dependencies", async () => {
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Standalone" }),
    );

    const result = await decisionEngine.trace(d1.id);
    expect(result.chain).toHaveLength(0);
  });
});

describe("DecisionEngine.reconsider", () => {
  it("sets active decision to provisional and returns flagged: true", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.reconsider(
      d1.id,
      "New requirements emerged",
    );

    expect(result.flagged).toBe(true);
    expect(result.decision_summary).toBe("Use JWT for auth");

    // Verify status changed
    const decision = await decisionStore.get(d1.id);
    expect(decision!.status).toBe("provisional");
  });

  it("posts a warning to blackboard", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    await decisionEngine.reconsider(d1.id, "Perf concerns");

    const { entries } = await blackboardEngine.read({
      entry_types: ["warning"],
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const warning = entries.find((e) =>
      e.summary.includes("Reconsideration flagged"),
    );
    expect(warning).toBeTruthy();
    expect(warning!.detail).toContain("Perf concerns");
  });

  it("returns flagged: false for already-provisional decision", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    await decisionStore.updateStatus(d1.id, "provisional");

    const result = await decisionEngine.reconsider(
      d1.id,
      "Already reconsidered",
    );
    expect(result.flagged).toBe(false);
  });

  it("includes downstream dependent count in warning", async () => {
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Parent decision" }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Child A",
        depends_on: [d1.id],
      }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Child B",
        depends_on: [d1.id],
      }),
    );

    await decisionEngine.reconsider(d1.id, "Needs review");

    const { entries } = await blackboardEngine.read({
      entry_types: ["warning"],
    });
    const warning = entries.find((e) =>
      e.summary.includes("Reconsideration flagged"),
    );
    expect(warning!.detail).toContain(
      "2 downstream decisions may be affected",
    );
  });

  it("throws NOT_FOUND for missing decision", async () => {
    await expect(
      decisionEngine.reconsider("nonexistent", "reason"),
    ).rejects.toThrow(TwiningError);
  });
});

describe("DecisionEngine.override", () => {
  it("sets status to overridden and records reason", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.override(
      d1.id,
      "Security review required different approach",
    );

    expect(result.overridden).toBe(true);
    expect(result.old_summary).toBe("Use JWT for auth");

    const decision = await decisionStore.get(d1.id);
    expect(decision!.status).toBe("overridden");
    expect(decision!.overridden_by).toBe("human");
    expect(decision!.override_reason).toBe(
      "Security review required different approach",
    );
  });

  it("posts override entry to blackboard", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    await decisionEngine.override(
      d1.id,
      "Changed requirements",
      undefined,
      "architect-agent",
    );

    const { entries } = await blackboardEngine.read({
      entry_types: ["decision"],
    });
    const overrideEntry = entries.find((e) =>
      e.summary.includes("Override:"),
    );
    expect(overrideEntry).toBeTruthy();
    expect(overrideEntry!.summary).toContain("overridden by architect-agent");
    expect(overrideEntry!.detail).toBe("Changed requirements");
  });

  it("auto-creates replacement decision when newDecision is provided", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.override(
      d1.id,
      "Session-based is more secure for our case",
      "Use session-based auth instead",
      "security-agent",
    );

    expect(result.new_decision_id).toBeTruthy();
    expect(result.new_decision_id).toHaveLength(26);

    // Verify the new decision was created
    const newDecision = await decisionStore.get(result.new_decision_id!);
    expect(newDecision).toBeTruthy();
    expect(newDecision!.summary).toBe("Use session-based auth instead");
    expect(newDecision!.agent_id).toBe("security-agent");
  });

  it("throws NOT_FOUND for missing decision", async () => {
    await expect(
      decisionEngine.override("nonexistent", "reason"),
    ).rejects.toThrow(TwiningError);
  });
});

describe("DecisionEngine STATE.md sync", () => {
  const stateTemplate = `# Project State

## Current Position

Phase: 1 of 3
Plan: 1 of 2

## Accumulated Context

### Decisions

v1 decisions:
- Previous decision here

### Pending Todos

None.
`;

  it("appends decision summary to STATE.md Decisions section", async () => {
    // Create .planning/STATE.md in a separate project root
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-state-sync-test-"),
    );
    const planningDir = path.join(projectRoot, ".planning");
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, "STATE.md"), stateTemplate);

    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      projectRoot,
    );

    await engine.decide(validDecisionInput({ summary: "Use Redis for caching" }));

    const content = fs.readFileSync(
      path.join(planningDir, "STATE.md"),
      "utf-8",
    );
    expect(content).toContain("- Use Redis for caching");
    // Should be in the Decisions section, before Pending Todos
    const decisionsIdx = content.indexOf("### Decisions");
    const todosIdx = content.indexOf("### Pending Todos");
    const newEntryIdx = content.indexOf("- Use Redis for caching");
    expect(newEntryIdx).toBeGreaterThan(decisionsIdx);
    expect(newEntryIdx).toBeLessThan(todosIdx);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("works normally when projectRoot is null (no sync)", async () => {
    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      null,
    );

    const result = await engine.decide(validDecisionInput());
    expect(result.id).toHaveLength(26);
    // No error thrown — passes silently
  });

  it("works normally when .planning/STATE.md does not exist", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-state-sync-test-"),
    );
    // No .planning/ directory created

    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      projectRoot,
    );

    const result = await engine.decide(validDecisionInput());
    expect(result.id).toHaveLength(26);
    // No error thrown — passes silently

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("does not crash when STATE.md is missing Decisions section", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-state-sync-test-"),
    );
    const planningDir = path.join(projectRoot, ".planning");
    fs.mkdirSync(planningDir, { recursive: true });
    // STATE.md without a Decisions section
    fs.writeFileSync(
      path.join(planningDir, "STATE.md"),
      "# Project State\n\n## Current Position\n\nSome content here.\n",
    );

    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      projectRoot,
    );

    const result = await engine.decide(validDecisionInput());
    expect(result.id).toHaveLength(26);
    // No error thrown, file unchanged
    const content = fs.readFileSync(
      path.join(planningDir, "STATE.md"),
      "utf-8",
    );
    expect(content).not.toContain("Use JWT for auth");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

describe("DecisionEngine conflict detection", () => {
  it("marks new decision as provisional when same domain+scope has active decision", async () => {
    // First decision — active
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for auth" }),
    );

    // Second decision in same domain+scope with different summary — should conflict
    const result = await decisionEngine.decide(
      validDecisionInput({ summary: "Use sessions for auth" }),
    );

    expect(result.conflicts).toBeTruthy();
    expect(result.conflicts!.length).toBe(1);
    expect(result.conflicts![0]!.summary).toBe("Use JWT for auth");

    // Verify new decision is provisional
    const decision = await decisionStore.get(result.id);
    expect(decision!.status).toBe("provisional");
  });

  it("posts warning to blackboard on conflict", async () => {
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for auth" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use sessions for auth" }),
    );

    const { entries } = await blackboardEngine.read({
      entry_types: ["warning"],
    });
    const conflictWarning = entries.find((e) =>
      e.summary.includes("Potential conflict"),
    );
    expect(conflictWarning).toBeTruthy();
  });

  it("does not conflict with different domain same scope", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/auth/",
        summary: "Use JWT",
      }),
    );
    const result = await decisionEngine.decide(
      validDecisionInput({
        domain: "testing",
        scope: "src/auth/",
        summary: "Use mocks for auth tests",
      }),
    );

    expect(result.conflicts).toBeUndefined();
  });

  it("does not conflict with same domain different scope (no prefix overlap)", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/auth/",
        summary: "Use JWT",
      }),
    );
    const result = await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/database/",
        summary: "Use Postgres",
      }),
    );

    expect(result.conflicts).toBeUndefined();
  });

  it("detects conflict with prefix-overlapping scope", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/",
        summary: "Use functional patterns",
      }),
    );
    // More specific scope that overlaps via prefix
    const result = await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/auth/",
        summary: "Use OOP patterns for auth",
      }),
    );

    expect(result.conflicts).toBeTruthy();
    expect(result.conflicts!.length).toBe(1);
  });

  it("does not conflict with same summary (re-creation)", async () => {
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for auth" }),
    );
    const result = await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for auth" }),
    );

    // Same summary should not be treated as a conflict
    expect(result.conflicts).toBeUndefined();
  });
});

describe("DecisionEngine.searchDecisions", () => {
  it("finds decisions by keyword", async () => {
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for authentication" }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Use PostgreSQL for database",
        domain: "database",
        scope: "src/db/",
      }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Use Redis for caching",
        domain: "infrastructure",
        scope: "src/cache/",
      }),
    );

    const result = await decisionEngine.searchDecisions("JWT authentication");
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.summary).toContain("JWT");
    expect(result.results[0]!.relevance).toBeGreaterThan(0);
    expect(result.fallback_mode).toBe(true);
  });

  it("filters by domain", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Use JWT for auth",
        domain: "architecture",
      }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Use integration tests for auth",
        domain: "implementation",
        scope: "src/tests/",
      }),
    );

    const result = await decisionEngine.searchDecisions("auth", {
      domain: "architecture",
    });
    expect(result.results.length).toBe(1);
    expect(result.results[0]!.domain).toBe("architecture");
  });

  it("filters by status", async () => {
    await decisionEngine.decide(
      validDecisionInput({ summary: "Active auth decision" }),
    );
    const d2 = await decisionEngine.decide(
      validDecisionInput({
        summary: "Overridden auth decision",
        domain: "testing",
        scope: "src/tests/",
      }),
    );
    await decisionStore.updateStatus(d2.id, "overridden");

    const result = await decisionEngine.searchDecisions("auth", {
      status: "active",
    });
    // Only active decisions should be returned
    for (const r of result.results) {
      expect(r.status).toBe("active");
    }
    const overriddenSummaries = result.results.filter(
      (r) => r.summary === "Overridden auth decision",
    );
    expect(overriddenSummaries).toHaveLength(0);
  });

  it("filters by confidence", async () => {
    await decisionEngine.decide(
      validDecisionInput({
        summary: "High confidence auth decision",
        confidence: "high",
      }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Low confidence auth decision",
        confidence: "low",
        domain: "testing",
        scope: "src/tests/",
      }),
    );

    const result = await decisionEngine.searchDecisions("auth", {
      confidence: "high",
    });
    expect(result.results.length).toBe(1);
    expect(result.results[0]!.confidence).toBe("high");
  });

  it("returns empty results for empty query", async () => {
    await decisionEngine.decide(validDecisionInput());

    const result = await decisionEngine.searchDecisions("");
    expect(result.results).toEqual([]);
    expect(result.total_matched).toBe(0);
    expect(result.fallback_mode).toBe(true);
  });

  it("returns empty results for no matches", async () => {
    await decisionEngine.decide(validDecisionInput());

    const result =
      await decisionEngine.searchDecisions("xyzzy gibberish nonsense");
    expect(result.results).toEqual([]);
    expect(result.total_matched).toBe(0);
    expect(result.fallback_mode).toBe(true);
  });
});

describe("DecisionEngine.promote", () => {
  it("promotes provisional decisions to active", async () => {
    // Create two decisions in same domain+scope to trigger conflict → provisional
    const d1 = await decisionEngine.decide(validDecisionInput());
    const d2 = await decisionEngine.decide(
      validDecisionInput({ summary: "Use OAuth for auth" }),
    );

    // d2 should be provisional due to conflict
    const before = await decisionStore.get(d2.id);
    expect(before!.status).toBe("provisional");

    const result = await decisionEngine.promote([d2.id]);
    expect(result.promoted).toEqual([d2.id]);
    expect(result.already_active).toEqual([]);
    expect(result.not_found).toEqual([]);
    expect(result.wrong_status).toEqual([]);

    const after = await decisionStore.get(d2.id);
    expect(after!.status).toBe("active");
  });

  it("returns already_active for active decisions", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.promote([d1.id]);
    expect(result.already_active).toEqual([d1.id]);
    expect(result.promoted).toEqual([]);
  });

  it("returns not_found for missing IDs", async () => {
    const result = await decisionEngine.promote(["nonexistent"]);
    expect(result.not_found).toEqual(["nonexistent"]);
    expect(result.promoted).toEqual([]);
  });

  it("returns wrong_status for overridden decisions", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    await decisionEngine.override(d1.id, "outdated");

    const result = await decisionEngine.promote([d1.id]);
    expect(result.wrong_status).toEqual([
      { id: d1.id, status: "overridden" },
    ]);
    expect(result.promoted).toEqual([]);
  });

  it("posts a status entry to blackboard when decisions are promoted", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const d2 = await decisionEngine.decide(
      validDecisionInput({ summary: "Use OAuth for auth" }),
    );

    await decisionEngine.promote([d2.id]);

    const { entries } = await blackboardStore.read();
    const statusEntries = entries.filter((e) => e.entry_type === "status");
    const promoteEntry = statusEntries.find((e) =>
      e.summary.includes("Promoted"),
    );
    expect(promoteEntry).toBeDefined();
    expect(promoteEntry!.summary).toContain("1 provisional decision(s)");
    expect(promoteEntry!.detail).toContain(d2.id);
  });

  it("does not post status entry when nothing is promoted", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const beforeEntries = (await blackboardStore.read()).entries.length;

    await decisionEngine.promote([d1.id]); // already active

    const afterEntries = (await blackboardStore.read()).entries.length;
    expect(afterEntries).toBe(beforeEntries);
  });

  it("handles mixed batch of IDs correctly", async () => {
    const d1 = await decisionEngine.decide(validDecisionInput());
    const d2 = await decisionEngine.decide(
      validDecisionInput({ summary: "Use OAuth for auth" }),
    );
    await decisionEngine.override(d1.id, "outdated");

    const result = await decisionEngine.promote([
      d2.id,
      d1.id,
      "nonexistent",
    ]);
    expect(result.promoted).toEqual([d2.id]);
    expect(result.wrong_status).toEqual([
      { id: d1.id, status: "overridden" },
    ]);
    expect(result.not_found).toEqual(["nonexistent"]);
  });
});
