import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createTwiningDir, createAssembler, createDecisionEngine } from "./helpers.js";
import { DecisionStore } from "../../src/storage/decision-store.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import * as bugInvestigation from "./fixtures/bug-investigation.js";
import * as architectureCascade from "./fixtures/architecture-cascade.js";

let twiningDir: string;

beforeEach(() => {
  twiningDir = createTwiningDir();
});

afterEach(() => {
  fs.rmSync(twiningDir, { recursive: true, force: true });
});

describe("bug-investigation: why for the affected file", () => {
  it('why("src/utils/pagination.ts") returns the pagination bug decision', async () => {
    await bugInvestigation.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/utils/pagination.ts");
    const summaries = result.decisions.map((d) => d.summary).join(" ");
    expect(summaries).toMatch(/pagination|off-by-one/i);
  });

  it("why result includes rationale and confidence", async () => {
    await bugInvestigation.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/utils/pagination.ts");
    const paginationDecision = result.decisions.find((d) => d.summary.match(/pagination/i));
    expect(paginationDecision).toBeDefined();
    expect(paginationDecision!.rationale).toMatch(/offset/i);
    expect(paginationDecision!.confidence).toBe("high");
  });

  it("why result includes alternatives_count", async () => {
    await bugInvestigation.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/utils/pagination.ts");
    const paginationDecision = result.decisions.find((d) => d.summary.match(/pagination/i));
    expect(paginationDecision!.alternatives_count).toBe(2);
  });
});

describe("architecture-cascade: why for a narrow file", () => {
  it('why("src/repositories/user.repository.ts") returns cascading decisions', async () => {
    await architectureCascade.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/repositories/user.repository.ts");
    // Broad "src/" + mid "src/repositories/" + narrow "src/repositories/base.ts" + affected_files match
    expect(result.decisions.length).toBeGreaterThanOrEqual(2);
  });

  it("why results are sorted newest first", async () => {
    await architectureCascade.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/repositories/user.repository.ts");
    if (result.decisions.length >= 2) {
      // Sorted by timestamp desc
      expect(result.decisions[0]!.timestamp >= result.decisions[1]!.timestamp).toBe(true);
    }
  });
});

describe("scope filtering", () => {
  it('why("src/database/") does NOT return pagination decisions', async () => {
    await bugInvestigation.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/database/");
    const summaries = result.decisions.map((d) => d.summary).join(" ");
    expect(summaries).not.toMatch(/pagination|off-by-one/i);
    expect(summaries).toMatch(/connection pooling/i);
  });

  it('why("src/") returns all decisions at that scope', async () => {
    await architectureCascade.populate(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/");
    // All 3 cascading decisions should match "src/" via prefix containment
    expect(result.decisions.length).toBeGreaterThanOrEqual(3);
  });
});

describe("edge cases", () => {
  it("why on scope with no decisions returns empty", async () => {
    const bb = new BlackboardStore(twiningDir);
    const dec = new DecisionStore(twiningDir);
    const engine = createDecisionEngine(twiningDir, bb, dec);
    const result = await engine.why("src/anything/");
    expect(result.decisions).toEqual([]);
    expect(result.active_count).toBe(0);
  });

  it("why excludes superseded decisions from active_count", async () => {
    const dec = new DecisionStore(twiningDir);
    const bb = new BlackboardStore(twiningDir);

    const old = await dec.create({
      agent_id: "a", domain: "implementation", scope: "src/api/",
      summary: "Old approach", context: "", rationale: "Old reason",
      constraints: [], alternatives: [], depends_on: [],
      confidence: "medium", reversible: true,
      affected_files: [], affected_symbols: [],
    });

    // Use DecisionEngine.decide() which handles supersedes logic
    const engine = createDecisionEngine(twiningDir, bb, dec);
    await engine.decide({
      domain: "implementation", scope: "src/api/",
      summary: "New approach", context: "Updated", rationale: "New reason",
      confidence: "high",
      supersedes: old.id,
    });
    const result = await engine.why("src/api/", { include_superseded: true });
    // Two total decisions exist, but only the new one is "active"
    expect(result.active_count).toBe(1);
    // The superseded one appears only with include_superseded (#41)
    expect(result.decisions.length).toBe(2);
    expect(result.superseded_count).toBe(1);
  });
});
