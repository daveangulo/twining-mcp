/**
 * Integration tests for coordination tools through full MCP server.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createTmpProjectDir,
  createTestServer,
  callTool,
  parseToolResponse,
} from "../helpers.js";

let tmpDir: string;
let server: McpServer;

beforeEach(() => {
  tmpDir = createTmpProjectDir();
  server = createTestServer(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_agents", () => {
  it("returns agent list", async () => {
    const res = await callTool(server, "twining_agents", {});
    const parsed = parseToolResponse(res) as { agents: unknown[] };
    expect(parsed).toHaveProperty("agents");
  });
});

describe("twining_discover", () => {
  it("returns discovery results", async () => {
    const res = await callTool(server, "twining_discover", {
      required_capabilities: ["typescript"],
    });
    const parsed = parseToolResponse(res) as { agents: unknown[]; total_registered: number };
    expect(parsed).toHaveProperty("agents");
    expect(parsed).toHaveProperty("total_registered");
  });
});

describe("twining_delegate", () => {
  it("creates a delegation entry", async () => {
    const res = await callTool(server, "twining_delegate", {
      summary: "Need help with tests",
      required_capabilities: ["testing"],
    });
    const parsed = parseToolResponse(res) as { entry_id: string };
    expect(parsed).toHaveProperty("entry_id");
  });
});

describe("twining_handoff + twining_acknowledge", () => {
  it("creates and acknowledges a handoff", async () => {
    const res1 = await callTool(server, "twining_handoff", {
      source_agent: "agent-a",
      summary: "Partial work done",
      results: [{ description: "Did half", status: "partial" }],
    });
    const parsed1 = parseToolResponse(res1) as { id: string; source_agent: string };
    expect(parsed1.id).toHaveLength(26);
    expect(parsed1.source_agent).toBe("agent-a");

    const res2 = await callTool(server, "twining_acknowledge", {
      handoff_id: parsed1.id,
      agent_id: "agent-b",
    });
    const parsed2 = parseToolResponse(res2) as { acknowledged_by: string };
    expect(parsed2.acknowledged_by).toBe("agent-b");
  });
});
