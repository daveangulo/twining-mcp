/**
 * Integration tests for graph tools through full MCP server.
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

describe("twining_add_entity", () => {
  it("creates an entity and returns its id", async () => {
    const res = await callTool(server, "twining_add_entity", {
      name: "AuthModule",
      type: "module",
    });
    const parsed = parseToolResponse(res) as { id: string };
    expect(parsed.id).toHaveLength(26);
  });
});

describe("twining_add_relation", () => {
  it("creates a relation between entities", async () => {
    await callTool(server, "twining_add_entity", { name: "A", type: "module" });
    await callTool(server, "twining_add_entity", { name: "B", type: "module" });
    const res = await callTool(server, "twining_add_relation", {
      source: "A",
      target: "B",
      type: "depends_on",
    });
    const parsed = parseToolResponse(res) as { id: string };
    expect(parsed.id).toHaveLength(26);
  });
});

describe("twining_neighbors", () => {
  it("returns neighbors of an entity", async () => {
    await callTool(server, "twining_add_entity", { name: "A", type: "module" });
    await callTool(server, "twining_add_entity", { name: "B", type: "module" });
    await callTool(server, "twining_add_relation", {
      source: "A",
      target: "B",
      type: "depends_on",
    });
    const res = await callTool(server, "twining_neighbors", { entity: "A" });
    const parsed = parseToolResponse(res) as { center: unknown; neighbors: unknown[] };
    expect(parsed.neighbors).toHaveLength(1);
  });
});

describe("twining_graph_query", () => {
  it("finds entities by name substring", async () => {
    await callTool(server, "twining_add_entity", { name: "AuthModule", type: "module" });
    const res = await callTool(server, "twining_graph_query", { query: "Auth" });
    const parsed = parseToolResponse(res) as { entities: Array<{ name: string }> };
    expect(parsed.entities.some((e) => e.name === "AuthModule")).toBe(true);
  });
});
