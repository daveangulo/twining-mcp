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

  it("drift returns skip in non-git directory", async () => {
    const res = await callTool(server, "twining_verify", {
      scope: "project",
      checks: ["drift"],
    });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.checks.drift?.status).toBe("skip");
  });

  it("constraints returns skip when no checkable constraints exist", async () => {
    const res = await callTool(server, "twining_verify", {
      scope: "project",
      checks: ["constraints"],
    });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.checks.constraints?.status).toBe("skip");
  });

  it("constraints checks a posted constraint end-to-end", async () => {
    // Post a checkable constraint
    await callTool(server, "twining_post", {
      entry_type: "constraint",
      summary: "Echo check",
      detail: JSON.stringify({ check_command: "echo hello", expected: "hello" }),
      tags: ["test"],
      scope: "project",
    });

    const res = await callTool(server, "twining_verify", {
      scope: "project",
      checks: ["constraints"],
    });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.checks.constraints?.status).toBe("pass");
    expect(parsed.checks.constraints?.checkable).toBe(1);
    expect(parsed.checks.constraints?.passed).toBe(1);
  });

  it("constraints rejects commands with newlines end-to-end", async () => {
    await callTool(server, "twining_post", {
      entry_type: "constraint",
      summary: "Newline injection",
      detail: JSON.stringify({ check_command: "echo safe\nrm -rf /", expected: "safe" }),
      tags: ["test"],
      scope: "project",
    });

    const res = await callTool(server, "twining_verify", {
      scope: "project",
      checks: ["constraints"],
    });
    const parsed = parseToolResponse(res) as VerifyResult;
    expect(parsed.checks.constraints?.status).toBe("fail");
    expect(parsed.checks.constraints?.failed[0]!.actual).toContain("REJECTED");
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
