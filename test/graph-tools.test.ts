/**
 * Tool-level tests for registerGraphTools (wave C: provenance marker).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { GraphEngine } from "../src/engine/graph.js";
import { registerGraphTools } from "../src/tools/graph-tools.js";

let tmpDir: string;
let server: McpServer;
let graphStore: GraphStore;

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  const tool = registered[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const resp = (await tool.handler(args, {} as unknown)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(resp.content[0]!.text);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-graph-tools-"));
  fs.mkdirSync(path.join(tmpDir, "graph"), { recursive: true });
  graphStore = new GraphStore(tmpDir);
  server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerGraphTools(server, new GraphEngine(graphStore));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_add_relation — declared-origin stamp (field D13 ask 4)", () => {
  it("stamps agent-typed relations origin: declared", async () => {
    await callTool("twining_add_entity", { name: "src/a.ts", type: "file" });
    await callTool("twining_add_entity", { name: "test/a.test.ts", type: "file" });
    await callTool("twining_add_relation", {
      source: "src/a.ts",
      target: "test/a.test.ts",
      type: "tested_by",
      properties: { covers: "happy path" },
    });
    const relations = await graphStore.getRelations();
    expect(relations).toHaveLength(1);
    expect(relations[0]!.properties).toEqual({
      covers: "happy path",
      origin: "declared",
    });
  });

  it("a caller-supplied origin wins over the stamp", async () => {
    await callTool("twining_add_entity", { name: "a", type: "module" });
    await callTool("twining_add_entity", { name: "b", type: "module" });
    await callTool("twining_add_relation", {
      source: "a",
      target: "b",
      type: "depends_on",
      properties: { origin: "derived" },
    });
    const relations = await graphStore.getRelations();
    expect(relations[0]!.properties.origin).toBe("derived");
  });
});
