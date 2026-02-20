/**
 * Scenario B: Same domain+scope decisions trigger conflict warning.
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

describe("Scenario: conflict detection on same domain+scope", () => {
  it("second decision in same domain/scope gets conflict warning", async () => {
    // First decision
    await callTool(server, "twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use JWT for auth",
      context: "Need stateless auth",
      rationale: "Horizontal scaling",
    });

    // Second decision in same domain/scope with different summary
    const res = await callTool(server, "twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use sessions for auth",
      context: "Need server-side state",
      rationale: "Simpler implementation",
    });
    const parsed = parseToolResponse(res) as {
      id: string;
      conflicts?: Array<{ id: string; summary: string }>;
    };

    // Should report conflict
    expect(parsed.conflicts).toBeDefined();
    expect(parsed.conflicts!.length).toBeGreaterThanOrEqual(1);
    expect(parsed.conflicts![0]!.summary).toBe("Use JWT for auth");

    // Warning should be on blackboard
    const readRes = await callTool(server, "twining_read", {
      entry_types: ["warning"],
    });
    const entries = parseToolResponse(readRes) as {
      entries: Array<{ summary: string }>;
    };
    expect(
      entries.entries.some((e) => e.summary.includes("conflict")),
    ).toBe(true);
  });
});
