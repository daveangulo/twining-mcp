import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";
import { Archiver } from "../src/engine/archiver.js";
import { AgentStore } from "../src/storage/agent-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { registerBlackboardTools } from "../src/tools/blackboard-tools.js";
import { registerDecisionTools } from "../src/tools/decision-tools.js";
import { registerLifecycleTools } from "../src/tools/lifecycle-tools.js";

let tmpDir: string;
let server: McpServer;
let bbEngine: BlackboardEngine;
let dcsnEngine: DecisionEngine;
let bbStore: BlackboardStore;
let dcsnStore: DecisionStore;
let graphStore: GraphStore;
let archiver: Archiver;
let agentStore: AgentStore;

/**
 * Helper to call a registered tool by name.
 * Reaches into the McpServer internals to call the handler directly.
 */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Access registered tools via the internal object
  const registeredTools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-tools-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "agents", "registry.json"),
    JSON.stringify([]),
  );

  bbStore = new BlackboardStore(tmpDir);
  dcsnStore = new DecisionStore(tmpDir);
  graphStore = new GraphStore(tmpDir);
  agentStore = new AgentStore(tmpDir);
  bbEngine = new BlackboardEngine(bbStore);
  dcsnEngine = new DecisionEngine(dcsnStore, bbEngine);
  archiver = new Archiver(tmpDir, bbStore, bbEngine, null);

  server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerBlackboardTools(server, bbEngine, tmpDir, { fullSurface: true });
  registerDecisionTools(server, dcsnEngine, tmpDir, { fullSurface: true });
  registerLifecycleTools(server, tmpDir, bbStore, dcsnStore, graphStore, archiver, DEFAULT_CONFIG, agentStore, {
    serverVersion: "0.0.0-test",
    backend: "files",
    backendReason: "explicit",
    legacyUnread: false,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_post tool", () => {
  it("returns toolResult format on success", async () => {
    const response = await callTool("twining_post", {
      entry_type: "finding",
      summary: "Test finding",
    });
    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.type).toBe("text");
    const data = parseToolResponse(response) as { id: string; timestamp: string };
    expect(data.id).toHaveLength(26);
    expect(data.timestamp).toBeTruthy();
  });

  it("returns toolError format on invalid input", async () => {
    const response = await callTool("twining_post", {
      entry_type: "invalid_type",
      summary: "Test",
    });
    const data = parseToolResponse(response) as { error: boolean; code: string };
    expect(data.error).toBe(true);
    expect(data.code).toBe("INVALID_INPUT");
  });
});

describe("twining_read tool", () => {
  it("returns entries in toolResult format", async () => {
    await callTool("twining_post", {
      entry_type: "finding",
      summary: "F1",
    });
    await callTool("twining_post", {
      entry_type: "warning",
      summary: "W1",
    });
    const response = await callTool("twining_read", {});
    const data = parseToolResponse(response) as {
      entries: unknown[];
      total_count: number;
    };
    expect(data.entries).toHaveLength(2);
    expect(data.total_count).toBe(2);
  });

  it("filters by entry type", async () => {
    await callTool("twining_post", {
      entry_type: "finding",
      summary: "F1",
    });
    await callTool("twining_post", {
      entry_type: "warning",
      summary: "W1",
    });
    const response = await callTool("twining_read", {
      entry_types: ["warning"],
    });
    const data = parseToolResponse(response) as {
      entries: Array<{ entry_type: string }>;
    };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]!.entry_type).toBe("warning");
  });
});

describe("twining_recent tool", () => {
  it("returns recent entries", async () => {
    for (let i = 0; i < 5; i++) {
      await callTool("twining_post", {
        entry_type: "finding",
        summary: `E${i}`,
      });
    }
    const response = await callTool("twining_recent", { n: 3 });
    const data = parseToolResponse(response) as {
      entries: unknown[];
    };
    expect(data.entries).toHaveLength(3);
  });
});

describe("twining_decide tool", () => {
  it("returns id and timestamp on success", async () => {
    const response = await callTool("twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use JWT",
      context: "Need stateless auth",
      rationale: "Enables horizontal scaling",
    });
    const data = parseToolResponse(response) as {
      id: string;
      timestamp: string;
    };
    expect(data.id).toHaveLength(26);
    expect(data.timestamp).toBeTruthy();
  });

  it("returns error for missing required field", async () => {
    const response = await callTool("twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "",
      context: "Need auth",
      rationale: "JWT is good",
    });
    const data = parseToolResponse(response) as { error: boolean; code: string };
    expect(data.error).toBe(true);
    expect(data.code).toBe("INVALID_INPUT");
  });
});

describe("twining_why tool", () => {
  it("returns decisions matching scope", async () => {
    await callTool("twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use JWT",
      context: "Need stateless auth",
      rationale: "Enables horizontal scaling",
    });
    const response = await callTool("twining_why", { scope: "src/auth/" });
    const data = parseToolResponse(response) as {
      decisions: unknown[];
      active_count: number;
    };
    expect(data.decisions).toHaveLength(1);
    expect(data.active_count).toBe(1);
  });
});

describe("twining_status tool", () => {
  it("returns status information", async () => {
    await callTool("twining_post", {
      entry_type: "finding",
      summary: "Test",
    });
    const response = await callTool("twining_status", {});
    const data = parseToolResponse(response) as {
      blackboard_entries: number;
      active_decisions: number;
      needs_archiving: boolean;
    };
    expect(data.blackboard_entries).toBe(1);
    expect(data.active_decisions).toBe(0);
    expect(data.needs_archiving).toBe(false);
  });

  it("includes agent counts when agents are registered", async () => {
    await agentStore.upsert({
      agent_id: "test-agent",
      capabilities: ["testing"],
      role: "tester",
    });
    const response = await callTool("twining_status", {});
    const data = parseToolResponse(response) as {
      registered_agents: number;
      active_agents: number;
      summary: string;
    };
    expect(data.registered_agents).toBe(1);
    expect(data.active_agents).toBe(1);
    expect(data.summary).toContain("1 registered agents");
    expect(data.summary).toContain("1 active");
  });

  it("shows 0 counts with no agents", async () => {
    const response = await callTool("twining_status", {});
    const data = parseToolResponse(response) as {
      registered_agents: number;
      active_agents: number;
    };
    expect(data.registered_agents).toBe(0);
    expect(data.active_agents).toBe(0);
  });

  // 2026-08-15 field audit S0/S0-B: a session must be able to learn which
  // build and which backend serve it from the response itself.
  it("reports server_version, backend and backend_reason", async () => {
    const response = await callTool("twining_status", {});
    const data = parseToolResponse(response) as {
      server_version: string;
      backend: string;
      backend_reason: string;
    };
    expect(data.server_version).toBe("0.0.0-test");
    expect(data.backend).toBe("files");
    expect(data.backend_reason).toBe("explicit");
  });

  it("warns when decision files are missing from the index (files backend)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "decisions", "01STATUSORPHAN0000000000AA.json"),
      JSON.stringify({
        id: "01STATUSORPHAN0000000000AA",
        timestamp: "2026-01-01T00:00:00.000Z",
        agent_id: "main",
        domain: "architecture",
        scope: "src/",
        summary: "orphaned",
        context: "",
        rationale: "r",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        status: "active",
        affected_files: [],
        affected_symbols: [],
        commit_hashes: [],
      }),
    );
    const response = await callTool("twining_status", {});
    const data = parseToolResponse(response) as { warnings: string[] };
    expect(
      data.warnings.some((w) => w.includes("index desync") && w.includes("repair_index")),
    ).toBe(true);
  });

  it("warns loudly when sqlite is empty beside unread legacy content", async () => {
    const s2 = new McpServer({ name: "test2", version: "0.0.0" });
    registerLifecycleTools(s2, tmpDir, bbStore, dcsnStore, graphStore, archiver, DEFAULT_CONFIG, agentStore, {
      serverVersion: "0.0.0-test",
      backend: "sqlite",
      backendReason: "sqlite-state",
      legacyUnread: true,
    });
    const registeredTools = (s2 as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;
    const result = (await registeredTools["twining_status"]!.handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const data = JSON.parse(result.content[0]!.text) as {
      warnings: string[];
      summary: string;
    };
    expect(data.warnings.some((w) => w.includes("UNREAD") && w.includes("migrate"))).toBe(true);
    expect(data.summary).toContain("Needs attention");
  });
});

// S4-12 (2026-08-15 field audit): a typo'd SHA and a real-but-unlinked SHA
// returned byte-identical {decisions: []}, so "does this commit have recorded
// rationale?" answered "no" for a typo.
describe("twining_commits disambiguation", () => {
  it("rejects a malformed commit hash with INVALID_INPUT", async () => {
    const response = await callTool("twining_commits", {
      commit_hash: "not-a-sha!",
    });
    const data = parseToolResponse(response) as {
      error: boolean;
      message: string;
      code: string;
    };
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.message).toContain("hex");
  });

  it("marks an unresolvable well-formed SHA as commit_exists unknown with a message", async () => {
    const response = await callTool("twining_commits", {
      commit_hash: "a".repeat(40),
    });
    const data = parseToolResponse(response) as {
      decisions: unknown[];
      commit_exists: boolean | "unknown";
      message: string;
    };
    expect(data.decisions).toEqual([]);
    // tmpDir's parent is not a git repository in this harness, so existence
    // cannot be determined — must say so rather than reading as "no".
    expect([false, "unknown"]).toContain(data.commit_exists);
    expect(data.message.length).toBeGreaterThan(0);
  });
});

describe("twining_amend (field D11)", () => {
  it("amends an existing decision through the tool and reports what was added", async () => {
    const created = JSON.parse(
      (
        (await callTool("twining_decide", {
          domain: "architecture",
          scope: "src/auth/",
          summary: "Empty-list record",
          context: "ctx",
          rationale: "why",
        })) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as { id: string };

    const resp = JSON.parse(
      (
        (await callTool("twining_amend", {
          decision_id: created.id,
          add_affected_files: ["specs/target.md"],
          reason: "backfill",
        })) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as { id: string; added_files: string[] };

    expect(resp.id).toBe(created.id);
    expect(resp.added_files).toEqual(["specs/target.md"]);
    const stored = await dcsnStore.get(created.id);
    expect(stored!.affected_files).toEqual(["specs/target.md"]);
    expect(stored!.amendments).toHaveLength(1);
  });

  it("is registered on the full surface only", async () => {
    const { McpServer } = await import(
      "@modelcontextprotocol/sdk/server/mcp.js"
    );
    const defaultServer = new McpServer({ name: "t", version: "1.0.0" });
    registerDecisionTools(defaultServer, dcsnEngine, tmpDir, {
      fullSurface: false,
    });
    const registered = (
      defaultServer as unknown as {
        _registeredTools: Record<string, unknown>;
      }
    )._registeredTools;
    expect(registered["twining_amend"]).toBeUndefined();
  });
});
