/**
 * Integration tests for the twining_triage tool adapter through full MCP server.
 * TRIAGE-SPEC §10.14 tool-side expectations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createTmpProjectDir,
  createTestServer,
  callTool,
  parseToolResponse,
} from "../helpers.js";

const SEVEN_DAYS_MS = 604_800_000;

let tmpDir: string;
let server: McpServer;

beforeEach(() => {
  tmpDir = createTmpProjectDir();
  server = createTestServer(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function getRegisteredTool(
  srv: McpServer,
  name: string,
):
  | {
      inputSchema?: { safeParse: (v: unknown) => { success: boolean } };
    }
  | undefined {
  const registeredTools = (
    srv as unknown as {
      _registeredTools: Record<
        string,
        { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } }
      >;
    }
  )._registeredTools;
  return registeredTools[name];
}

describe("twining_triage registration", () => {
  it("registers when full_surface is enabled", () => {
    expect(getRegisteredTool(server, "twining_triage")).toBeDefined();
  });

  it("does not register when full_surface is disabled", () => {
    const leanDir = createTmpProjectDir();
    try {
      fs.writeFileSync(
        path.join(leanDir, ".twining", "config.yml"),
        "tools:\n  mode: full\n  full_surface: false\n",
      );
      const leanServer = createTestServer(leanDir);
      expect(getRegisteredTool(leanServer, "twining_triage")).toBeUndefined();
    } finally {
      fs.rmSync(leanDir, { recursive: true, force: true });
    }
  });
});

describe("twining_triage zod shape", () => {
  it("rejects non-numeric window_ms and limit", () => {
    const schema = getRegisteredTool(server, "twining_triage")!.inputSchema!;
    expect(schema.safeParse({ window_ms: "604800000" }).success).toBe(false);
    expect(schema.safeParse({ limit: "5" }).success).toBe(false);
  });

  it("rejects invalid section values", () => {
    const schema = getRegisteredTool(server, "twining_triage")!.inputSchema!;
    expect(schema.safeParse({ section: "bogus" }).success).toBe(false);
    expect(schema.safeParse({ section: "open" }).success).toBe(true);
  });

  it("leaves numerics unconstrained — normalization lives in buildTriage", () => {
    const schema = getRegisteredTool(server, "twining_triage")!.inputSchema!;
    expect(schema.safeParse({ window_ms: -1, limit: 0 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("twining_triage behavior", () => {
  it("defaults window_ms: -1 to 7 days via shared normalization (identical to HTTP)", async () => {
    const res = await callTool(server, "twining_triage", { window_ms: -1 });
    const parsed = parseToolResponse(res) as { window_ms: number };
    expect(parsed.window_ms).toBe(SEVEN_DAYS_MS);

    const resDefault = await callTool(server, "twining_triage", {});
    const parsedDefault = parseToolResponse(resDefault) as { window_ms: number };
    expect(parsedDefault.window_ms).toBe(SEVEN_DAYS_MS);
  });

  it("returns the bare TriageResult without HTTP-only decoration", async () => {
    const res = await callTool(server, "twining_triage", {});
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.type).toBe("text");
    const parsed = parseToolResponse(res) as Record<string, unknown>;
    expect(parsed.generated_at).toBeTruthy();
    expect(parsed.section).toBe("all");
    expect(parsed.counts).toBeDefined();
    expect(Array.isArray(parsed.open)).toBe(true);
    expect(Array.isArray(parsed.recent)).toBe(true);
    expect("initialized" in parsed).toBe(false);
  });

  it("surfaces an unresolved warning posted through the live server in open", async () => {
    await callTool(server, "twining_post", {
      entry_type: "warning",
      summary: "Unresolved triage warning",
      scope: "src/auth/",
    });
    const res = await callTool(server, "twining_triage", {});
    const parsed = parseToolResponse(res) as {
      open: Array<{ kind: string; summary: string }>;
      counts: { open: { by_kind: { warning: number } } };
    };
    expect(parsed.counts.open.by_kind.warning).toBe(1);
    expect(
      parsed.open.some(
        (i) => i.kind === "warning" && i.summary === "Unresolved triage warning",
      ),
    ).toBe(true);
  });

  it("does not write to stdout", async () => {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await callTool(server, "twining_triage", {});
      // Assert BEFORE mockRestore — restore clears mock.calls, which would
      // make a post-restore assertion pass vacuously.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
