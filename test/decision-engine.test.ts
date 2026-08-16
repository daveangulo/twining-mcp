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

  it("does not cross-post the decision to the blackboard (issue #30)", async () => {
    await decisionEngine.decide(validDecisionInput());
    const { entries } = await blackboardEngine.read({
      entry_types: ["decision"],
    });
    expect(entries).toHaveLength(0);
    // Decision lives only in the decision store
    const index = await decisionStore.getIndex();
    expect(index).toHaveLength(1);
    expect(index[0]!.summary).toBe("Use JWT for auth");
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
    const { decisions } = await decisionEngine.why("src/auth/", {
      include_superseded: true,
    });
    const firstDecision = decisions.find((d) => d.summary === "First decision");
    expect(firstDecision!.status).toBe("superseded");
  });

  it("writes the superseded_by back-link onto the superseded decision (#31)", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "First decision" }),
    );
    const second = await decisionEngine.decide(
      validDecisionInput({
        summary: "Second decision",
        supersedes: first.id,
      }),
    );
    const stored = await decisionStore.get(first.id);
    expect(stored!.superseded_by).toBe(second.id);
    // The replacement itself carries no back-link.
    const replacement = await decisionStore.get(second.id);
    expect(replacement!.superseded_by).toBeUndefined();
  });

  it("does not flag the superseded decision as a conflict of its replacement", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "First decision" }),
    );
    const result = await decisionEngine.decide(
      validDecisionInput({
        summary: "Second decision",
        supersedes: first.id,
      }),
    );
    expect(result.conflicts ?? []).toEqual([]);
  });

  it("tolerates a dangling supersedes target but reports it (field D10)", async () => {
    const result = await decisionEngine.decide(
      validDecisionInput({
        summary: "Replacement of a ghost",
        supersedes: "01GHOST00000000000000000000",
      }),
    );
    expect(result.id).toHaveLength(26);
    // No throw — but a typo'd target must not be indistinguishable from success.
    expect(result.supersedes_dangling).toBe("01GHOST00000000000000000000");
  });

  it("does not set supersedes_dangling when the target exists", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "Real target" }),
    );
    const result = await decisionEngine.decide(
      validDecisionInput({ summary: "Replacement", supersedes: first.id }),
    );
    expect(result.supersedes_dangling).toBeUndefined();
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

describe("DecisionEngine.decide — depends_on validation (decision F)", () => {
  it("drops unknown depends_on ids and reports them, keeping only the valid id", async () => {
    const valid = await decisionEngine.decide(
      validDecisionInput({ summary: "Foundation decision" }),
    );

    const result = await decisionEngine.decide(
      validDecisionInput({
        summary: "Dependent decision",
        depends_on: [valid.id, "01NOTREALDECISIONIDXXXXXXX", "01ALSOFAKEDECISIONIDXXXXXX"],
      }),
    );

    expect(result.dropped_depends_on).toBeDefined();
    expect(result.dropped_depends_on).toEqual(
      expect.arrayContaining([
        "01NOTREALDECISIONIDXXXXXXX",
        "01ALSOFAKEDECISIONIDXXXXXX",
      ]),
    );
    expect(result.dropped_depends_on!.length).toBe(2);

    const stored = await decisionStore.get(result.id);
    expect(stored!.depends_on).toEqual([valid.id]);
  });

  it("does not set dropped_depends_on when all depends_on ids are valid (regression)", async () => {
    const d1 = await decisionEngine.decide(
      validDecisionInput({ summary: "Root decision" }),
    );
    const result = await decisionEngine.decide(
      validDecisionInput({
        summary: "Dependent decision",
        depends_on: [d1.id],
      }),
    );

    expect(result.dropped_depends_on).toBeUndefined();
    const stored = await decisionStore.get(result.id);
    expect(stored!.depends_on).toEqual([d1.id]);
  });

  it("omits dropped_depends_on entirely when depends_on is not provided", async () => {
    const result = await decisionEngine.decide(validDecisionInput());
    expect(result.dropped_depends_on).toBeUndefined();
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

  it("surfaces superseded_by on retired decisions so readers can find the replacement (#31)", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "First decision" }),
    );
    const second = await decisionEngine.decide(
      validDecisionInput({ summary: "Second decision", supersedes: first.id }),
    );
    const { decisions } = await decisionEngine.why("src/auth/", {
      include_superseded: true,
    });
    const retired = decisions.find((d) => d.id === first.id);
    expect(retired!.superseded_by).toBe(second.id);
    const replacement = decisions.find((d) => d.id === second.id);
    expect(replacement!.superseded_by).toBeUndefined();
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

describe("DecisionEngine registry auto-touch (#32)", () => {
  it("registers the deciding agent via the blackboard engine's agent store", async () => {
    const { AgentStore } = await import("../src/storage/agent-store.js");
    const agentStore = new AgentStore(tmpDir);
    blackboardEngine.setAgentStore(agentStore);

    await decisionEngine.decide(
      validDecisionInput({ agent_id: "architect-2" }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const agent = await agentStore.get("architect-2");
    expect(agent).toBeTruthy();
  });
});

describe("DecisionEngine.why bounding (#41)", () => {
  it("excludes superseded decisions by default and reports superseded_count", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "Old choice" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "New choice", supersedes: first.id }),
    );
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions.map((d) => d.summary)).toEqual(["New choice"]);
    expect(result.superseded_count).toBe(1);
  });

  it("returns superseded decisions when include_superseded is true", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "Old choice" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "New choice", supersedes: first.id }),
    );
    const result = await decisionEngine.why("src/auth/", {
      include_superseded: true,
    });
    expect(result.decisions).toHaveLength(2);
    const retired = result.decisions.find((d) => d.id === first.id);
    expect(retired!.status).toBe("superseded");
  });

  it("caps superseded_excluded at 20 entries", async () => {
    for (let i = 0; i < 21; i++) {
      const target = await decisionEngine.decide(
        validDecisionInput({ summary: `Target ${i}` }),
      );
      await decisionEngine.decide(
        validDecisionInput({ summary: `Replacement ${i}`, supersedes: target.id }),
      );
    }
    const result = await decisionEngine.why("src/auth/");
    expect(result.superseded_count).toBe(21);
    expect(result.superseded_excluded).toHaveLength(20);
  });

  it("superseded_count excludes archived — archived are counted only by archived_excluded_count (field D10)", async () => {
    const a = await decisionEngine.decide(
      validDecisionInput({ summary: "Old choice" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "New choice", supersedes: a.id }),
    );
    const b = await decisionEngine.decide(
      validDecisionInput({ summary: "Archived choice" }),
    );
    await decisionStore.updateStatus(b.id, "archived", {
      archived_from: "active",
    });

    const result = await decisionEngine.why("src/auth/");
    expect(result.superseded_count).toBe(1);
    expect(result.archived_excluded_count).toBe(1);
  });

  it("reports excluded superseded records compactly with their successor (field D10)", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "Eight concretizations in one record" }),
    );
    const second = await decisionEngine.decide(
      validDecisionInput({ summary: "Amends one limb", supersedes: first.id }),
    );

    const result = await decisionEngine.why("src/auth/");
    expect(result.superseded_excluded).toBeDefined();
    expect(result.superseded_excluded).toHaveLength(1);
    expect(result.superseded_excluded![0]).toMatchObject({
      id: first.id,
      summary: "Eight concretizations in one record",
      superseded_by: second.id,
    });

    const withRetired = await decisionEngine.why("src/auth/", {
      include_superseded: true,
    });
    expect(withRetired.superseded_excluded).toBeUndefined();
  });

  it("total_in_scope counts live decisions only by default, all statuses with include_superseded", async () => {
    // Field consumers use total_in_scope as the absence instrument for a
    // "no decision authorizes X" gate — it must be the live in-scope
    // population, never page occupancy and never inflated by retired records.
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "Old choice" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "New choice", supersedes: first.id }),
    );
    await decisionEngine.decide(validDecisionInput({ summary: "Third choice" }));

    const result = await decisionEngine.why("src/auth/");
    expect(result.total_in_scope).toBe(2);
    expect(result.superseded_count).toBe(1);

    const withRetired = await decisionEngine.why("src/auth/", {
      include_superseded: true,
    });
    expect(withRetired.total_in_scope).toBe(3);
  });

  it("ranks exact-scope matches above ancestor-scope matches regardless of recency", async () => {
    // Ancestor-scoped decision recorded LAST (most recent) — must still rank below.
    await decisionEngine.decide(
      validDecisionInput({ scope: "src/auth/", summary: "Exact match" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ scope: "src/", summary: "Broad ancestor" }),
    );
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions[0]!.summary).toBe("Exact match");
    expect(result.decisions[1]!.summary).toBe("Broad ancestor");
  });

  it("ranks descendant-scope matches above ancestor-scope matches", async () => {
    await decisionEngine.decide(
      validDecisionInput({ scope: "src/", summary: "Broad ancestor" }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        scope: "src/auth/jwt.ts",
        summary: "Descendant file",
      }),
    );
    const result = await decisionEngine.why("src/auth/");
    expect(result.decisions[0]!.summary).toBe("Descendant file");
  });

  it("does not truncate small result sets at the default budget", async () => {
    await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.why("src/auth/");
    expect(result.truncated).toBe(false);
    expect(result.more).toBeUndefined();
    expect(result.total_in_scope).toBe(1);
  });

  it("moves overflow decisions to a compact tier under a small max_tokens budget", async () => {
    for (let i = 0; i < 10; i++) {
      await decisionEngine.decide(
        validDecisionInput({
          summary: `Decision number ${i}`,
          rationale: "R".repeat(400),
        }),
      );
    }
    const result = await decisionEngine.why("src/auth/", { max_tokens: 300 });
    expect(result.truncated).toBe(true);
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.decisions.length).toBeLessThan(10);
    expect(result.more!.length).toBe(10 - result.decisions.length);
    expect(result.total_in_scope).toBe(10);
    // Compact tier carries no rationale — that's the point.
    for (const compact of result.more!) {
      expect(compact).not.toHaveProperty("rationale");
      expect(compact.id).toBeTruthy();
      expect(compact.summary).toBeTruthy();
      expect(compact.status).toBeTruthy();
    }
  });

  it("caps the compact tier at 50 entries and reports the omitted count", async () => {
    for (let i = 0; i < 60; i++) {
      await decisionEngine.decide(
        validDecisionInput({ summary: `Decision number ${i}` }),
      );
    }
    // Budget of 1 token: everything overflows to the compact tier.
    const result = await decisionEngine.why("src/auth/", { max_tokens: 1 });
    expect(result.decisions).toHaveLength(0);
    expect(result.more!).toHaveLength(50);
    expect(result.omitted_count).toBe(10);
    expect(result.total_in_scope).toBe(60);
  });

  it("reports a token_estimate for the full-tier payload", async () => {
    await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.why("src/auth/");
    expect(result.token_estimate).toBeGreaterThan(0);
  });

  it("returns full detail for explicit ids, bypassing the budget", async () => {
    const created = [];
    for (let i = 0; i < 3; i++) {
      created.push(
        await decisionEngine.decide(
          validDecisionInput({
            summary: `Decision ${i}`,
            rationale: "R".repeat(2000),
            alternatives: [{ option: "Alt", reason_rejected: "No" }],
          }),
        ),
      );
    }
    const result = await decisionEngine.why("src/auth/", {
      ids: [created[0]!.id, created[2]!.id],
      max_tokens: 10,
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.truncated).toBe(false);
    const detail = result.decisions[0]!;
    expect(detail.rationale).toBe("R".repeat(2000));
    // Drill-down returns the pieces the tiered response withheld.
    expect(detail.context).toBe("Need stateless auth");
    expect(detail.alternatives).toMatchObject([
      { option: "Alt", reason_rejected: "No" },
    ]);
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

  it("does not post a decision-type entry to the blackboard (issue #30)", async () => {
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
    expect(entries).toHaveLength(0);
    // The override outcome lives in the decision store
    const decision = await decisionStore.get(d1.id);
    expect(decision!.status).toBe("overridden");
    expect(decision!.override_reason).toBe("Changed requirements");
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
  it("keeps new decision active when same domain+scope has active decision", async () => {
    // First decision — active
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for auth" }),
    );

    // Second decision in same domain+scope with different summary — should note overlap
    const result = await decisionEngine.decide(
      validDecisionInput({ summary: "Use sessions for auth" }),
    );

    expect(result.conflicts).toBeTruthy();
    expect(result.conflicts!.length).toBe(1);
    expect(result.conflicts![0]!.summary).toBe("Use JWT for auth");

    // New decision stays active (not provisional) — conflict is informational
    const decision = await decisionStore.get(result.id);
    expect(decision!.status).toBe("active");
  });

  it("posts finding (not warning) to blackboard on conflict", async () => {
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use JWT for auth" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "Use sessions for auth" }),
    );

    const { entries } = await blackboardEngine.read({
      entry_types: ["finding"],
    });
    const conflictFinding = entries.find((e) =>
      e.summary.includes("Related decisions"),
    );
    expect(conflictFinding).toBeTruthy();
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

  it("detects conflict when existing decision is at same-or-narrower scope", async () => {
    // Decision at specific scope
    await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/auth/",
        summary: "Use JWT for auth",
      }),
    );
    // Broader decision at parent scope — should find the narrower conflict
    const result = await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/",
        summary: "Use OOP patterns everywhere",
      }),
    );

    expect(result.conflicts).toBeTruthy();
    expect(result.conflicts!.length).toBe(1);
  });

  it("does not flag broader decisions as conflicts for narrower new decisions", async () => {
    // Broad decision at src/
    await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/",
        summary: "Use functional patterns",
      }),
    );
    // Narrower decision at src/auth/ — broad decision should NOT conflict
    const result = await decisionEngine.decide(
      validDecisionInput({
        domain: "architecture",
        scope: "src/auth/",
        summary: "Use OOP for auth",
      }),
    );

    expect(result.conflicts ?? []).toHaveLength(0);
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
  it("reports total_matched pre-slice and returned as the page size (field D9)", async () => {
    for (let i = 0; i < 5; i++) {
      await decisionEngine.decide(
        validDecisionInput({ summary: `Cache layer option ${i}` }),
      );
    }
    const result = await decisionEngine.searchDecisions("cache", undefined, 2);
    expect(result.results).toHaveLength(2);
    expect(result.returned).toBe(2);
    expect(result.total_matched).toBe(5);
  });

  it("de-ranks retired decisions below an identically-matching active one", async () => {
    const first = await decisionEngine.decide(
      validDecisionInput({ summary: "Use Redis cache for sessions" }),
    );
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Use Redis cache for sessions",
        supersedes: first.id,
      }),
    );
    const result = await decisionEngine.searchDecisions("Redis cache");
    expect(result.results.length).toBe(2);
    expect(result.results[0]!.status).toBe("active");
  });

  it("de-ranks all three retired statuses, not only superseded", async () => {
    const overridden = await decisionEngine.decide(
      validDecisionInput({ summary: "Shared identical summary text" }),
    );
    const archived = await decisionEngine.decide(
      validDecisionInput({ summary: "Shared identical summary text" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "Shared identical summary text" }),
    );
    await decisionStore.updateStatus(overridden.id, "overridden");
    await decisionStore.updateStatus(archived.id, "archived", {
      archived_from: "active",
    });

    const result = await decisionEngine.searchDecisions("shared identical");
    expect(result.results[0]!.status).toBe("active");
    const activeRelevance = result.results[0]!.relevance;
    for (const row of result.results.slice(1)) {
      expect(row.relevance).toBeLessThan(activeRelevance);
    }
  });

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
    // Create a decision and manually set it to provisional
    const d1 = await decisionEngine.decide(validDecisionInput());
    const d2 = await decisionEngine.decide(
      validDecisionInput({ summary: "Use OAuth for auth" }),
    );
    await decisionStore.updateStatus(d2.id, "provisional");

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

  it("stamps promoted_by and promoted_at on the promoted record (D15 attribution)", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    await decisionStore.updateStatus(d.id, "provisional");

    await decisionEngine.promote([d.id], "ratifier");
    const after = await decisionStore.get(d.id);
    expect(after!.promoted_by).toBe("ratifier");
    expect(after!.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults promoted_by to main", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    await decisionStore.updateStatus(d.id, "provisional");
    await decisionEngine.promote([d.id]);
    expect((await decisionStore.get(d.id))!.promoted_by).toBe("main");
  });

  it("already_active_detail carries the prior promotion's attribution (D15)", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    await decisionStore.updateStatus(d.id, "provisional");
    await decisionEngine.promote([d.id], "first-agent");

    // The MCP-retry / concurrent-session shape: a second promote must be
    // distinguishable from "was never provisional".
    const again = await decisionEngine.promote([d.id], "second-agent");
    expect(again.promoted).toEqual([]);
    expect(again.already_active).toEqual([d.id]);
    expect(again.already_active_detail).toEqual([
      { id: d.id, promoted_by: "first-agent", promoted_at: expect.any(String) },
    ]);
    // The second call must not overwrite the original attribution.
    expect((await decisionStore.get(d.id))!.promoted_by).toBe("first-agent");
  });

  it("already_active_detail has bare ids for decisions active since creation", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    const result = await decisionEngine.promote([d.id]);
    expect(result.already_active_detail).toEqual([{ id: d.id }]);
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
    await decisionStore.updateStatus(d2.id, "provisional");

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
    await decisionStore.updateStatus(d2.id, "provisional");
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

describe("DecisionEngine.searchDecisions — semantic path (review findings)", () => {
  // Stub embedder: SearchEngine only needs isFallbackMode() and embed().
  // Vectors are hand-crafted so cosine (dot product) is exact: query [1,0].
  function semanticHarness() {
    const stubEmbedder = {
      isFallbackMode: () => false,
      embed: async () => [1, 0],
    };
    return stubEmbedder as unknown as import("../src/embeddings/embedder.js").Embedder;
  }

  it("delegation branch reports above-floor total_matched, returned, and de-boosts retired decisions", async () => {
    const { IndexManager } = await import("../src/embeddings/index-manager.js");
    const { SearchEngine } = await import("../src/embeddings/search.js");
    const embedder = semanticHarness();
    const indexManager = new IndexManager(tmpDir);
    const searchEngine = new SearchEngine(embedder, indexManager);
    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      null,
      searchEngine,
    );

    // Two identical strong matches (cosine 1.0), one superseded; one noise
    // decision (cosine 0.0, below the 0.3 floor).
    const active = await engine.decide(
      validDecisionInput({ summary: "Use Redis cache for sessions" }),
    );
    const old = await engine.decide(
      validDecisionInput({ summary: "Use Redis cache for sessions (v1)" }),
    );
    await engine.decide(
      validDecisionInput({ summary: "Replacement", supersedes: old.id }),
    );
    const noise = await engine.decide(
      validDecisionInput({ summary: "Unrelated marmalade flurbulator" }),
    );

    // The replacement also needs a vector; give strong matches [1,0]-aligned
    // vectors and the noise decision an orthogonal one.
    await indexManager.addEntry("decisions", active.id, [1, 0], "h1");
    await indexManager.addEntry("decisions", old.id, [1, 0], "h2");
    await indexManager.addEntry("decisions", noise.id, [0, 1], "h3");

    const result = await engine.searchDecisions("redis cache");
    expect(result.fallback_mode).toBe(false);

    // De-boost: identical cosine, but the superseded record ranks below the
    // active one at 0.75x relevance.
    const activeRow = result.results.find((r) => r.id === active.id)!;
    const oldRow = result.results.find((r) => r.id === old.id)!;
    expect(activeRow.relevance).toBeCloseTo(1.0, 5);
    expect(oldRow.relevance).toBeCloseTo(0.75, 5);
    expect(result.results.indexOf(activeRow)).toBeLessThan(
      result.results.indexOf(oldRow),
    );

    // total_matched counts only above-floor matches: the noise decision
    // (cosine 0) and the un-embedded replacement are excluded; returned is
    // the page size.
    expect(result.total_matched).toBe(2);
    expect(result.returned).toBe(result.results.length);
  });

  it("counts membership on RAW cosine — the de-boost never deflates total_matched", async () => {
    const { IndexManager } = await import("../src/embeddings/index-manager.js");
    const { SearchEngine } = await import("../src/embeddings/search.js");
    const embedder = semanticHarness();
    const indexManager = new IndexManager(tmpDir);
    const searchEngine = new SearchEngine(embedder, indexManager);
    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      null,
      searchEngine,
    );

    // A superseded decision at raw cosine 0.38 — a genuine match above the
    // 0.3 floor — whose de-boosted display relevance (0.285) dips below it.
    const old = await engine.decide(
      validDecisionInput({ summary: "The only decision on this topic" }),
    );
    await engine.decide(
      validDecisionInput({ summary: "Replacement", supersedes: old.id }),
    );
    await indexManager.addEntry("decisions", old.id, [0.38, 0.925], "h1");

    const result = await engine.searchDecisions("topic query");
    const row = result.results.find((r) => r.id === old.id)!;
    expect(row.relevance).toBeCloseTo(0.285, 3);
    // Membership from the RAW 0.38, not the weighted 0.285.
    expect(result.total_matched).toBe(1);
  });

  it("counts every literal keyword hit as a match — TF scores are not held to the cosine floor", async () => {
    // Fallback path: 3-term query, decision mentions exactly one term once.
    // TF score = ln(2)/3 = 0.231 < 0.3, but a literal hit is never noise.
    await decisionEngine.decide(
      validDecisionInput({
        summary: "Reworked the handoff store",
        rationale: "Persistence change",
        context: "storage work",
      }),
    );
    const result = await decisionEngine.searchDecisions(
      "handoff scoping filtration",
    );
    expect(result.results).toHaveLength(1);
    expect(result.total_matched).toBe(1);
  });
});

describe("DecisionEngine.why — lineage resolution (field D13 ask 3)", () => {
  it("attaches the lineage head to excluded superseded records when lineage: true", async () => {
    const a = await decisionEngine.decide(
      validDecisionInput({ summary: "Original" }),
    );
    const b = await decisionEngine.decide(
      validDecisionInput({ summary: "First amendment", supersedes: a.id }),
    );
    const c = await decisionEngine.decide(
      validDecisionInput({ summary: "Current head", supersedes: b.id }),
    );

    const result = await decisionEngine.why("src/auth/", { lineage: true });
    const excludedA = result.superseded_excluded!.find((e) => e.id === a.id)!;
    const excludedB = result.superseded_excluded!.find((e) => e.id === b.id)!;
    expect(excludedA.lineage_head).toMatchObject({
      id: c.id,
      summary: "Current head",
      chain_length: 2,
    });
    expect(excludedB.lineage_head).toMatchObject({ id: c.id, chain_length: 1 });
  });

  it("omits lineage by default and never attaches it to live decisions", async () => {
    const a = await decisionEngine.decide(
      validDecisionInput({ summary: "Original" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "Head", supersedes: a.id }),
    );
    const plain = await decisionEngine.why("src/auth/");
    expect(plain.superseded_excluded![0]!.lineage_head).toBeUndefined();
    const withLineage = await decisionEngine.why("src/auth/", { lineage: true });
    for (const d of withLineage.decisions) {
      expect((d as Record<string, unknown>).lineage_head).toBeUndefined();
    }
  });

  it("terminates on a superseded_by cycle", async () => {
    const a = await decisionEngine.decide(
      validDecisionInput({ summary: "Cycle A" }),
    );
    const b = await decisionEngine.decide(
      validDecisionInput({ summary: "Cycle B", supersedes: a.id }),
    );
    // Manufacture the cycle: B superseded back by A.
    await decisionStore.updateStatus(b.id, "superseded", { superseded_by: a.id });
    await decisionStore.updateStatus(a.id, "superseded", { superseded_by: b.id });

    const result = await decisionEngine.why("src/auth/", { lineage: true });
    // Both are retired; the walker must terminate and report SOME head —
    // and the cycle's wrap-around edge must not inflate chain_length (the
    // 2-node cycle has exactly 2 distinct records).
    for (const e of result.superseded_excluded!) {
      expect(e.lineage_head).toBeDefined();
      expect(e.lineage_head!.chain_length).toBe(2);
    }
  });
});

describe("DecisionEngine.amend — append-only metadata repair (field D11)", () => {
  it("adds affected_files/affected_symbols, records provenance, and makes the decision retrievable by file", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ summary: "Empty-list record from the D7 era" }),
    );

    const result = await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["specs/governed.md"],
      add_affected_symbols: ["Kernel.emit"],
      reason: "backfill after D7",
      agent_id: "repair-agent",
    });
    expect(result.added_files).toEqual(["specs/governed.md"]);
    expect(result.added_symbols).toEqual(["Kernel.emit"]);

    const stored = await decisionStore.get(d.id);
    expect(stored!.affected_files).toEqual(["specs/governed.md"]);
    expect(stored!.affected_symbols).toEqual(["Kernel.emit"]);
    expect(stored!.amendments).toHaveLength(1);
    expect(stored!.amendments![0]).toMatchObject({
      amended_by: "repair-agent",
      added_files: ["specs/governed.md"],
      added_symbols: ["Kernel.emit"],
      reason: "backfill after D7",
    });
    expect(stored!.amendments![0]!.amended_at).toBeTruthy();

    // Invariant 1: file-backend retrieval reads affected_files from the
    // INDEX — the amend must reach it, or the repair is invisible.
    const byFile = await decisionStore.getByScope("specs/governed.md");
    expect(byFile.map((x) => x.id)).toContain(d.id);
    const indexEntry = (await decisionStore.getIndex()).find(
      (e) => e.id === d.id,
    )!;
    expect(indexEntry.affected_files).toEqual(["specs/governed.md"]);
  });

  it("is add-only and idempotent: existing entries are never removed or duplicated", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({
        summary: "Already has one file",
        affected_files: ["src/auth/jwt.ts"],
      }),
    );

    const result = await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["src/auth/jwt.ts", "src/auth/middleware.ts"],
    });
    expect(result.added_files).toEqual(["src/auth/middleware.ts"]);
    expect(result.already_present).toEqual(["src/auth/jwt.ts"]);

    const again = await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["src/auth/middleware.ts"],
    });
    expect(again.added_files).toEqual([]);

    const stored = await decisionStore.get(d.id);
    expect(stored!.affected_files).toEqual([
      "src/auth/jwt.ts",
      "src/auth/middleware.ts",
    ]);
    // A no-op amend appends no provenance entry.
    expect(stored!.amendments).toHaveLength(1);
  });

  it("amends retired records without touching their status", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ summary: "Superseded but factual" }),
    );
    await decisionEngine.decide(
      validDecisionInput({ summary: "Replacement", supersedes: d.id }),
    );

    await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["specs/old-target.md"],
    });
    const stored = await decisionStore.get(d.id);
    expect(stored!.status).toBe("superseded");
    expect(stored!.superseded_by).toBeTruthy();
    expect(stored!.affected_files).toEqual(["specs/old-target.md"]);
  });

  it("adds graph edges for newly added paths only — existing files gain no duplicate decided_by", async () => {
    const { GraphStore } = await import("../src/storage/graph-store.js");
    const { GraphEngine } = await import("../src/engine/graph.js");
    const { GraphAutoPopulator } = await import(
      "../src/engine/graph-auto-populator.js"
    );
    fs.mkdirSync(path.join(tmpDir, "graph"), { recursive: true });
    const graphStore = new GraphStore(tmpDir);
    const graphEngine = new GraphEngine(graphStore);
    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      null,
      null,
      new GraphAutoPopulator(graphEngine),
    );

    const d = await engine.decide(
      validDecisionInput({
        summary: "Has one declared file",
        affected_files: ["src/auth/a.ts"],
      }),
    );
    await engine.amend({
      id: d.id,
      add_affected_files: ["src/auth/a.ts", "specs/b.md"],
    });

    // Relations store entity ULIDs, not names — resolve through the entity list.
    const entities = await graphStore.getEntities();
    const idToName = new Map(entities.map((e) => [e.id, e.name]));
    const conceptId = entities.find((e) => e.name === d.id)!.id;
    const relations = await graphStore.getRelations();
    const decidedBy = relations.filter(
      (r) => r.type === "decided_by" && r.target === conceptId,
    );
    const bySource = decidedBy.reduce<Record<string, number>>((acc, r) => {
      const name = idToName.get(r.source)!;
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    expect(bySource["src/auth/a.ts"]).toBe(1);
    expect(bySource["specs/b.md"]).toBe(1);

    // Provenance marker (field D13 ask 4): auto-populated edges are machine-
    // derived and must say so; absent = legacy/unknown, "declared" = agent-
    // typed via twining_add_relation.
    for (const r of decidedBy) {
      expect(r.properties.origin).toBe("derived");
    }
  });

  it("posts an audit-trail finding to the blackboard", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ summary: "Audited amend" }),
    );
    await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["specs/a.md"],
      reason: "traceability",
    });
    const { entries } = await blackboardEngine.read({
      entry_types: ["finding"],
    });
    const audit = entries.find((e) => e.summary.includes(d.id));
    expect(audit).toBeDefined();
    expect(audit!.detail).toContain("specs/a.md");
    expect(audit!.detail).toContain("traceability");
  });

  it("concurrent amends both survive: merge happens inside the store's critical section", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ summary: "Raced record" }),
    );
    await Promise.all([
      decisionEngine.amend({ id: d.id, add_affected_files: ["a.ts"] }),
      decisionEngine.amend({ id: d.id, add_affected_files: ["b.ts"] }),
    ]);
    const stored = await decisionStore.get(d.id);
    expect([...stored!.affected_files].sort()).toEqual(["a.ts", "b.ts"]);
    expect(stored!.amendments).toHaveLength(2);
  });

  it("amends symbols only, idempotently, and executes the graph symbol path", async () => {
    const { GraphStore } = await import("../src/storage/graph-store.js");
    const { GraphEngine } = await import("../src/engine/graph.js");
    const { GraphAutoPopulator } = await import(
      "../src/engine/graph-auto-populator.js"
    );
    fs.mkdirSync(path.join(tmpDir, "graph"), { recursive: true });
    const graphStore = new GraphStore(tmpDir);
    const engine = new DecisionEngine(
      decisionStore,
      blackboardEngine,
      null,
      null,
      null,
      null,
      new GraphAutoPopulator(new GraphEngine(graphStore)),
    );
    const d = await engine.decide(
      validDecisionInput({ summary: "Symbols-only amend" }),
    );

    const first = await engine.amend({
      id: d.id,
      add_affected_symbols: ["Kernel.emit", "Kernel.emit"],
    });
    expect(first.added_symbols).toEqual(["Kernel.emit"]);
    const again = await engine.amend({
      id: d.id,
      add_affected_symbols: ["Kernel.emit"],
    });
    expect(again.added_symbols).toEqual([]);
    expect(again.already_present).toEqual(["Kernel.emit"]);

    const stored = await decisionStore.get(d.id);
    expect(stored!.affected_symbols).toEqual(["Kernel.emit"]);
    expect(stored!.amendments).toHaveLength(1);

    const entities = await graphStore.getEntities();
    const symbolEntity = entities.find((e) => e.name === "Kernel.emit")!;
    expect(symbolEntity.type).toBe("function");
    const conceptId = entities.find((e) => e.name === d.id)!.id;
    const relations = await graphStore.getRelations();
    const edges = relations.filter(
      (r) =>
        r.type === "decided_by" &&
        r.source === symbolEntity.id &&
        r.target === conceptId,
    );
    expect(edges).toHaveLength(1);
  });

  it("amend leaves every untouched field intact", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({
        summary: "Field isolation",
        alternatives: [{ option: "Alt", reason_rejected: "No" }],
      }),
    );
    const before = await decisionStore.get(d.id);
    await decisionEngine.amend({ id: d.id, add_affected_files: ["x.md"] });
    const after = await decisionStore.get(d.id);
    expect(after!.summary).toBe(before!.summary);
    expect(after!.rationale).toBe(before!.rationale);
    expect(after!.alternatives).toEqual(before!.alternatives);
    expect(after!.status).toBe(before!.status);
    expect(after!.timestamp).toBe(before!.timestamp);
  });

  it("rejects empty and whitespace-only path entries — they would match every scope query", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    await expect(
      decisionEngine.amend({ id: d.id, add_affected_files: [""] }),
    ).rejects.toThrow(TwiningError);
    await expect(
      decisionEngine.amend({ id: d.id, add_affected_symbols: ["  "] }),
    ).rejects.toThrow(TwiningError);
  });

  it("already_present is deduplicated even when the input repeats entries", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ affected_files: ["a.ts"] }),
    );
    const result = await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["a.ts", "a.ts", "b.ts"],
    });
    expect(result.already_present).toEqual(["a.ts"]);
    expect(result.added_files).toEqual(["b.ts"]);
  });

  it("a failing audit post never un-persists the amendment; the response flags it", async () => {
    const { vi } = await import("vitest");
    const d = await decisionEngine.decide(validDecisionInput());
    const postSpy = vi
      .spyOn(blackboardEngine, "post")
      .mockRejectedValueOnce(new Error("lock contention"));
    const result = await decisionEngine.amend({
      id: d.id,
      add_affected_files: ["persisted.md"],
    });
    expect(result.added_files).toEqual(["persisted.md"]);
    expect(result.audit_posted).toBe(false);
    const stored = await decisionStore.get(d.id);
    expect(stored!.affected_files).toEqual(["persisted.md"]);
    postSpy.mockRestore();
  });

  it("rejects unknown ids and empty amendments", async () => {
    await expect(
      decisionEngine.amend({
        id: "01GHOST00000000000000000000",
        add_affected_files: ["x.md"],
      }),
    ).rejects.toThrow(TwiningError);

    const d = await decisionEngine.decide(validDecisionInput());
    await expect(decisionEngine.amend({ id: d.id })).rejects.toThrow(
      TwiningError,
    );
  });
});

describe("DecisionEngine.override on provisionals (D14 veto path)", () => {
  it("retires a provisional with attribution intact and post-state in the result", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    await decisionStore.updateStatus(d.id, "provisional");

    const result = await decisionEngine.override(
      d.id,
      "author self-withdrawal",
      undefined,
      "the-author",
    );
    expect(result.overridden).toBe(true);
    expect(result.status).toBe("overridden");
    expect(result.overridden_by).toBe("the-author");

    const after = await decisionStore.get(d.id);
    expect(after!.status).toBe("overridden");
    expect(after!.overridden_by).toBe("the-author");
    expect(after!.override_reason).toBe("author self-withdrawal");
  });

  it("fails loudly with PERSIST_FAILED when the write does not persist", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    // A store that accepts the read but loses the write — the D14 family's
    // exact hazard: an affirmative response on a no-op.
    const lossy = Object.create(decisionStore) as typeof decisionStore;
    lossy.updateStatus = async () => ({ persisted: false });
    const engine = new DecisionEngine(lossy, blackboardEngine);

    await expect(engine.override(d.id, "reason")).rejects.toMatchObject({
      code: "PERSIST_FAILED",
    });
  });

  it("file-backend updateStatus reports persisted honestly", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    expect(await decisionStore.updateStatus(d.id, "provisional")).toEqual({
      persisted: true,
    });
    expect(await decisionStore.updateStatus("missing-id", "active")).toEqual({
      persisted: false,
    });
  });
});

describe("override read-back under concurrency + reconsider stamp clearing (2.14.0 review round)", () => {
  it("does not throw when a concurrent writer moves the record on after a persisted override", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    // Write persists; a concurrent supersession lands before the read-back.
    const racy = Object.create(decisionStore) as typeof decisionStore;
    racy.updateStatus = async (id, status, extra) => {
      const r = await decisionStore.updateStatus(id, status, extra);
      await decisionStore.updateStatus(id, "superseded", { superseded_by: "racer" });
      return r;
    };
    const engine = new DecisionEngine(racy, blackboardEngine);

    const result = await engine.override(d.id, "veto", undefined, "author");
    // The override DID persist — no PERSIST_FAILED; the result echoes the
    // raced post-state honestly instead of claiming status "overridden".
    expect(result.overridden).toBe(true);
    expect(result.status).toBe("superseded");
    expect(result.overridden_by).toBe("author");
    expect((await decisionStore.get(d.id))!.override_reason).toBe("veto");
  });

  it("reconsider clears ratification attribution on demotion", async () => {
    const d = await decisionEngine.decide(validDecisionInput());
    await decisionStore.updateStatus(d.id, "provisional");
    await decisionEngine.promote([d.id], "ratifier");
    expect((await decisionStore.get(d.id))!.promoted_by).toBe("ratifier");

    await decisionEngine.reconsider(d.id, "new evidence");
    const after = await decisionStore.get(d.id);
    expect(after!.status).toBe("provisional");
    expect(after!.promoted_by).toBeUndefined();
    expect(after!.promoted_at).toBeUndefined();
  });
});
