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
 * Structure: a positive control (the instrument sees all 8 decisions and does
 * render the top one in full) followed by the gap assertions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ContextAssembler } from "../../../src/engine/context-assembler.js";
import { BlackboardStore } from "../../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../../src/storage/decision-store.js";
import { Embedder } from "../../../src/embeddings/embedder.js";
import { registerContextTools } from "../../../src/tools/context-tools.js";
import { estimateTokens } from "../../../src/utils/tokens.js";
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

  it("GAP R15/R16: the briefing renders only 3 full rationales + 2 summaries and hides the rest behind '+3 more decisions'", async () => {
    const assembler = new ContextAssembler(
      blackboardStore,
      decisionStore,
      null,
      config,
    );

    const ctx = await assembler.assemble(TASK, SCOPE, MAX_TOKENS);
    const briefing = ContextAssembler.formatForLLM(ctx);

    expect(ctx.active_decisions).toHaveLength(SEEDED);

    // Full rationales present == exactly the top 3 (ENDMARK<i> lives past
    // char 120, so the CONTEXT tier's rationale.slice(0, 120) drops it).
    const fullRationales = ctx.active_decisions.filter((d) =>
      briefing.includes(d.rationale),
    );
    expect(fullRationales).toHaveLength(3);
    expect(fullRationales.map((d) => d.id)).toEqual(
      ctx.active_decisions.slice(0, 3).map((d) => d.id),
    );

    // Decisions 4 and 5 appear as summary-only lines: summary present,
    // full rationale absent.
    for (const d of ctx.active_decisions.slice(3, 5)) {
      expect(briefing).toContain(d.summary);
      expect(briefing).not.toContain(d.rationale);
    }

    // Decisions 6, 7, 8 are not in the briefing at all — neither summary
    // nor rationale — despite being present in active_decisions.
    for (const d of ctx.active_decisions.slice(5)) {
      expect(briefing).not.toContain(d.summary);
      expect(briefing).not.toContain(d.rationale);
    }

    // The ladder announces the loss instead of spending the budget.
    expect(briefing).toContain("+3 more decisions");
  });

  it("GAP R17: estimateTokens is a flat 4-char heuristic and token_estimate does not measure the JSON envelope the tool returns", async () => {
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

    // The tool reports all 8 decisions while the briefing shows 5.
    expect(payload.decisions_count).toBe(SEEDED);
    expect(payload.briefing).toContain("+3 more decisions");

    // Same inputs through the engine, to inspect what was selected.
    const ctx = await assembler.assemble(TASK, SCOPE, MAX_TOKENS);

    const briefingEstimate = estimateTokens(payload.briefing);
    const envelopeEstimate = estimateTokens(envelope);

    // eslint-disable-next-line no-console
    console.log(
      `[gap7] token_estimate=${payload.token_estimate} ` +
        `briefingEstimate=${briefingEstimate} ` +
        `envelopeEstimate=${envelopeEstimate} ` +
        `briefingChars=${payload.briefing.length} envelopeChars=${envelope.length}`,
    );

    // token_estimate is NOT the briefing's own 4-char estimate: it charges
    // the raw text of every SELECTED item, including the 3 decisions the
    // formatter never rendered. Reconstruct the accounting exactly.
    const perItemCost = ctx.active_decisions.map((d) =>
      estimateTokens(
        `${d.summary} ${d.rationale} ${d.confidence} ${d.affected_files.join(", ")}`,
      ),
    );
    const selectedItemsEstimate = perItemCost.reduce((a, b) => a + b, 0);
    expect(payload.token_estimate).toBe(selectedItemsEstimate);

    // Structural, not numeric: a nonzero slice of that number pays for the
    // three decisions the agent never sees.
    const neverRenderedCost = perItemCost.slice(5).reduce((a, b) => a + b, 0);
    expect(neverRenderedCost).toBeGreaterThan(0);

    // So token_estimate is neither the briefing...
    expect(payload.token_estimate).not.toBe(briefingEstimate);
    // ...nor the size of what actually crosses the wire.
    expect(payload.token_estimate).toBeLessThan(envelopeEstimate);
  });
});
