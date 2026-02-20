/**
 * Integration tests for context tools through full MCP server.
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

describe("twining_assemble", () => {
  it("returns assembled context with correct structure", async () => {
    const res = await callTool(server, "twining_assemble", {
      task: "Test the auth module",
      scope: "project",
    });
    const parsed = parseToolResponse(res) as Record<string, unknown>;
    expect(parsed).toHaveProperty("assembled_at");
    expect(parsed).toHaveProperty("task");
    expect(parsed).toHaveProperty("scope");
    expect(parsed).toHaveProperty("token_estimate");
    expect(parsed).toHaveProperty("active_decisions");
    expect(parsed).toHaveProperty("open_needs");
    expect(parsed).toHaveProperty("active_warnings");
  });

  it("accepts optional agent_id parameter", async () => {
    const res = await callTool(server, "twining_assemble", {
      task: "Test",
      scope: "project",
      agent_id: "test-agent",
    });
    const parsed = parseToolResponse(res) as Record<string, unknown>;
    expect(parsed).toHaveProperty("assembled_at");
  });
});

describe("twining_summarize", () => {
  it("returns summary with correct structure", async () => {
    const res = await callTool(server, "twining_summarize", {});
    const parsed = parseToolResponse(res) as Record<string, unknown>;
    expect(parsed).toHaveProperty("scope");
    expect(parsed).toHaveProperty("active_decisions");
    expect(parsed).toHaveProperty("open_needs");
    expect(parsed).toHaveProperty("active_warnings");
  });
});

describe("twining_what_changed", () => {
  it("returns changes since a timestamp", async () => {
    const before = new Date().toISOString();
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "New thing",
      tags: [],
      scope: "project",
    });
    const res = await callTool(server, "twining_what_changed", {
      since: before,
    });
    const parsed = parseToolResponse(res) as { new_entries: unknown[] };
    expect(parsed).toHaveProperty("new_entries");
    expect(parsed.new_entries.length).toBeGreaterThanOrEqual(1);
  });
});
