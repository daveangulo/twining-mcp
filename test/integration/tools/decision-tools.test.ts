/**
 * Integration tests for decision tools through full MCP server.
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

const validDecision = {
  domain: "architecture",
  scope: "src/auth/",
  summary: "Use JWT for auth",
  context: "Need stateless auth",
  rationale: "Enables horizontal scaling",
};

describe("twining_decide", () => {
  it("creates a decision and returns id", async () => {
    const res = await callTool(server, "twining_decide", validDecision);
    const parsed = parseToolResponse(res) as { id: string; timestamp: string };
    expect(parsed.id).toHaveLength(26);
    expect(parsed.timestamp).toBeTruthy();
  });

  it("rejects missing required fields", async () => {
    const res = await callTool(server, "twining_decide", {
      domain: "architecture",
    });
    const text = res.content[0]!.text;
    expect(text).toContain("error");
  });
});

describe("twining_why", () => {
  it("returns decisions for a scope", async () => {
    await callTool(server, "twining_decide", validDecision);
    const res = await callTool(server, "twining_why", { scope: "src/auth/" });
    const parsed = parseToolResponse(res) as { decisions: Array<{ summary: string }> };
    expect(parsed.decisions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("twining_trace", () => {
  it("traces a decision's dependency chain", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id } = parseToolResponse(res1) as { id: string };
    const res = await callTool(server, "twining_trace", { decision_id: id });
    const parsed = parseToolResponse(res) as { chain: unknown[] };
    expect(parsed).toHaveProperty("chain");
  });
});

describe("twining_search_decisions", () => {
  it("searches decisions by keyword", async () => {
    await callTool(server, "twining_decide", validDecision);
    const res = await callTool(server, "twining_search_decisions", {
      query: "JWT",
    });
    const parsed = parseToolResponse(res) as { results: unknown[] };
    expect(parsed).toHaveProperty("results");
  });
});

describe("twining_link_commit + twining_commits", () => {
  it("links a commit and retrieves it", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id } = parseToolResponse(res1) as { id: string };

    await callTool(server, "twining_link_commit", {
      decision_id: id,
      commit_hash: "abc123",
    });

    const res = await callTool(server, "twining_commits", {
      commit_hash: "abc123",
    });
    const parsed = parseToolResponse(res) as { decisions: Array<{ id: string }> };
    expect(parsed).toHaveProperty("decisions");
    expect(Array.isArray(parsed.decisions)).toBe(true);
    expect(parsed.decisions.length).toBeGreaterThanOrEqual(1);
    expect(parsed.decisions[0]!.id).toBe(id);
  });
});
