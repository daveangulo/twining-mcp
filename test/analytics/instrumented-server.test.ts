import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "../../src/server.js";
import { readJSONL } from "../../src/storage/file-store.js";
import type { MetricEntry } from "../../src/utils/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-instrumented-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Call a registered tool by name, reaching into McpServer internals. */
async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const registeredTools = (
    server as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return await tool.handler(args, {} as unknown);
}

describe("Instrumented Server", () => {
  it("records successful tool call metrics", async () => {
    const { server } = createServer(tmpDir);

    // Call a tool
    await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Test finding",
      scope: "test/",
      agent_id: "test-agent",
    });

    // Wait for fire-and-forget metrics write
    await new Promise((r) => setTimeout(r, 200));

    const metricsPath = path.join(tmpDir, ".twining", "metrics.jsonl");
    const entries = await readJSONL<MetricEntry>(metricsPath);

    // Find our specific call (there may be multiple from pending processor etc.)
    const postEntry = entries.find((e) => e.tool_name === "twining_post");
    expect(postEntry).toBeDefined();
    expect(postEntry!.success).toBe(true);
    expect(postEntry!.agent_id).toBe("test-agent");
    expect(postEntry!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("records soft error metrics", async () => {
    const { server } = createServer(tmpDir);

    // Call a tool with invalid args to trigger a soft error
    await callTool(server, "twining_post", {
      entry_type: "decision",  // decisions should use twining_decide
      summary: "Should fail",
      scope: "test/",
      agent_id: "test-agent",
    });

    await new Promise((r) => setTimeout(r, 200));

    const metricsPath = path.join(tmpDir, ".twining", "metrics.jsonl");
    const entries = await readJSONL<MetricEntry>(metricsPath);
    const errEntry = entries.find(
      (e) => e.tool_name === "twining_post" && !e.success,
    );
    expect(errEntry).toBeDefined();
    expect(errEntry!.success).toBe(false);
  });

  it("extracts agent_id from tool arguments", async () => {
    const { server } = createServer(tmpDir);

    await callTool(server, "twining_recent", {
      limit: 5,
      agent_id: "my-agent-42",
    });

    await new Promise((r) => setTimeout(r, 200));

    const metricsPath = path.join(tmpDir, ".twining", "metrics.jsonl");
    const entries = await readJSONL<MetricEntry>(metricsPath);
    const recentEntry = entries.find((e) => e.tool_name === "twining_recent");
    expect(recentEntry).toBeDefined();
    expect(recentEntry!.agent_id).toBe("my-agent-42");
  });

  it("does not change tool behavior", async () => {
    const { server } = createServer(tmpDir);

    // Post an entry and verify it works normally
    const result = (await callTool(server, "twining_post", {
      entry_type: "finding",
      summary: "Normal operation",
      scope: "test/",
      agent_id: "agent",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.id).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
  });

  it("records metrics for tools without agent_id", async () => {
    const { server } = createServer(tmpDir);

    await callTool(server, "twining_recent", { limit: 5 });

    await new Promise((r) => setTimeout(r, 200));

    const metricsPath = path.join(tmpDir, ".twining", "metrics.jsonl");
    const entries = await readJSONL<MetricEntry>(metricsPath);
    const recentEntry = entries.find((e) => e.tool_name === "twining_recent");
    expect(recentEntry).toBeDefined();
    expect(recentEntry!.agent_id).toBe("unknown");
  });
});
