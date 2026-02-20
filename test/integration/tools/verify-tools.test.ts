/**
 * Integration tests for the twining_verify tool through full MCP server.
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
import type { VerifyResult } from "../../../src/utils/types.js";

let tmpDir: string;
let server: McpServer;

beforeEach(() => {
  tmpDir = createTmpProjectDir();
  server = createTestServer(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_verify", () => {
  it("returns verify result with all checks", async () => {
    const res = await callTool(server, "twining_verify", { scope: "project" });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.scope).toBe("project");
    expect(parsed.verified_at).toBeTruthy();
    expect(parsed.checks).toBeDefined();
    expect(parsed.checks.test_coverage).toBeDefined();
    expect(parsed.checks.warnings).toBeDefined();
    expect(parsed.checks.assembly).toBeDefined();
    expect(parsed.checks.drift).toBeDefined();
    expect(parsed.checks.constraints).toBeDefined();
    expect(parsed.summary).toBeTruthy();
  });

  it("runs only requested checks", async () => {
    const res = await callTool(server, "twining_verify", {
      scope: "project",
      checks: ["warnings", "assembly"],
    });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.checks.warnings).toBeDefined();
    expect(parsed.checks.assembly).toBeDefined();
    expect(parsed.checks.test_coverage).toBeUndefined();
    expect(parsed.checks.drift).toBeUndefined();
  });

  it("tracks assembly-before-decision end-to-end", async () => {
    // Step 1: Decide WITHOUT assembling first
    await callTool(server, "twining_decide", {
      domain: "test",
      scope: "project",
      summary: "Blind decision",
      context: "No assembly",
      rationale: "Testing",
    });

    // Step 2: Assemble, THEN decide
    await callTool(server, "twining_assemble", {
      task: "Testing assembly tracking",
      scope: "project",
    });
    await callTool(server, "twining_decide", {
      domain: "test",
      scope: "project",
      summary: "Informed decision",
      context: "After assembly",
      rationale: "Testing",
    });

    // Step 3: Verify — should show 1 blind, 1 assembled
    const res = await callTool(server, "twining_verify", {
      scope: "project",
      checks: ["assembly"],
    });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.checks.assembly!.assembled_before).toBe(1);
    expect(parsed.checks.assembly!.blind_decisions.length).toBe(1);
    expect(parsed.checks.assembly!.blind_decisions[0]!.summary).toBe(
      "Blind decision",
    );
  });
});
