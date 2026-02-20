/**
 * Scenario D: Decide with affected_files → neighbors shows decided_by.
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

describe("Scenario: graph auto-population from decisions", () => {
  it("decide with affected_files creates entities and decided_by relations", async () => {
    // Create a decision with affected files
    const decideRes = await callTool(server, "twining_decide", {
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use middleware pattern",
      context: "Auth is scattered",
      rationale: "Centralized handling",
      affected_files: ["src/auth/middleware.ts", "src/auth/router.ts"],
      affected_symbols: ["AuthMiddleware"],
    });
    const decision = parseToolResponse(decideRes) as { id: string };

    // Verify entities were created
    const queryRes = await callTool(server, "twining_graph_query", {
      query: "auth",
    });
    const entities = parseToolResponse(queryRes) as {
      entities: Array<{ name: string; type: string }>;
    };
    const entityNames = entities.entities.map((e) => e.name);
    expect(entityNames).toContain("src/auth/middleware.ts");
    expect(entityNames).toContain("src/auth/router.ts");
    expect(entityNames).toContain("AuthMiddleware");

    // Verify decided_by relations via neighbors
    const neighborsRes = await callTool(server, "twining_neighbors", {
      entity: "src/auth/middleware.ts",
    });
    const neighbors = parseToolResponse(neighborsRes) as {
      neighbors: Array<{
        relation: { type: string };
        entity: { name: string };
      }>;
    };
    expect(
      neighbors.neighbors.some((n) => n.relation.type === "decided_by"),
    ).toBe(true);
  });
});
