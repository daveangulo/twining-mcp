import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ContextAssembler } from "../../src/engine/context-assembler.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../src/storage/decision-store.js";
import { HandoffStore } from "../../src/storage/handoff-store.js";
import { AgentStore } from "../../src/storage/agent-store.js";
import { GraphStore } from "../../src/storage/graph-store.js";
import { GraphEngine } from "../../src/engine/graph.js";
import { DecisionEngine } from "../../src/engine/decisions.js";
import { BlackboardEngine } from "../../src/engine/blackboard.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { TwiningConfig, AssembledContext } from "../../src/utils/types.js";
import { estimateTokens } from "../../src/utils/tokens.js";
import { GraphAutoPopulator } from "../../src/engine/graph-auto-populator.js";

export function createTwiningDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-coord-test-"));
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "embeddings"), { recursive: true });
  fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
  fs.mkdirSync(path.join(dir, "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
  fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
  fs.writeFileSync(path.join(dir, "graph", "entities.json"), "[]");
  fs.writeFileSync(path.join(dir, "graph", "relations.json"), "[]");
  fs.writeFileSync(path.join(dir, "agents", "registry.json"), "[]");
  return dir;
}

interface AssemblerKit {
  assembler: ContextAssembler;
  blackboard: BlackboardStore;
  decisions: DecisionStore;
  handoffs: HandoffStore;
  agents: AgentStore;
  graph: GraphEngine;
  graphStore: GraphStore;
}

/** Create assembler with all stores wired up, including graph engine. */
export function createAssembler(
  twiningDir: string,
  configOverrides?: Partial<TwiningConfig>,
): AssemblerKit {
  const blackboard = new BlackboardStore(twiningDir);
  const decisions = new DecisionStore(twiningDir);
  const handoffs = new HandoffStore(twiningDir);
  const agents = new AgentStore(twiningDir);
  const graphStore = new GraphStore(twiningDir);
  const graph = new GraphEngine(graphStore);
  const config = { ...DEFAULT_CONFIG, ...configOverrides } as TwiningConfig;
  const assembler = new ContextAssembler(
    blackboard, decisions, null, config,
    graph,    // graphEngine
    null,     // planningBridge
    handoffs, // handoffStore
    agents,   // agentStore
  );
  return { assembler, blackboard, decisions, handoffs, agents, graph, graphStore };
}

/** Create a DecisionEngine for testing why() — lightweight, no embeddings. */
export function createDecisionEngine(
  twiningDir: string,
  blackboard: BlackboardStore,
  decisions: DecisionStore,
  graph?: GraphEngine,
): DecisionEngine {
  const bbEngine = new BlackboardEngine(blackboard, null, null, null);
  return new DecisionEngine(decisions, bbEngine, null, null, null, null, graph ? new GraphAutoPopulator(graph) : null);
}

export function countActionableSignals(ctx: AssembledContext): number {
  let signals = 0;
  for (const d of ctx.active_decisions) {
    if (d.rationale && d.rationale.length > 10) signals++;
    if (d.affected_files && d.affected_files.length > 0) signals++;
  }
  signals += ctx.active_warnings.length;
  for (const f of ctx.recent_findings) {
    if (/\.\w{1,4}$/.test(f.summary) || /\.\w{1,4}$/.test(f.detail ?? "")) signals++;
  }
  return signals;
}

export function formatAndCount(ctx: AssembledContext): { text: string; tokens: number } {
  const text = ContextAssembler.formatForLLM(ctx);
  return { text, tokens: estimateTokens(text) };
}

export { estimateTokens };
