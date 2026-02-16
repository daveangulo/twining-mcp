import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";
import { registerBlackboardTools } from "../src/tools/blackboard-tools.js";
import { registerDecisionTools } from "../src/tools/decision-tools.js";
import { registerLifecycleTools } from "../src/tools/lifecycle-tools.js";

let tmpDir: string;
let server: McpServer;
let bbEngine: BlackboardEngine;
let dcsnEngine: DecisionEngine;
let bbStore: BlackboardStore;
let dcsnStore: DecisionStore;

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

  bbStore = new BlackboardStore(tmpDir);
  dcsnStore = new DecisionStore(tmpDir);
  bbEngine = new BlackboardEngine(bbStore);
  dcsnEngine = new DecisionEngine(dcsnStore, bbEngine);

  server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerBlackboardTools(server, bbEngine);
  registerDecisionTools(server, dcsnEngine);
  registerLifecycleTools(server, tmpDir, bbStore, dcsnStore);
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
});
