import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentStore } from "../src/storage/agent-store.js";
import { HandoffStore } from "../src/storage/handoff-store.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import {
  CoordinationEngine,
  scoreAgent,
  parseDelegationMetadata,
  isDelegationExpired,
  DELEGATION_TIMEOUTS,
} from "../src/engine/coordination.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { DEFAULT_LIVENESS_THRESHOLDS } from "../src/utils/liveness.js";
import type {
  AgentRecord,
  BlackboardEntry,
  DelegationMetadata,
} from "../src/utils/types.js";

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

// --- Delegation helpers and postDelegation tests (Plan 02) ---

/** Helper: build a minimal BlackboardEntry for testing parseDelegationMetadata. */
function makeEntry(overrides: Partial<BlackboardEntry> & { id: string }): BlackboardEntry {
  return {
    timestamp: new Date().toISOString(),
    agent_id: "main",
    entry_type: "need",
    tags: [],
    scope: "project",
    summary: "test entry",
    detail: "",
    ...overrides,
  };
}

describe("parseDelegationMetadata", () => {
  it("returns DelegationMetadata from valid delegation entry", () => {
    const metadata: DelegationMetadata = {
      type: "delegation",
      required_capabilities: ["code", "test"],
      urgency: "normal",
      expires_at: "2026-01-15T12:30:00.000Z",
      timeout_ms: 1800000,
    };
    const entry = makeEntry({ id: "e1", detail: JSON.stringify(metadata) });
    const result = parseDelegationMetadata(entry);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("delegation");
    expect(result!.required_capabilities).toEqual(["code", "test"]);
    expect(result!.urgency).toBe("normal");
    expect(result!.expires_at).toBe("2026-01-15T12:30:00.000Z");
  });

  it("returns null for entry with non-delegation detail", () => {
    const entry = makeEntry({ id: "e2", detail: JSON.stringify({ type: "other", foo: "bar" }) });
    const result = parseDelegationMetadata(entry);
    expect(result).toBeNull();
  });

  it("returns null for entry with invalid JSON in detail", () => {
    const entry = makeEntry({ id: "e3", detail: "not valid json {{{" });
    const result = parseDelegationMetadata(entry);
    expect(result).toBeNull();
  });

  it("returns null for entry with empty detail string", () => {
    const entry = makeEntry({ id: "e4", detail: "" });
    const result = parseDelegationMetadata(entry);
    expect(result).toBeNull();
  });
});

describe("isDelegationExpired", () => {
  const expiresAt = "2026-01-15T12:30:00.000Z";
  const metadata: DelegationMetadata = {
    type: "delegation",
    required_capabilities: ["code"],
    urgency: "normal",
    expires_at: expiresAt,
  };

  it("returns false when now is before expires_at", () => {
    const before = new Date("2026-01-15T12:29:59.000Z");
    expect(isDelegationExpired(metadata, before)).toBe(false);
  });

  it("returns true when now is after expires_at", () => {
    const after = new Date("2026-01-15T12:30:01.000Z");
    expect(isDelegationExpired(metadata, after)).toBe(true);
  });

  it("returns true when now equals expires_at (boundary)", () => {
    const exact = new Date("2026-01-15T12:30:00.000Z");
    expect(isDelegationExpired(metadata, exact)).toBe(true);
  });
});

describe("DELEGATION_TIMEOUTS", () => {
  it("has entries for high, normal, low", () => {
    expect(DELEGATION_TIMEOUTS).toHaveProperty("high");
    expect(DELEGATION_TIMEOUTS).toHaveProperty("normal");
    expect(DELEGATION_TIMEOUTS).toHaveProperty("low");
  });

  it("high < normal < low (ordering)", () => {
    expect(DELEGATION_TIMEOUTS.high).toBeLessThan(DELEGATION_TIMEOUTS.normal);
    expect(DELEGATION_TIMEOUTS.normal).toBeLessThan(DELEGATION_TIMEOUTS.low);
  });
});

describe("CoordinationEngine.postDelegation()", () => {
  it("posts a 'need' entry to blackboard with delegation metadata in detail", async () => {
    const result = await engine.postDelegation({
      summary: "Need code reviewer",
      required_capabilities: ["code-review"],
    });

    expect(result.entry_id).toBeDefined();
    expect(result.timestamp).toBeDefined();
    expect(result.expires_at).toBeDefined();

    // Verify the blackboard entry was created
    const { entries } = await blackboardEngine.read({ entry_types: ["need"] });
    const entry = entries.find((e) => e.id === result.entry_id);
    expect(entry).toBeDefined();
    expect(entry!.entry_type).toBe("need");

    // Verify detail contains delegation metadata
    const metadata = JSON.parse(entry!.detail);
    expect(metadata.type).toBe("delegation");
    expect(metadata.required_capabilities).toEqual(["code-review"]);
  });

  it("returns entry_id, timestamp, expires_at, and suggested_agents", async () => {
    const result = await engine.postDelegation({
      summary: "Need help",
      required_capabilities: ["test"],
    });

    expect(typeof result.entry_id).toBe("string");
    expect(typeof result.timestamp).toBe("string");
    expect(typeof result.expires_at).toBe("string");
    expect(Array.isArray(result.suggested_agents)).toBe(true);
  });

  it("default urgency is 'normal' with 30-minute timeout", async () => {
    const result = await engine.postDelegation({
      summary: "Normal urgency task",
      required_capabilities: ["code"],
    });

    // expires_at should be ~30 minutes from now
    const timestamp = new Date(result.timestamp).getTime();
    const expiresAt = new Date(result.expires_at).getTime();
    const diff = expiresAt - timestamp;
    // Allow small timing tolerance
    expect(diff).toBeGreaterThanOrEqual(1800000 - 1000);
    expect(diff).toBeLessThanOrEqual(1800000 + 1000);
  });

  it("high urgency uses 5-minute timeout", async () => {
    const result = await engine.postDelegation({
      summary: "Urgent task",
      required_capabilities: ["code"],
      urgency: "high",
    });

    const timestamp = new Date(result.timestamp).getTime();
    const expiresAt = new Date(result.expires_at).getTime();
    const diff = expiresAt - timestamp;
    expect(diff).toBeGreaterThanOrEqual(300000 - 1000);
    expect(diff).toBeLessThanOrEqual(300000 + 1000);
  });

  it("low urgency uses 4-hour timeout", async () => {
    const result = await engine.postDelegation({
      summary: "Low priority task",
      required_capabilities: ["code"],
      urgency: "low",
    });

    const timestamp = new Date(result.timestamp).getTime();
    const expiresAt = new Date(result.expires_at).getTime();
    const diff = expiresAt - timestamp;
    expect(diff).toBeGreaterThanOrEqual(14400000 - 1000);
    expect(diff).toBeLessThanOrEqual(14400000 + 1000);
  });

  it("custom timeout_ms overrides urgency-based default", async () => {
    const customTimeout = 60000; // 1 minute
    const result = await engine.postDelegation({
      summary: "Custom timeout task",
      required_capabilities: ["code"],
      urgency: "normal",
      timeout_ms: customTimeout,
    });

    const timestamp = new Date(result.timestamp).getTime();
    const expiresAt = new Date(result.expires_at).getTime();
    const diff = expiresAt - timestamp;
    expect(diff).toBeGreaterThanOrEqual(customTimeout - 1000);
    expect(diff).toBeLessThanOrEqual(customTimeout + 1000);
  });

  it("tags include 'delegation' and urgency level", async () => {
    await engine.postDelegation({
      summary: "Tagged task",
      required_capabilities: ["code"],
      urgency: "high",
      tags: ["custom-tag"],
    });

    const { entries } = await blackboardEngine.read({ entry_types: ["need"] });
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0]!;
    expect(entry.tags).toContain("delegation");
    expect(entry.tags).toContain("high");
    expect(entry.tags).toContain("custom-tag");
  });

  it("scope defaults to 'project' when not specified", async () => {
    await engine.postDelegation({
      summary: "Default scope task",
      required_capabilities: ["code"],
    });

    const { entries } = await blackboardEngine.read({ entry_types: ["need"] });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.scope).toBe("project");
  });

  it("required_capabilities are normalized before storing in metadata", async () => {
    const result = await engine.postDelegation({
      summary: "Normalized caps",
      required_capabilities: ["  CODE  ", "Test", "CODE"],
    });

    const { entries } = await blackboardEngine.read({ entry_types: ["need"] });
    const entry = entries.find((e) => e.id === result.entry_id);
    const metadata = JSON.parse(entry!.detail);
    // Normalized: lowercased, trimmed, deduplicated
    expect(metadata.required_capabilities).toEqual(["code", "test"]);
  });

  it("suggested_agents comes from discover() with include_gone=false", async () => {
    // Register an active agent with matching capabilities
    await agentStore.upsert({ agent_id: "helper", capabilities: ["code"] });

    const result = await engine.postDelegation({
      summary: "Need coder",
      required_capabilities: ["code"],
    });

    expect(result.suggested_agents.length).toBeGreaterThan(0);
    expect(result.suggested_agents[0]!.agent_id).toBe("helper");
  });

  it("registers 2 agents with different capabilities, verifies suggested_agents ranked correctly", async () => {
    await agentStore.upsert({ agent_id: "full-match", capabilities: ["code", "test"] });
    await agentStore.upsert({ agent_id: "partial-match", capabilities: ["code"] });

    const result = await engine.postDelegation({
      summary: "Need code and test",
      required_capabilities: ["code", "test"],
    });

    expect(result.suggested_agents.length).toBe(2);
    // full-match should rank higher
    expect(result.suggested_agents[0]!.agent_id).toBe("full-match");
    expect(result.suggested_agents[1]!.agent_id).toBe("partial-match");
    expect(result.suggested_agents[0]!.total_score).toBeGreaterThan(
      result.suggested_agents[1]!.total_score,
    );
  });
});

// ===== Handoff & Context Snapshot Tests (12-03) =====

/** Seed decisions and blackboard entries for context snapshot testing. */
async function seedHandoffTestData() {
  // Create decisions with different scopes
  const d1 = await decisionStore.create({
    agent_id: "agent-1",
    domain: "architecture",
    scope: "src/auth/",
    summary: "Use JWT for authentication",
    context: "Need stateless auth",
    rationale: "JWT is widely supported",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "high",
    reversible: true,
    affected_files: ["src/auth/jwt.ts"],
    affected_symbols: ["JwtMiddleware"],
  });
  const d2 = await decisionStore.create({
    agent_id: "agent-1",
    domain: "api",
    scope: "src/api/",
    summary: "REST over GraphQL",
    context: "Simpler to implement",
    rationale: "Better tooling support",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    reversible: true,
    affected_files: ["src/api/router.ts"],
    affected_symbols: ["Router"],
  });
  const d3 = await decisionStore.create({
    agent_id: "agent-1",
    domain: "infra",
    scope: "project",
    summary: "Use Docker for deployment",
    context: "Consistency across envs",
    rationale: "Standard practice",
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "high",
    reversible: false,
    affected_files: ["Dockerfile"],
    affected_symbols: [],
  });

  // Post warning and finding entries to blackboard
  const w1 = await blackboardStore.append({
    entry_type: "warning",
    summary: "Auth tokens expire too fast",
    detail: "Token TTL is 5 minutes",
    tags: ["auth"],
    scope: "src/auth/",
    agent_id: "agent-1",
  });
  const w2 = await blackboardStore.append({
    entry_type: "warning",
    summary: "API rate limit not configured",
    detail: "No rate limiting in place",
    tags: ["api"],
    scope: "src/api/",
    agent_id: "agent-1",
  });
  const f1 = await blackboardStore.append({
    entry_type: "finding",
    summary: "JWT library supports RS256",
    detail: "jose supports RSA and EC keys",
    tags: ["auth"],
    scope: "src/auth/",
    agent_id: "agent-1",
  });
  const f2 = await blackboardStore.append({
    entry_type: "finding",
    summary: "Docker image size is 200MB",
    detail: "Consider multi-stage build",
    tags: ["infra"],
    scope: "project",
    agent_id: "agent-1",
  });
  // A status entry (should NOT be collected by snapshot)
  await blackboardStore.append({
    entry_type: "status",
    summary: "Build passed",
    detail: "CI green",
    tags: ["ci"],
    scope: "project",
    agent_id: "agent-1",
  });

  return { decisions: [d1, d2, d3], warnings: [w1, w2], findings: [f1, f2] };
}

describe("CoordinationEngine.createHandoff()", () => {
  it("creates a handoff record with source_agent, summary, and results", async () => {
    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Completed auth module",
      results: [
        { description: "Implemented JWT middleware", status: "completed" },
      ],
    });

    expect(result.source_agent).toBe("agent-builder");
    expect(result.summary).toBe("Completed auth module");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.description).toBe("Implemented JWT middleware");
    expect(result.results[0]!.status).toBe("completed");
  });

  it("returns a HandoffRecord with generated id and created_at", async () => {
    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Done",
      results: [],
    });

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.created_at).toBeDefined();
    expect(typeof result.created_at).toBe("string");
    // Verify it's a valid ISO date
    expect(new Date(result.created_at).toISOString()).toBe(result.created_at);
  });

  it("auto-snapshot is the default (context_snapshot populated without explicit opt-in)", async () => {
    const { decisions } = await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Completed work",
      results: [],
      // No auto_snapshot specified -- should default to true
    });

    // Context snapshot should have been auto-assembled with some content
    expect(result.context_snapshot).toBeDefined();
    expect(result.context_snapshot.decision_ids.length).toBeGreaterThan(0);
  });

  it("auto_snapshot=false produces handoff with empty context_snapshot arrays", async () => {
    await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Quick handoff",
      results: [],
      auto_snapshot: false,
    });

    expect(result.context_snapshot.decision_ids).toEqual([]);
    expect(result.context_snapshot.warning_ids).toEqual([]);
    expect(result.context_snapshot.finding_ids).toEqual([]);
    expect(result.context_snapshot.summaries).toEqual([]);
  });

  it("explicit context_snapshot overrides auto-assembly", async () => {
    await seedHandoffTestData();

    const manualSnapshot = {
      decision_ids: ["manual-d1"],
      warning_ids: ["manual-w1"],
      finding_ids: [],
      summaries: ["Manual context"],
    };

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "With manual context",
      results: [],
      context_snapshot: manualSnapshot,
    });

    expect(result.context_snapshot).toEqual(manualSnapshot);
  });

  it("posts a blackboard 'status' entry with 'handoff' tag on creation", async () => {
    await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Completed auth module",
      results: [
        { description: "JWT middleware done", status: "completed" },
      ],
    });

    // Read blackboard entries to find the status entry
    const { entries } = await blackboardStore.read({
      entry_types: ["status"],
      tags: ["handoff"],
    });

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const statusEntry = entries.find((e) =>
      e.summary.startsWith("Handoff created:"),
    );
    expect(statusEntry).toBeDefined();
    expect(statusEntry!.tags).toContain("handoff");
    expect(statusEntry!.entry_type).toBe("status");
  });

  it("status entry summary starts with 'Handoff created:' and is truncated to 200 chars", async () => {
    const longSummary = "A".repeat(250);

    await engine.createHandoff({
      source_agent: "agent-builder",
      summary: longSummary,
      results: [],
    });

    const { entries } = await blackboardStore.read({
      entry_types: ["status"],
      tags: ["handoff"],
    });

    const statusEntry = entries.find((e) =>
      e.summary.startsWith("Handoff created:"),
    );
    expect(statusEntry).toBeDefined();
    expect(statusEntry!.summary.length).toBeLessThanOrEqual(200);
  });

  it("handoff with target_agent specified is persisted correctly", async () => {
    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      target_agent: "agent-reviewer",
      summary: "Review my code",
      results: [
        { description: "Code changes", status: "completed" },
      ],
    });

    expect(result.target_agent).toBe("agent-reviewer");

    // Verify persisted in store
    const stored = await handoffStore.get(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.target_agent).toBe("agent-reviewer");
  });

  it("handoff with scope filters context snapshot to that scope", async () => {
    const { decisions, warnings, findings } = await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      scope: "src/auth/",
      summary: "Auth work complete",
      results: [],
    });

    // Should include auth-scoped decisions (d1 with scope "src/auth/")
    expect(result.context_snapshot.decision_ids).toContain(decisions[0]!.id);
    expect(result.context_snapshot.warning_ids).toContain(warnings[0]!.id);
    expect(result.context_snapshot.finding_ids).toContain(findings[0]!.id);

    // API-scoped items should NOT be included (src/auth/ does not prefix-match src/api/)
    expect(result.context_snapshot.decision_ids).not.toContain(decisions[1]!.id);
    expect(result.context_snapshot.warning_ids).not.toContain(warnings[1]!.id);
  });
});

describe("assembleContextSnapshot (tested via createHandoff)", () => {
  it("auto-snapshot collects decision IDs for matching scope (bidirectional prefix)", async () => {
    const { decisions } = await seedHandoffTestData();

    // Scope "src/" should match "src/auth/" and "src/api/" (src/ is prefix of both)
    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      scope: "src/",
      summary: "Source-level work",
      results: [],
    });

    expect(result.context_snapshot.decision_ids).toContain(decisions[0]!.id); // src/auth/
    expect(result.context_snapshot.decision_ids).toContain(decisions[1]!.id); // src/api/
    // "project" scope doesn't match "src/" bidirectionally
    expect(result.context_snapshot.decision_ids).not.toContain(decisions[2]!.id);
  });

  it("auto-snapshot collects warning IDs and finding IDs from blackboard for matching scope", async () => {
    const { warnings, findings } = await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      scope: "src/auth/",
      summary: "Auth work",
      results: [],
    });

    expect(result.context_snapshot.warning_ids).toContain(warnings[0]!.id);
    expect(result.context_snapshot.warning_ids).not.toContain(warnings[1]!.id); // src/api/
    expect(result.context_snapshot.finding_ids).toContain(findings[0]!.id);
    expect(result.context_snapshot.finding_ids).not.toContain(findings[1]!.id); // project
  });

  it("auto-snapshot includes summaries (up to 5 decisions, 3 warnings, 3 findings)", async () => {
    await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Full snapshot",
      results: [],
      // No scope -- collect all
    });

    // Should have summaries for decisions, warnings, findings
    const decisionSummaries = result.context_snapshot.summaries.filter((s) =>
      s.startsWith("Decision:"),
    );
    const warningSummaries = result.context_snapshot.summaries.filter((s) =>
      s.startsWith("Warning:"),
    );
    const findingSummaries = result.context_snapshot.summaries.filter((s) =>
      s.startsWith("Finding:"),
    );

    // We have 3 decisions, 2 warnings, 2 findings
    expect(decisionSummaries.length).toBe(3);
    expect(warningSummaries.length).toBe(2);
    expect(findingSummaries.length).toBe(2);

    // Check summary format
    expect(decisionSummaries[0]).toMatch(/^Decision: /);
    expect(warningSummaries[0]).toMatch(/^Warning: /);
    expect(findingSummaries[0]).toMatch(/^Finding: /);
  });

  it("auto-snapshot with no matching scope returns empty arrays", async () => {
    await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      scope: "nonexistent/path/",
      summary: "Nothing matches",
      results: [],
    });

    expect(result.context_snapshot.decision_ids).toEqual([]);
    expect(result.context_snapshot.warning_ids).toEqual([]);
    expect(result.context_snapshot.finding_ids).toEqual([]);
    expect(result.context_snapshot.summaries).toEqual([]);
  });

  it("auto-snapshot with no scope (undefined) collects all active decisions and warnings/findings", async () => {
    const { decisions, warnings, findings } = await seedHandoffTestData();

    const result = await engine.createHandoff({
      source_agent: "agent-builder",
      summary: "Collect everything",
      results: [],
      // No scope specified
    });

    // All 3 active decisions should be included
    expect(result.context_snapshot.decision_ids).toContain(decisions[0]!.id);
    expect(result.context_snapshot.decision_ids).toContain(decisions[1]!.id);
    expect(result.context_snapshot.decision_ids).toContain(decisions[2]!.id);

    // All warnings and findings
    expect(result.context_snapshot.warning_ids).toContain(warnings[0]!.id);
    expect(result.context_snapshot.warning_ids).toContain(warnings[1]!.id);
    expect(result.context_snapshot.finding_ids).toContain(findings[0]!.id);
    expect(result.context_snapshot.finding_ids).toContain(findings[1]!.id);
  });
});

describe("CoordinationEngine.acknowledgeHandoff()", () => {
  it("acknowledges a handoff by ID, returns updated record with acknowledged_by and acknowledged_at", async () => {
    // Create a handoff first
    const handoff = await engine.createHandoff({
      source_agent: "agent-builder",
      target_agent: "agent-reviewer",
      summary: "Review this",
      results: [{ description: "Code ready", status: "completed" }],
    });

    const acked = await engine.acknowledgeHandoff(handoff.id, "agent-reviewer");

    expect(acked.id).toBe(handoff.id);
    expect(acked.acknowledged_by).toBe("agent-reviewer");
    expect(acked.acknowledged_at).toBeDefined();
    expect(typeof acked.acknowledged_at).toBe("string");
    // Verify it was persisted
    const stored = await handoffStore.get(handoff.id);
    expect(stored!.acknowledged_by).toBe("agent-reviewer");
  });

  it("returns error/throws for non-existent handoff ID", async () => {
    await expect(
      engine.acknowledgeHandoff("nonexistent-id", "agent-reviewer"),
    ).rejects.toThrow(/not found/i);
  });
});
