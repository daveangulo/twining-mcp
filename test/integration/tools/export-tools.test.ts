/**
 * Integration tests for export tools through full MCP server.
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

describe("twining_export", () => {
  it("returns markdown export", async () => {
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Export test",
      tags: [],
      scope: "project",
    });
    const res = await callTool(server, "twining_export", {});
    const text = res.content[0]!.text;
    expect(text).toContain("Export test");
  });

  it("filters by scope", async () => {
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Auth finding",
      tags: [],
      scope: "src/auth/",
    });
    const res = await callTool(server, "twining_export", { scope: "src/auth/" });
    const text = res.content[0]!.text;
    expect(text).toContain("Auth finding");
  });
});
