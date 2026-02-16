/**
 * Tests for context tool handlers (twining_assemble, twining_summarize, twining_what_changed).
 * Uses the same McpServer internal handler pattern as tools.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { ContextAssembler } from "../src/engine/context-assembler.js";
import { registerContextTools } from "../src/tools/context-tools.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let tmpDir: string;
let server: McpServer;
let blackboardStore: BlackboardStore;
let decisionStore: DecisionStore;
let contextAssembler: ContextAssembler;

/**
 * Helper to call a registered tool by name.
 * Reaches into the McpServer internals to call the handler directly.
 */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const registeredTools = (
    server as unknown as {
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
  const result = await tool.handler(args, {} as unknown);
  return result as { content: Array<{ type: string; text: string }> };
}

function parseToolResponse(response: {
  content: Array<{ type: string; text: string }>;
}): unknown {
  return JSON.parse(response.content[0]!.text);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-context-tools-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "embeddings"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );

  blackboardStore = new BlackboardStore(tmpDir);
  decisionStore = new DecisionStore(tmpDir);
  contextAssembler = new ContextAssembler(
    blackboardStore,
    decisionStore,
    null, // No search engine for tool tests
    { ...DEFAULT_CONFIG },
  );

  server = new McpServer({ name: "test", version: "1.0.0" });
  registerContextTools(server, contextAssembler);
});

describe("twining_assemble", () => {
  it("should return valid AssembledContext JSON", async () => {
    const response = await callTool("twining_assemble", {
      task: "refactor auth module",
      scope: "src/auth/",
    });

    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result).toHaveProperty("assembled_at");
    expect(result).toHaveProperty("task", "refactor auth module");
    expect(result).toHaveProperty("scope", "src/auth/");
    expect(result).toHaveProperty("token_estimate");
    expect(result).toHaveProperty("active_decisions");
    expect(result).toHaveProperty("open_needs");
    expect(result).toHaveProperty("recent_findings");
    expect(result).toHaveProperty("active_warnings");
    expect(result).toHaveProperty("recent_questions");
    expect(result).toHaveProperty("related_entities");
  });

  it("should include data from stores", async () => {
    await blackboardStore.append({
      agent_id: "test",
      entry_type: "warning",
      tags: [],
      scope: "src/auth/",
      summary: "Token expiry is too short",
      detail: "Currently set to 5 minutes",
    });

    await decisionStore.create({
      agent_id: "test",
      domain: "security",
      scope: "src/auth/",
      summary: "Use JWT with RSA256",
      context: "Need stateless auth",
      rationale: "RSA256 allows public key verification",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/auth/jwt.ts"],
      affected_symbols: [],
    });

    const response = await callTool("twining_assemble", {
      task: "update auth tokens",
      scope: "src/auth/",
    });

    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(
      (result.active_warnings as unknown[]).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (result.active_decisions as unknown[]).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("should accept max_tokens parameter", async () => {
    const response = await callTool("twining_assemble", {
      task: "test task",
      scope: "project",
      max_tokens: 2000,
    });

    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result.token_estimate).toBeLessThanOrEqual(2000);
  });

  it("should use config default_max_tokens when max_tokens not provided", async () => {
    // Default is 4000 from config
    const response = await callTool("twining_assemble", {
      task: "test task",
      scope: "project",
    });

    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(typeof result.token_estimate).toBe("number");
  });
});

describe("twining_summarize", () => {
  it("should return valid SummarizeResult JSON", async () => {
    const response = await callTool("twining_summarize", {});

    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result).toHaveProperty("scope", "project");
    expect(result).toHaveProperty("active_decisions");
    expect(result).toHaveProperty("provisional_decisions");
    expect(result).toHaveProperty("open_needs");
    expect(result).toHaveProperty("active_warnings");
    expect(result).toHaveProperty("unanswered_questions");
    expect(result).toHaveProperty("recent_activity_summary");
  });

  it("should default scope to project", async () => {
    const response = await callTool("twining_summarize", {});
    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result.scope).toBe("project");
  });

  it("should accept scope parameter", async () => {
    const response = await callTool("twining_summarize", {
      scope: "src/auth/",
    });
    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result.scope).toBe("src/auth/");
  });

  it("should return accurate counts", async () => {
    await blackboardStore.append({
      agent_id: "test",
      entry_type: "warning",
      tags: [],
      scope: "project",
      summary: "Test warning",
      detail: "",
    });
    await blackboardStore.append({
      agent_id: "test",
      entry_type: "need",
      tags: [],
      scope: "project",
      summary: "Test need",
      detail: "",
    });

    const response = await callTool("twining_summarize", {});
    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result.active_warnings).toBe(1);
    expect(result.open_needs).toBe(1);
  });
});

describe("twining_what_changed", () => {
  it("should return valid WhatChangedResult JSON", async () => {
    const response = await callTool("twining_what_changed", {
      since: new Date().toISOString(),
    });

    const result = parseToolResponse(response) as Record<string, unknown>;
    expect(result).toHaveProperty("new_decisions");
    expect(result).toHaveProperty("new_entries");
    expect(result).toHaveProperty("overridden_decisions");
    expect(result).toHaveProperty("reconsidered_decisions");
  });

  it("should show entries created after since timestamp", async () => {
    const beforeTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));

    await blackboardStore.append({
      agent_id: "test",
      entry_type: "finding",
      tags: [],
      scope: "project",
      summary: "New finding",
      detail: "",
    });

    const response = await callTool("twining_what_changed", {
      since: beforeTime,
    });

    const result = parseToolResponse(response) as {
      new_entries: { summary: string }[];
    };
    expect(result.new_entries).toHaveLength(1);
    expect(result.new_entries[0]!.summary).toBe("New finding");
  });

  it("should accept scope parameter", async () => {
    const beforeTime = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));

    await blackboardStore.append({
      agent_id: "test",
      entry_type: "finding",
      tags: [],
      scope: "src/auth/",
      summary: "Auth finding",
      detail: "",
    });
    await blackboardStore.append({
      agent_id: "test",
      entry_type: "finding",
      tags: [],
      scope: "src/database/",
      summary: "DB finding",
      detail: "",
    });

    const response = await callTool("twining_what_changed", {
      since: beforeTime,
      scope: "src/auth/",
    });

    const result = parseToolResponse(response) as {
      new_entries: { summary: string }[];
    };
    expect(result.new_entries).toHaveLength(1);
    expect(result.new_entries[0]!.summary).toBe("Auth finding");
  });

  it("should return empty results when nothing changed", async () => {
    const response = await callTool("twining_what_changed", {
      since: new Date().toISOString(),
    });

    const result = parseToolResponse(response) as Record<string, unknown[]>;
    expect(result.new_entries).toHaveLength(0);
    expect(result.new_decisions).toHaveLength(0);
    expect(result.overridden_decisions).toHaveLength(0);
    expect(result.reconsidered_decisions).toHaveLength(0);
  });
});
