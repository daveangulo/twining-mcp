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
  const bbStore = new BlackboardStore(tmpDir);
  const dcsnStore = new DecisionStore(tmpDir);
  blackboardEngine = new BlackboardEngine(bbStore);
  decisionEngine = new DecisionEngine(dcsnStore, blackboardEngine);
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

describe("DecisionEngine.why", () => {
  it("returns decisions matching scope with correct counts", async () => {
    await decisionEngine.decide(validDecisionInput());
    await decisionEngine.decide(
      validDecisionInput({ summary: "Second decision" }),
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
});
