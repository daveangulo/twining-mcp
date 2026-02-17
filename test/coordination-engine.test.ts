import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentStore } from "../src/storage/agent-store.js";
import { HandoffStore } from "../src/storage/handoff-store.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { CoordinationEngine, scoreAgent } from "../src/engine/coordination.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { DEFAULT_LIVENESS_THRESHOLDS } from "../src/utils/liveness.js";
import type { AgentRecord } from "../src/utils/types.js";

let tmpDir: string;
let agentStore: AgentStore;
let handoffStore: HandoffStore;
let blackboardStore: BlackboardStore;
let blackboardEngine: BlackboardEngine;
let decisionStore: DecisionStore;
let engine: CoordinationEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-coord-test-"));
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "agents", "registry.json"),
    JSON.stringify([]),
  );
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  fs.mkdirSync(path.join(tmpDir, "handoffs"), { recursive: true });

  agentStore = new AgentStore(tmpDir);
  handoffStore = new HandoffStore(tmpDir);
  blackboardStore = new BlackboardStore(tmpDir);
  blackboardEngine = new BlackboardEngine(blackboardStore);
  decisionStore = new DecisionStore(tmpDir);
  engine = new CoordinationEngine(
    agentStore,
    handoffStore,
    blackboardEngine,
    decisionStore,
    blackboardStore,
    DEFAULT_CONFIG,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: build an AgentRecord for testing scoreAgent. */
function makeAgent(overrides: Partial<AgentRecord> & { agent_id: string }): AgentRecord {
  const now = new Date().toISOString();
  return {
    capabilities: [],
    registered_at: now,
    last_active: now,
    ...overrides,
  };
}

describe("scoreAgent pure function", () => {
  const now = new Date("2026-01-15T12:00:00Z");

  it("full capability match with active agent returns overlap=1.0, liveness=1.0, total=1.0", () => {
    const agent = makeAgent({
      agent_id: "a1",
      capabilities: ["code", "test", "deploy"],
      last_active: now.toISOString(), // active (0ms elapsed)
    });
    const score = scoreAgent(agent, ["code", "test", "deploy"], DEFAULT_LIVENESS_THRESHOLDS, now);
    expect(score.agent_id).toBe("a1");
    expect(score.capability_overlap).toBe(1.0);
    expect(score.liveness_score).toBe(1.0);
    expect(score.total_score).toBe(1.0);
    expect(score.liveness).toBe("active");
    expect(score.matched_capabilities).toEqual(["code", "test", "deploy"]);
  });

  it("partial capability match (2/4) returns overlap=0.5", () => {
    const agent = makeAgent({
      agent_id: "a2",
      capabilities: ["code", "test"],
      last_active: now.toISOString(),
    });
    const score = scoreAgent(agent, ["code", "test", "deploy", "review"], DEFAULT_LIVENESS_THRESHOLDS, now);
    expect(score.capability_overlap).toBe(0.5);
    expect(score.matched_capabilities).toEqual(["code", "test"]);
  });

  it("no capability match returns overlap=0.0", () => {
    const agent = makeAgent({
      agent_id: "a3",
      capabilities: ["design"],
      last_active: now.toISOString(),
    });
    const score = scoreAgent(agent, ["code", "test"], DEFAULT_LIVENESS_THRESHOLDS, now);
    expect(score.capability_overlap).toBe(0.0);
    expect(score.matched_capabilities).toEqual([]);
  });

  it("idle agent gets liveness_score=0.5", () => {
    // idle_after_ms = 5min = 300000ms, gone_after_ms = 30min = 1800000ms
    // 10 minutes ago => idle
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const agent = makeAgent({
      agent_id: "a4",
      capabilities: ["code"],
      last_active: tenMinAgo,
    });
    const score = scoreAgent(agent, ["code"], DEFAULT_LIVENESS_THRESHOLDS, now);
    expect(score.liveness).toBe("idle");
    expect(score.liveness_score).toBe(0.5);
  });

  it("gone agent gets liveness_score=0.1", () => {
    // 60 minutes ago => gone
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const agent = makeAgent({
      agent_id: "a5",
      capabilities: ["code"],
      last_active: hourAgo,
    });
    const score = scoreAgent(agent, ["code"], DEFAULT_LIVENESS_THRESHOLDS, now);
    expect(score.liveness).toBe("gone");
    expect(score.liveness_score).toBe(0.1);
  });

  it("zero required capabilities returns overlap=0, no NaN, ranked by liveness only", () => {
    const agent = makeAgent({
      agent_id: "a6",
      capabilities: ["code", "test"],
      last_active: now.toISOString(),
    });
    const score = scoreAgent(agent, [], DEFAULT_LIVENESS_THRESHOLDS, now);
    expect(score.capability_overlap).toBe(0);
    expect(Number.isNaN(score.total_score)).toBe(false);
    expect(score.liveness_score).toBe(1.0);
    // With zero capabilities: total = 0.7*0 + 0.3*1.0 = 0.3
    expect(score.total_score).toBeCloseTo(0.3);
    expect(score.matched_capabilities).toEqual([]);
  });

  it("weighted total: 0.7*capability + 0.3*liveness for specific case", () => {
    // capability_overlap = 0.5 (1/2 match), liveness = idle (0.5)
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const agent = makeAgent({
      agent_id: "a7",
      capabilities: ["code"],
      last_active: tenMinAgo,
    });
    const score = scoreAgent(agent, ["code", "test"], DEFAULT_LIVENESS_THRESHOLDS, now);
    // 0.7*0.5 + 0.3*0.5 = 0.35 + 0.15 = 0.5
    expect(score.total_score).toBeCloseTo(0.5);
  });
});

describe("CoordinationEngine.discover()", () => {
  it("empty registry returns empty agents and total_registered=0", async () => {
    const result = await engine.discover({ required_capabilities: ["code"] });
    expect(result.agents).toEqual([]);
    expect(result.total_registered).toBe(0);
  });

  it("multiple agents sorted by total_score descending", async () => {
    const now = new Date();
    // Register agents with different capabilities
    await agentStore.upsert({ agent_id: "full-match", capabilities: ["code", "test"] });
    await agentStore.upsert({ agent_id: "partial-match", capabilities: ["code"] });
    await agentStore.upsert({ agent_id: "no-match", capabilities: ["design"] });

    const result = await engine.discover({ required_capabilities: ["code", "test"] });
    expect(result.agents.length).toBe(3);
    expect(result.total_registered).toBe(3);

    // Sorted descending by total_score
    expect(result.agents[0]!.agent_id).toBe("full-match");
    expect(result.agents[0]!.total_score).toBeGreaterThan(result.agents[1]!.total_score);
    expect(result.agents[1]!.agent_id).toBe("partial-match");
  });

  it("include_gone=false filters out gone agents", async () => {
    // Register an active agent
    await agentStore.upsert({ agent_id: "active-agent", capabilities: ["code"] });

    // Register a "gone" agent by manipulating the registry directly
    const agents = await agentStore.getAll();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Write a gone agent directly
    const goneAgent: AgentRecord = {
      agent_id: "gone-agent",
      capabilities: ["code"],
      registered_at: hourAgo,
      last_active: hourAgo,
    };
    const registryPath = path.join(tmpDir, "agents", "registry.json");
    const currentAgents = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    currentAgents.push(goneAgent);
    fs.writeFileSync(registryPath, JSON.stringify(currentAgents));

    const result = await engine.discover({
      required_capabilities: ["code"],
      include_gone: false,
    });

    // Gone agent should be filtered out
    const agentIds = result.agents.map((a) => a.agent_id);
    expect(agentIds).toContain("active-agent");
    expect(agentIds).not.toContain("gone-agent");
    // But total_registered should reflect ALL agents
    expect(result.total_registered).toBe(2);
  });

  it("min_score filters out low-scoring agents", async () => {
    await agentStore.upsert({ agent_id: "good", capabilities: ["code", "test"] });
    await agentStore.upsert({ agent_id: "poor", capabilities: ["design"] });

    const result = await engine.discover({
      required_capabilities: ["code", "test"],
      min_score: 0.8,
    });

    // Only the good agent should pass the threshold
    const agentIds = result.agents.map((a) => a.agent_id);
    expect(agentIds).toContain("good");
    expect(agentIds).not.toContain("poor");
  });

  it("tags normalized before matching (uppercase input matches lowercase capabilities)", async () => {
    await agentStore.upsert({ agent_id: "agent-1", capabilities: ["code"] });

    const result = await engine.discover({
      required_capabilities: ["  CODE  ", "TEST"],
    });

    // "CODE" normalized to "code" should match agent-1's "code" capability
    const agent = result.agents.find((a) => a.agent_id === "agent-1");
    expect(agent).toBeDefined();
    expect(agent!.capability_overlap).toBeGreaterThan(0);
    expect(agent!.matched_capabilities).toContain("code");
  });
});
