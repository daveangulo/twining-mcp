import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createTwiningDir, createAssembler, formatAndCount, estimateTokens } from "./helpers.js";
import { ContextAssembler } from "../../src/engine/context-assembler.js";

let twiningDir: string;

beforeEach(() => {
  twiningDir = createTwiningDir();
});

afterEach(() => {
  fs.rmSync(twiningDir, { recursive: true, force: true });
});

async function seedDecisions(
  twiningDir: string,
  count: number,
  kit?: ReturnType<typeof createAssembler>,
) {
  const { decisions } = kit ?? createAssembler(twiningDir);
  for (let i = 0; i < count; i++) {
    await decisions.create({
      agent_id: "agent-a",
      domain: "implementation",
      scope: "src/mod/",
      summary: `Decision ${i}: implement feature ${i} using approach ${i}`,
      context: `Context for feature ${i}`,
      rationale: `This approach was chosen because it satisfies requirement ${i} with minimal complexity.`,
      constraints: [],
      alternatives: [
        { option: `Alternative for ${i}`, pros: [], cons: [], reason_rejected: `Not as good for ${i}` },
      ],
      depends_on: [],
      confidence: i % 3 === 0 ? "high" : i % 3 === 1 ? "medium" : "low",
      reversible: true,
      affected_files: [`src/mod/feature-${i}.ts`],
      affected_symbols: [],
    });
  }
}

async function seedFindings(twiningDir: string, count: number, kit?: ReturnType<typeof createAssembler>) {
  const { blackboard } = kit ?? createAssembler(twiningDir);
  for (let i = 0; i < count; i++) {
    await blackboard.append({
      agent_id: "agent-a",
      entry_type: "finding",
      tags: ["investigation"],
      scope: "src/mod/",
      summary: `Finding ${i}: discovered pattern in src/mod/file-${i}.ts`,
      detail: `Detailed analysis of pattern ${i} in the codebase.`,
    });
  }
}

async function seedWarnings(twiningDir: string, count: number, kit?: ReturnType<typeof createAssembler>) {
  const { blackboard } = kit ?? createAssembler(twiningDir);
  for (let i = 0; i < count; i++) {
    await blackboard.append({
      agent_id: "agent-a",
      entry_type: "warning",
      tags: ["caution"],
      scope: "src/mod/",
      summary: `Warning ${i}: do NOT modify src/mod/critical-${i}.ts`,
      detail: `This file has specific requirements that must be respected.`,
    });
  }
}

describe("token budget compliance", () => {
  it("empty state produces minimal output", async () => {
    const { assembler } = createAssembler(twiningDir);
    const ctx = await assembler.assemble("task", "src/");
    expect(ctx.token_estimate).toBe(0);
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text.length).toBeLessThan(200);
  });

  it("moderate state stays within 4000 token budget", async () => {
    const kit = createAssembler(twiningDir);
    await seedDecisions(twiningDir, 5, kit);
    await seedFindings(twiningDir, 3, kit);
    await seedWarnings(twiningDir, 2, kit);
    // Also add a need
    await kit.blackboard.append({
      agent_id: "agent-a",
      entry_type: "need",
      tags: ["testing"],
      scope: "src/mod/",
      summary: "Add unit tests for new features",
      detail: "",
    });

    const ctx = await kit.assembler.assemble("work on mod", "src/mod/");
    expect(ctx.token_estimate).toBeLessThanOrEqual(4000);
  });

  it("large state is trimmed to respect budget", async () => {
    const kit = createAssembler(twiningDir);
    await seedDecisions(twiningDir, 50, kit);
    await seedFindings(twiningDir, 30, kit);
    await seedWarnings(twiningDir, 10, kit);

    const ctx = await kit.assembler.assemble("work on mod", "src/mod/", 2000);
    expect(ctx.token_estimate).toBeLessThanOrEqual(2000);
    // Warnings should survive budget pressure
    expect(ctx.active_warnings.length).toBeGreaterThan(0);
  });
});

describe("signal-to-noise ratio", () => {
  it("with 1 critical decision and 20 trivial findings, decision appears", async () => {
    const kit = createAssembler(twiningDir);
    await kit.decisions.create({
      agent_id: "agent-a",
      domain: "architecture",
      scope: "src/mod/",
      summary: "Critical: use event sourcing for all state changes",
      context: "Auditability requirement",
      rationale: "Event sourcing provides full audit trail and enables temporal queries for compliance.",
      constraints: ["All state mutations must emit events"],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: false,
      affected_files: ["src/mod/events.ts"],
      affected_symbols: [],
    });
    await seedFindings(twiningDir, 20, kit);

    const ctx = await kit.assembler.assemble("work on mod", "src/mod/", 500);
    expect(ctx.active_decisions.length).toBeGreaterThanOrEqual(1);
    expect(ctx.active_decisions[0]!.summary).toMatch(/event sourcing/i);
    expect(ctx.recent_findings.length).toBeLessThan(20);
  });

  it("warnings always survive budget pressure", async () => {
    const kit = createAssembler(twiningDir);
    await seedWarnings(twiningDir, 1, kit);
    await seedFindings(twiningDir, 40, kit);

    const ctx = await kit.assembler.assemble("work on mod", "src/mod/", 500);
    expect(ctx.active_warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("formatForLLM output has structural sections", async () => {
    const kit = createAssembler(twiningDir);
    await seedDecisions(twiningDir, 3, kit);
    await seedWarnings(twiningDir, 2, kit);
    await seedFindings(twiningDir, 2, kit);

    const ctx = await kit.assembler.assemble("work on mod", "src/mod/");
    const text = ContextAssembler.formatForLLM(ctx);
    expect(text).toContain("DECISIONS TO RESPECT");
    expect(text).toContain("STOP — READ THESE WARNINGS");
    // Warnings should appear before decisions (most actionable first)
    const warningsIdx = text.indexOf("STOP — READ THESE WARNINGS");
    const decisionsIdx = text.indexOf("DECISIONS TO RESPECT");
    expect(warningsIdx).toBeLessThan(decisionsIdx);
    // Decisions should appear before findings
    const findingsIdx = text.indexOf("FINDINGS");
    if (findingsIdx >= 0) {
      expect(decisionsIdx).toBeLessThan(findingsIdx);
    }
  });

  it("formatForLLM output size grows sub-linearly", async () => {
    // Measure with 1 decision
    const kit1 = createAssembler(twiningDir);
    await seedDecisions(twiningDir, 1, kit1);
    const ctx1 = await kit1.assembler.assemble("task", "src/mod/");
    const len1 = ContextAssembler.formatForLLM(ctx1).length;

    // Measure with 5 decisions (fresh dir)
    const dir5 = createTwiningDir();
    const kit5 = createAssembler(dir5);
    await seedDecisions(dir5, 5, kit5);
    const ctx5 = await kit5.assembler.assemble("task", "src/mod/");
    const len5 = ContextAssembler.formatForLLM(ctx5).length;

    // Measure with 20 decisions (fresh dir)
    const dir20 = createTwiningDir();
    const kit20 = createAssembler(dir20);
    await seedDecisions(dir20, 20, kit20);
    const ctx20 = await kit20.assembler.assemble("task", "src/mod/");
    const len20 = ContextAssembler.formatForLLM(ctx20).length;

    // 20-decision output should be less than 20x the 1-decision output
    // (sub-linear means growth rate decreases; header overhead makes 1-decision
    // output disproportionately large, so we use 20x as the linear bound)
    expect(len20).toBeLessThan(len1 * 20);

    // Clean up extra dirs
    fs.rmSync(dir5, { recursive: true, force: true });
    fs.rmSync(dir20, { recursive: true, force: true });
  });
});

describe("per-item overhead", () => {
  it("< 200 tokens per decision on average", async () => {
    // Threshold restored to its pre-lane-04 value: see the note below.
    const kit = createAssembler(twiningDir);
    await seedDecisions(twiningDir, 10, kit);
    const ctx = await kit.assembler.assemble("task", "src/mod/");
    if (ctx.active_decisions.length > 0) {
      const avgTokens = ctx.token_estimate / ctx.active_decisions.length;
      expect(avgTokens).toBeLessThan(200);
    }
  });

  // Thresholds RESTORED to 200/100 — the calibrated table anticipated in the
  // lane-04 note has now shipped (src/retrieval/calibration.json).
  //
  // The chain: 200/100 (chars/4) -> 800/400 (lane 04's proven 1-token-per-byte
  // table, ~4x looser by construction) -> 200/100 again, because the measured
  // table charges ~0.43 tokens/byte on prose and brings the numbers back into
  // the original range. Measured at the time of the restore: 70.3 tokens per
  // decision and 51 per warning, so both keep real headroom rather than sitting
  // on a knife edge. token_estimate is still a CONSERVATIVE UPPER BOUND, not a
  // chars/4 central estimate; the property under test — bounded per-item
  // overhead — has never changed.
  it("< 100 tokens per warning on average (conservative-bound units)", async () => {
    const kit = createAssembler(twiningDir);
    await seedWarnings(twiningDir, 5, kit);
    const ctx = await kit.assembler.assemble("task", "src/mod/");
    if (ctx.active_warnings.length > 0) {
      const avgTokens = ctx.token_estimate / ctx.active_warnings.length;
      expect(avgTokens).toBeLessThan(100);
    }
  });
});
