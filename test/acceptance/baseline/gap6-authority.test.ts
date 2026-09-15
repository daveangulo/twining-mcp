/**
 * Gap 6 — authority (requirements R03, R05, R17).
 *
 * Baseline reproduction: the decision engine treats caller-supplied identity
 * as fact. `decide()` stores whatever `agent_id` string it is handed and marks
 * the record active with no verification of who claimed it; `promote()` stamps
 * `promoted_by` straight from the caller's string, so a self-asserted
 * "human:alice" ratification is indistinguishable from a real one.
 *
 * Positive control: `decide()` DOES reject a lifecycle status at creation
 * ("archived" → INVALID_INPUT), proving the validation instrument in this file
 * works and that the authority assertions below are not passing vacuously.
 *
 * Harness idioms (tmpdir stores, validDecisionInput) mirror
 * test/decision-engine.test.ts exactly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../../src/storage/decision-store.js";
import { BlackboardEngine } from "../../../src/engine/blackboard.js";
import { DecisionEngine } from "../../../src/engine/decisions.js";
import { TwiningError } from "../../../src/utils/errors.js";

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

/**
 * Any field name a record could plausibly use to carry proof-of-authority.
 * The gap is that NONE of these exist on a stored decision.
 */
const AUTHORITY_FIELD_RE =
  /verif|attest|signat|authent|credential|principal|identity_proof|authority|actor_kind|actor_type|claimed/i;

function authorityFields(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((k) => AUTHORITY_FIELD_RE.test(k));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap6-authority-test-"));
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

describe("Gap 6 — positive control (instrument works)", () => {
  it("decide rejects a lifecycle status at creation with INVALID_INPUT", async () => {
    await expect(
      decisionEngine.decide(validDecisionInput({ status: "archived" })),
    ).rejects.toThrow(TwiningError);

    try {
      await decisionEngine.decide(validDecisionInput({ status: "archived" }));
      throw new Error("expected decide() to throw for status 'archived'");
    } catch (e) {
      expect(e).toBeInstanceOf(TwiningError);
      expect((e as TwiningError).code).toBe("INVALID_INPUT");
    }
  });
});

describe("Gap 6 — authority: decide() trusts caller-asserted identity (R03, R05, R17)", () => {
  it("stores an arbitrary agent_id verbatim as active, with no verification field", async () => {
    const result = await decisionEngine.decide(
      validDecisionInput({ status: "active", agent_id: "anyone" }),
    );

    const stored = await decisionStore.get(result.id);
    expect(stored).toBeTruthy();

    // (a) The self-asserted identity is persisted as-is…
    expect(stored!.agent_id).toBe("anyone");
    // …at full authority, not quarantined as provisional/unverified.
    expect(stored!.status).toBe("active");
    // …and nothing on the record records that the identity was never checked.
    expect(authorityFields(stored as unknown as Record<string, unknown>)).toEqual(
      [],
    );
    expect(
      (stored as unknown as Record<string, unknown>)["verified"],
    ).toBeUndefined();
    expect(
      (stored as unknown as Record<string, unknown>)["agent_id_verified"],
    ).toBeUndefined();

    // The caller is told nothing about the identity being unverified either.
    expect(
      (result as unknown as Record<string, unknown>)["verified"],
    ).toBeUndefined();
  });

  it("accepts a privileged-looking human identity from an ordinary caller with no distinction", async () => {
    const asAgent = await decisionEngine.decide(
      validDecisionInput({ summary: "Agent-claimed record", agent_id: "worker-7" }),
    );
    const asHuman = await decisionEngine.decide(
      validDecisionInput({
        summary: "Human-claimed record",
        agent_id: "human:alice",
      }),
    );

    const agentRecord = await decisionStore.get(asAgent.id);
    const humanRecord = await decisionStore.get(asHuman.id);

    expect(agentRecord!.agent_id).toBe("worker-7");
    expect(humanRecord!.agent_id).toBe("human:alice");
    // Both records are active and structurally identical in authority terms:
    // the "human" claim buys no check and leaves no distinguishing mark.
    expect(agentRecord!.status).toBe("active");
    expect(humanRecord!.status).toBe("active");
    expect(
      authorityFields(humanRecord as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(Object.keys(humanRecord as unknown as Record<string, unknown>).sort())
      .toEqual(Object.keys(agentRecord as unknown as Record<string, unknown>).sort());
  });
});

describe("Gap 6 — authority: promote() stamps the caller string as the ratifier (R03, R05, R17)", () => {
  it("writes promoted_by straight from the caller-supplied string, unverified", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ status: "provisional" }),
    );
    const before = await decisionStore.get(d.id);
    expect(before!.status).toBe("provisional");

    const result = await decisionEngine.promote([d.id], "human:alice");
    expect(result.promoted).toEqual([d.id]);

    const after = await decisionStore.get(d.id);
    // (b) The ratifier attribution is the caller's own string, taken on faith.
    expect(after!.promoted_by).toBe("human:alice");
    expect(after!.status).toBe("active");
    expect(after!.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // No proof, no check, no marker that this was a self-asserted ratification.
    expect(authorityFields(after as unknown as Record<string, unknown>)).toEqual(
      [],
    );
    expect(
      (after as unknown as Record<string, unknown>)["promoted_by_verified"],
    ).toBeUndefined();
    expect(
      (result as unknown as Record<string, unknown>)["verified"],
    ).toBeUndefined();
  });

  it("propagates the unverified ratifier string onto the blackboard status entry", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ status: "provisional" }),
    );
    await decisionEngine.promote([d.id], "human:alice");

    const { entries } = await blackboardStore.read();
    const promoteEntry = entries.find(
      (e) => e.entry_type === "status" && e.summary.includes("Promoted"),
    );
    expect(promoteEntry).toBeDefined();
    // The audit trail records the claim, not a verified actor.
    expect(promoteEntry!.agent_id).toBe("human:alice");
  });

  it("lets an arbitrary string promote a decision another agent created", async () => {
    const d = await decisionEngine.decide(
      validDecisionInput({ status: "provisional", agent_id: "worker-7" }),
    );

    // No relationship between creator and ratifier is required or recorded.
    const result = await decisionEngine.promote([d.id], "totally-made-up");
    expect(result.promoted).toEqual([d.id]);

    const after = await decisionStore.get(d.id);
    expect(after!.agent_id).toBe("worker-7");
    expect(after!.promoted_by).toBe("totally-made-up");
    expect(after!.status).toBe("active");
  });
});
