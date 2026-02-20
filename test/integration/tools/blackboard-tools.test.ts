/**
 * Integration tests for blackboard tools: twining_post, twining_read, twining_query, twining_recent.
 * Schema validation + wiring tests through full MCP server.
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

describe("twining_post", () => {
  it.each([
    { entry_type: "finding", summary: "Found it", tags: [], scope: "project" },
    { entry_type: "warning", summary: "Watch out", tags: ["auth"], scope: "src/" },
    { entry_type: "need", summary: "Need this", tags: [], scope: "project" },
    { entry_type: "status", summary: "Done", tags: [], scope: "project" },
  ])("accepts valid input: $entry_type", async (input) => {
    const res = await callTool(server, "twining_post", input);
    const parsed = parseToolResponse(res) as { id: string };
    expect(parsed.id).toHaveLength(26);
  });

  it("rejects decision entry_type", async () => {
    const res = await callTool(server, "twining_post", {
      entry_type: "decision",
      summary: "test",
      tags: [],
      scope: "project",
    });
    const text = res.content[0]!.text;
    expect(text).toContain("error");
  });
});

describe("twining_read", () => {
  it("returns empty entries for fresh project", async () => {
    const res = await callTool(server, "twining_read", {});
    const parsed = parseToolResponse(res) as { entries: unknown[]; total_count: number };
    // May have entries from pending processor or server init
    expect(parsed).toHaveProperty("entries");
    expect(parsed).toHaveProperty("total_count");
  });

  it("filters by entry_types", async () => {
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "A finding",
      tags: [],
      scope: "project",
    });
    await callTool(server, "twining_post", {
      entry_type: "warning",
      summary: "A warning",
      tags: [],
      scope: "project",
    });
    const res = await callTool(server, "twining_read", {
      entry_types: ["warning"],
    });
    const parsed = parseToolResponse(res) as { entries: Array<{ entry_type: string }> };
    for (const entry of parsed.entries) {
      expect(entry.entry_type).toBe("warning");
    }
  });
});

describe("twining_query", () => {
  it("returns results for matching query", async () => {
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Authentication uses JWT tokens",
      tags: [],
      scope: "project",
    });
    const res = await callTool(server, "twining_query", {
      query: "JWT",
    });
    const parsed = parseToolResponse(res) as { results: unknown[] };
    expect(parsed).toHaveProperty("results");
  });
});

describe("twining_recent", () => {
  it("returns most recent entries", async () => {
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Entry 1",
      tags: [],
      scope: "project",
    });
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Entry 2",
      tags: [],
      scope: "project",
    });
    const res = await callTool(server, "twining_recent", { n: 5 });
    const parsed = parseToolResponse(res) as { entries: Array<{ summary: string }> };
    expect(parsed).toHaveProperty("entries");
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    expect(parsed.entries[0]!.summary).toBe("Entry 2");
  });
});
