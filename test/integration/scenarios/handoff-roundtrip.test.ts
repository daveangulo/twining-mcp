/**
 * Scenario C: Register agent → post → handoff → acknowledge → verify snapshot.
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

describe("Scenario: full handoff roundtrip", () => {
  it("registers, posts, hands off, acknowledges, and verifies", async () => {
    // Step 1: Post findings and warnings
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Auth module needs refactor",
      tags: ["auth"],
      scope: "src/auth/",
    });
    await callTool(server, "twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "Refactor auth to middleware pattern",
      context: "Current auth is scattered",
      rationale: "Centralized auth handling",
    });

    // Step 2: Create handoff
    const handoffRes = await callTool(server, "twining_handoff", {
      source_agent: "agent-a",
      target_agent: "agent-b",
      scope: "src/auth/",
      summary: "Auth refactoring — middleware done, routes remaining",
      results: [
        { description: "Extracted JWT middleware", status: "completed" },
        { description: "Route handler migration", status: "partial" },
      ],
    });
    const handoff = parseToolResponse(handoffRes) as {
      id: string;
      source_agent: string;
    };
    expect(handoff.id).toHaveLength(26);
    expect(handoff.source_agent).toBe("agent-a");

    // Step 3: Acknowledge
    const ackRes = await callTool(server, "twining_acknowledge", {
      handoff_id: handoff.id,
      agent_id: "agent-b",
    });
    const ack = parseToolResponse(ackRes) as { acknowledged_by: string };
    expect(ack.acknowledged_by).toBe("agent-b");

    // Step 4: Verify status entry was posted
    const recentRes = await callTool(server, "twining_read", {
      entry_types: ["status"],
    });
    const readResult = parseToolResponse(recentRes) as {
      entries: Array<{ entry_type: string; summary: string }>;
    };
    expect(
      readResult.entries.some((e) => e.summary.toLowerCase().includes("handoff")),
    ).toBe(true);
  });
});
