/**
 * Integration tests for lifecycle tools through full MCP server.
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

describe("twining_status", () => {
  it("returns health check with expected fields", async () => {
    const res = await callTool(server, "twining_status", {});
    const parsed = parseToolResponse(res) as Record<string, unknown>;
    expect(parsed).toHaveProperty("blackboard_entries");
    expect(parsed).toHaveProperty("active_decisions");
    expect(parsed).toHaveProperty("graph_entities");
    expect(parsed).toHaveProperty("graph_relations");
    expect(parsed).toHaveProperty("summary");
  });
});

describe("twining_archive", () => {
  it("returns archived count", async () => {
    const res = await callTool(server, "twining_archive", {});
    const parsed = parseToolResponse(res) as { archived_count: number };
    expect(parsed).toHaveProperty("archived_count");
    expect(parsed.archived_count).toBe(0); // Nothing to archive on fresh server
  });
});
