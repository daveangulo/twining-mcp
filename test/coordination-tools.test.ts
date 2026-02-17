import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentStore } from "../src/storage/agent-store.js";
import { HandoffStore } from "../src/storage/handoff-store.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { CoordinationEngine } from "../src/engine/coordination.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { registerCoordinationTools } from "../src/tools/coordination-tools.js";

let tmpDir: string;
let server: McpServer;
let agentStore: AgentStore;

/**
 * Helper to call a registered tool by name.
 * Reaches into the McpServer internals to call the handler directly.
 */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args, {} as unknown);
  return result as { content: Array<{ type: string; text: string }> };
}

function parseToolResponse(response: {
  content: Array<{ type: string; text: string }>;
}): unknown {
  return JSON.parse(response.content[0]!.text);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-coord-tools-test-"),
  );
  // Set up blackboard for engine dependencies
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  // Set up agents directory
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "agents", "registry.json"),
    JSON.stringify([]),
  );

  agentStore = new AgentStore(tmpDir);
  const handoffStore = new HandoffStore(tmpDir);
  const bbStore = new BlackboardStore(tmpDir);
  const dcsnStore = new DecisionStore(tmpDir);
  const bbEngine = new BlackboardEngine(bbStore);
  const coordinationEngine = new CoordinationEngine(
    agentStore,
    handoffStore,
    bbEngine,
    dcsnStore,
    bbStore,
    DEFAULT_CONFIG,
  );

  server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerCoordinationTools(server, agentStore, coordinationEngine, DEFAULT_CONFIG);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_agents tool", () => {
  it("returns empty array when no agents registered", async () => {
    const response = await callTool("twining_agents", {});
    const data = parseToolResponse(response) as {
      agents: unknown[];
      total_registered: number;
      active_count: number;
    };
    expect(data.agents).toHaveLength(0);
    expect(data.total_registered).toBe(0);
    expect(data.active_count).toBe(0);
  });

  it("returns agents with liveness status computed from timestamps", async () => {
    await agentStore.upsert({
      agent_id: "agent-1",
      capabilities: ["code-review"],
      role: "reviewer",
      description: "Reviews code",
    });

    const response = await callTool("twining_agents", {});
    const data = parseToolResponse(response) as {
      agents: Array<{
        agent_id: string;
        capabilities: string[];
        role: string;
        description: string;
        registered_at: string;
        last_active: string;
        liveness: string;
      }>;
      total_registered: number;
      active_count: number;
    };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]!.agent_id).toBe("agent-1");
    expect(data.agents[0]!.capabilities).toEqual(["code-review"]);
    expect(data.agents[0]!.role).toBe("reviewer");
    expect(data.agents[0]!.description).toBe("Reviews code");
    expect(data.agents[0]!.liveness).toBe("active");
    expect(data.agents[0]!.registered_at).toBeTruthy();
    expect(data.agents[0]!.last_active).toBeTruthy();
  });

  it("filters out gone agents when include_gone=false", async () => {
    // Register an agent, then manually set last_active to long ago
    await agentStore.upsert({
      agent_id: "old-agent",
      capabilities: ["testing"],
    });
    // Write a stale last_active directly
    const registryPath = path.join(tmpDir, "agents", "registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    registry[0].last_active = new Date(
      Date.now() - 60 * 60 * 1000,
    ).toISOString(); // 1 hour ago (gone)
    fs.writeFileSync(registryPath, JSON.stringify(registry));

    // Register a fresh agent
    await agentStore.upsert({
      agent_id: "fresh-agent",
      capabilities: ["coding"],
    });

    const response = await callTool("twining_agents", {
      include_gone: false,
    });
    const data = parseToolResponse(response) as {
      agents: Array<{ agent_id: string; liveness: string }>;
      total_registered: number;
      active_count: number;
    };
    // Should only have the fresh agent
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]!.agent_id).toBe("fresh-agent");
    expect(data.agents[0]!.liveness).toBe("active");
    // total_registered counts all, even filtered
    expect(data.total_registered).toBe(2);
    expect(data.active_count).toBe(1);
  });

  it("returns all agents including gone when include_gone=true (default)", async () => {
    await agentStore.upsert({
      agent_id: "old-agent",
      capabilities: ["testing"],
    });
    // Make old-agent gone
    const registryPath = path.join(tmpDir, "agents", "registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    registry[0].last_active = new Date(
      Date.now() - 60 * 60 * 1000,
    ).toISOString();
    fs.writeFileSync(registryPath, JSON.stringify(registry));

    await agentStore.upsert({
      agent_id: "fresh-agent",
      capabilities: ["coding"],
    });

    // Default (no include_gone specified) should include gone
    const response = await callTool("twining_agents", {});
    const data = parseToolResponse(response) as {
      agents: Array<{ agent_id: string; liveness: string }>;
      total_registered: number;
    };
    expect(data.agents).toHaveLength(2);
    const oldAgent = data.agents.find((a) => a.agent_id === "old-agent");
    expect(oldAgent!.liveness).toBe("gone");
  });

  it("returns correct total_registered and active_count metrics", async () => {
    // Register 3 agents: 2 active, 1 gone
    await agentStore.upsert({
      agent_id: "a1",
      capabilities: ["cap1"],
    });
    await agentStore.upsert({
      agent_id: "a2",
      capabilities: ["cap2"],
    });
    await agentStore.upsert({
      agent_id: "a3",
      capabilities: ["cap3"],
    });

    // Make a3 gone
    const registryPath = path.join(tmpDir, "agents", "registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    const a3 = registry.find(
      (a: { agent_id: string }) => a.agent_id === "a3",
    );
    a3.last_active = new Date(
      Date.now() - 60 * 60 * 1000,
    ).toISOString();
    fs.writeFileSync(registryPath, JSON.stringify(registry));

    const response = await callTool("twining_agents", {});
    const data = parseToolResponse(response) as {
      agents: unknown[];
      total_registered: number;
      active_count: number;
    };
    expect(data.total_registered).toBe(3);
    expect(data.active_count).toBe(2);
    expect(data.agents).toHaveLength(3);
  });

  it("handles errors gracefully (returns toolError)", async () => {
    // Break the agent store by making the registry file unreadable JSON
    const registryPath = path.join(tmpDir, "agents", "registry.json");
    // AgentStore.readRegistry returns [] on any read error, so this won't actually error.
    // Instead, let's test with a store that will throw:
    // We need to override agentStore.getAll to throw
    const brokenServer = new McpServer({
      name: "test-broken",
      version: "1.0.0",
    });
    const brokenStore = {
      getAll: async () => {
        throw new Error("Storage failure");
      },
    } as unknown as AgentStore;
    const handoffStore = new HandoffStore(tmpDir);
    const bbStore = new BlackboardStore(tmpDir);
    const dcsnStore = new DecisionStore(tmpDir);
    const bbEngine = new BlackboardEngine(bbStore);
    const brokenEngine = new CoordinationEngine(
      brokenStore,
      handoffStore,
      bbEngine,
      dcsnStore,
      bbStore,
      DEFAULT_CONFIG,
    );

    registerCoordinationTools(
      brokenServer,
      brokenStore,
      brokenEngine,
      DEFAULT_CONFIG,
    );

    const registeredTools = (
      brokenServer as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: Record<string, unknown>,
              extra: unknown,
            ) => Promise<unknown>;
          }
        >;
      }
    )._registeredTools;
    const tool = registeredTools["twining_agents"];
    const result = (await tool!.handler(
      {},
      {} as unknown,
    )) as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0]!.text) as {
      error: boolean;
      message: string;
      code: string;
    };
    expect(data.error).toBe(true);
    expect(data.message).toBe("Storage failure");
    expect(data.code).toBe("INTERNAL_ERROR");
  });
});
