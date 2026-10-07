/**
 * Gap 7 — formatter budget (requirements R15, R16, R17), baseline 07230e6.
 *
 * R15/R16: ContextAssembler.formatForLLM hard-codes a 3-CRITICAL + 2-CONTEXT
 * decision ladder. The token budget the caller asked for (max_tokens) never
 * reaches the formatter, so a generous budget buys nothing: 8 decisions are
 * selected and returned in active_decisions, but the briefing the agent reads
 * shows 3 full rationales, 2 truncated ones, and "+3 more decisions".
 *
 * R17: estimateTokens is a flat 4-chars-per-token heuristic, and
 * token_estimate counts the *selected items'* raw text — not the briefing the
 * formatter renders, and not the JSON envelope twining_assemble actually puts
 * on the wire.
 *
 * ## CLOSED by lane 04 (retrieval and trust), 2026-09-15.
 *
 * R15/R16: the ladder is now driven by the caller's budget
 * (`ContextAssembler.decisionTiers`). A generous `max_tokens` buys full
 * rationales for every selected decision instead of announcing the loss.
 *
 * R17: `token_estimate` is the conservative bound (`src/retrieval/tokenizer.ts`,
 * `twining-conservative-utf8/1.0.0`) over the briefing that is actually
 * EMITTED, stamped by `ContextAssembler.annotateEmitted`. It no longer charges
 * for records the formatter never rendered, and the tool reports the tokenizer
 * it used.
 *
 * Structure: the positive control is unchanged and still green; the two gap
 * assertions are FLIPPED, and each keeps the original defect's arithmetic in
 * view so the change is legible.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ContextAssembler } from "../../../src/engine/context-assembler.js";
import { BlackboardStore } from "../../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../../src/storage/decision-store.js";
import { Embedder } from "../../../src/embeddings/embedder.js";
import { registerContextTools } from "../../../src/tools/context-tools.js";
import { estimateTokens } from "../../../src/utils/tokens.js";
import {
  estimate as estimateConservative,
  TOKENIZER_ID,
} from "../../../src/retrieval/tokenizer.js";
import { measureEnvelope } from "../../../src/retrieval/packet.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";
import type { TwiningConfig } from "../../../src/utils/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function makeTwiningDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-gap7-formatter-budget-"),
  );
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

const SCOPE = "src/budget/";
const TASK = "review the budget subsystem";
const MAX_TOKENS = 100000;
const SEEDED = 8;

/** Filler long enough that rationale.slice(0, 120) cannot reach ENDMARK. */
const FILLER =
  "because the subsystem needs deterministic ordering, bounded retries, and an " +
  "explicit failure surface for every caller that depends on it";

function summaryFor(i: number): string {
  return `Budget decision ${i} SUMMARKER${i}`;
}
function rationaleFor(i: number): string {
  return `RATIONALE ${i}: ${FILLER} ENDMARK${i}`;
}

describe("Gap 7 — formatter budget (R15/R16/R17)", () => {
  let twiningDir: string;
  let blackboardStore: BlackboardStore;
  let decisionStore: DecisionStore;
  let config: TwiningConfig;

  beforeEach(async () => {
    twiningDir = makeTwiningDir();
    blackboardStore = new BlackboardStore(twiningDir);
    decisionStore = new DecisionStore(twiningDir);
    config = makeConfig();
    Embedder.resetInstances();

    for (let i = 0; i < SEEDED; i++) {
      await decisionStore.create({
        agent_id: "test",
        domain: "implementation",
        scope: SCOPE,
        summary: summaryFor(i),
        context: `Context for decision ${i}`,
        rationale: rationaleFor(i),
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [`src/budget/mod${i}.ts`],
        affected_symbols: [],
      });
    }
  });

  it("POSITIVE CONTROL: all 8 decisions are selected at max_tokens 100000 and the top one renders in full", async () => {
    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      null,
      config,
    );

    const ctx = await assembler.assemble(TASK, SCOPE, MAX_TOKENS);

    // The budget is ample — selection keeps every seeded decision.
    expect(ctx.active_decisions).toHaveLength(SEEDED);

    // ...and the instrument can see rationale text in the briefing: the
    // highest-ranked decision's rationale is rendered verbatim.
    const briefing = ContextAssembler.formatForLLM(ctx);
    expect(briefing).toContain(ctx.active_decisions[0]!.rationale);
  });

  it("FLIPPED R15/R16 (lane 04): a generous budget renders every selected decision in full, with nothing hidden", async () => {
    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      null,
      config,
    );

    const ctx = await assembler.assemble(TASK, SCOPE, MAX_TOKENS);
    const briefing = ContextAssembler.formatForLLM(ctx);

    expect(ctx.active_decisions).toHaveLength(SEEDED);

    // Every selected decision renders in FULL — the budget is 100000 tokens
    // and the eight rationales cost a tiny fraction of it.
    const fullRationales = ctx.active_decisions.filter((d) =>
      briefing.includes(d.rationale),
    );
    expect(fullRationales).toHaveLength(SEEDED);

    // Nothing is hidden and nothing is summarized away.
    for (const d of ctx.active_decisions) {
      expect(briefing).toContain(d.summary);
      expect(briefing).toContain(d.rationale);
    }
    expect(briefing).not.toContain("more decisions in scope");

    // The heading now states the authority class of what follows, so an
    // unverified 2.x assertion is not presented as a ratified ruling
    // (gap 6, render side).
    expect(briefing).toContain("Evidence class: legacy_unverified");
    expect(briefing).toContain("Qualifies an action: no");
  });

  it("CONTROL R15/R16: a small budget still degrades gracefully and reports the loss", async () => {
    // Proves the flip above comes from the budget being spent, not from the
    // ladder being removed: shrink the budget and the omission line returns.
    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      null,
      config,
    );
    // RE-BASELINED TWICE, and the chain matters:
    //   400  — the original, in the old chars/4 selection currency.
    //   1600 — lane 04 unified the currency on the PROVEN table (1 token per
    //          UTF-8 byte), which charges ~4x, so the same tightness needed 4x
    //          the integer.
    //   700  — the shipped measured table (src/retrieval/calibration.json)
    //          charges ~0.43 tokens/byte on prose, so the integer comes most of
    //          the way back down. Measured, not scaled by eye: degradation stops
    //          between 1600 and 2000, so 1600 had drifted to the very edge of
    //          still proving anything; 700 sits well inside the degrading band.
    const ctx = await assembler.assemble(TASK, SCOPE, 700);
    const briefing = ContextAssembler.formatForLLM(ctx);
    const full = ctx.active_decisions.filter((d) => briefing.includes(d.rationale));
    expect(full.length).toBeLessThan(ctx.active_decisions.length);
    expect(briefing).toContain("more decisions in scope");
  });

  it("FLIPPED R17 (lane 04): token_estimate measures the EMITTED briefing with a declared, conservative tokenizer", async () => {
    // The heuristic itself: 400 chars -> 100 tokens, regardless of content.
    expect(estimateTokens("x".repeat(400))).toBe(100);

    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      null,
      config,
    );

    // Drive the real MCP tool so we measure the payload actually returned.
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, handler: any) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerContextTools(fakeServer, assembler, { fullSurface: true });

    const res = await handlers.get("twining_assemble")!({
      task: TASK,
      scope: SCOPE,
      max_tokens: MAX_TOKENS,
    });
    const envelope: string = res.content[0].text;
    const payload = JSON.parse(envelope);

    // The tool reports all 8 decisions AND the briefing renders all 8.
    expect(payload.decisions_count).toBe(SEEDED);
    expect(payload.briefing).not.toContain("more decisions in scope");

    // Same inputs through the engine, to inspect what was selected.
    const ctx = await assembler.assemble(TASK, SCOPE, MAX_TOKENS);

    // token_estimate is now EXACTLY the declared tokenizer's bound over the
    // briefing that was emitted. Reproducible to +/-0 by an independent count.
    expect(payload.token_estimate).toBe(estimateConservative(payload.briefing).tokens);
    expect(payload.retrieval.token_usage.emitted_tokens).toBe(payload.token_estimate);

    // The tokenizer names itself, and declares that it is a bound not a count.
    expect(payload.retrieval.token_usage.tokenizer_id).toBe(TOKENIZER_ID);
    expect(payload.retrieval.token_usage.conservative_fallback).toBe(true);

    // It no longer charges for records the formatter never rendered: every
    // selected decision was rendered at this budget.
    expect(payload.retrieval.token_usage.rendered_decisions).toBe(SEEDED);
    expect(payload.retrieval.token_usage.selected_decisions).toBe(SEEDED);

    // The old accounting charged the raw text of every selected item. Show it
    // is gone: that number and this one are different.
    const oldAccounting = ctx.active_decisions
      .map((d) =>
        estimateTokens(`${d.summary} ${d.rationale} ${d.confidence} ${d.affected_files.join(", ")}`),
      )
      .reduce((a, b) => a + b, 0);
    expect(payload.token_estimate).not.toBe(oldAccounting);

    // The emitted bytes are hashed, so a receipt can be bound to this exact
    // briefing (R16).
    expect(payload.retrieval.emitted_bytes_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The envelope is measurable too — the tool's caller can bound the wire
    // cost with the same declared tokenizer.
    expect(measureEnvelope(envelope).tokens).toBeGreaterThan(payload.token_estimate);
  });
});
