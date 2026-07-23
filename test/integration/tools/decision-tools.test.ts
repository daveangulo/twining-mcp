/**
 * Integration tests for decision tools through full MCP server.
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

const validDecision = {
  domain: "architecture",
  scope: "src/auth/",
  summary: "Use JWT for auth",
  context: "Need stateless auth",
  rationale: "Enables horizontal scaling",
};

describe("twining_decide", () => {
  it("creates a decision and returns id", async () => {
    const res = await callTool(server, "twining_decide", validDecision);
    const parsed = parseToolResponse(res) as { id: string; timestamp: string };
    expect(parsed.id).toHaveLength(26);
    expect(parsed.timestamp).toBeTruthy();
  });

  it("rejects missing required fields", async () => {
    const res = await callTool(server, "twining_decide", {
      domain: "architecture",
    });
    const text = res.content[0]!.text;
    expect(text).toContain("error");
  });

  it("drops unknown depends_on ids and mentions them in the response message (decision F)", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id: validId } = parseToolResponse(res1) as { id: string };

    const res = await callTool(server, "twining_decide", {
      ...validDecision,
      summary: "Dependent decision",
      depends_on: [validId, "01NOTREALDECISIONIDXXXXXXX", "01ALSOFAKEDECISIONIDXXXXXX"],
    });
    const parsed = parseToolResponse(res) as {
      dropped_depends_on?: string[];
      message?: string;
    };
    expect(parsed.dropped_depends_on).toBeDefined();
    expect(parsed.dropped_depends_on!.length).toBe(2);
    expect(parsed.message).toContain("ignored 2 unknown depends_on id(s)");
  });

  it("does not include dropped_depends_on when all ids are valid (regression)", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id: validId } = parseToolResponse(res1) as { id: string };

    const res = await callTool(server, "twining_decide", {
      ...validDecision,
      summary: "Dependent decision",
      depends_on: [validId],
    });
    const parsed = parseToolResponse(res) as { dropped_depends_on?: string[] };
    expect(parsed.dropped_depends_on).toBeUndefined();
  });
});

describe("twining_why", () => {
  it("returns decisions for a scope", async () => {
    await callTool(server, "twining_decide", validDecision);
    const res = await callTool(server, "twining_why", { scope: "src/auth/" });
    const parsed = parseToolResponse(res) as { decisions: Array<{ summary: string }> };
    expect(parsed.decisions.length).toBeGreaterThanOrEqual(1);
  });

  it("honors max_tokens and adds a drill-down hint when truncated (#41)", async () => {
    for (let i = 0; i < 6; i++) {
      await callTool(server, "twining_decide", {
        ...validDecision,
        summary: `Decision number ${i}`,
        rationale: "R".repeat(400),
      });
    }
    const res = await callTool(server, "twining_why", {
      scope: "src/auth/",
      max_tokens: 200,
    });
    const parsed = parseToolResponse(res) as {
      truncated: boolean;
      more: unknown[];
      message?: string;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.more.length).toBeGreaterThan(0);
    expect(parsed.message).toContain("ids");
  });

  it("supports ids drill-down without a scope (#41)", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id } = parseToolResponse(res1) as { id: string };
    const res = await callTool(server, "twining_why", { ids: [id] });
    const parsed = parseToolResponse(res) as {
      decisions: Array<{ id: string; context?: string }>;
    };
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0]!.context).toBe("Need stateless auth");
  });

  it("errors when neither scope nor ids is provided (#41)", async () => {
    const res = await callTool(server, "twining_why", {});
    const text = res.content[0]!.text;
    expect(text).toContain("error");
  });
});

describe("twining_trace", () => {
  it("traces a decision's dependency chain", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id } = parseToolResponse(res1) as { id: string };
    const res = await callTool(server, "twining_trace", { decision_id: id });
    const parsed = parseToolResponse(res) as { chain: unknown[] };
    expect(parsed).toHaveProperty("chain");
  });
});

describe("twining_search_decisions", () => {
  it("searches decisions by keyword", async () => {
    await callTool(server, "twining_decide", validDecision);
    const res = await callTool(server, "twining_search_decisions", {
      query: "JWT",
    });
    const parsed = parseToolResponse(res) as { results: unknown[] };
    expect(parsed).toHaveProperty("results");
  });
});

describe("twining_link_commit + twining_commits", () => {
  it("links a commit and retrieves it", async () => {
    const res1 = await callTool(server, "twining_decide", validDecision);
    const { id } = parseToolResponse(res1) as { id: string };

    await callTool(server, "twining_link_commit", {
      decision_id: id,
      commit_hash: "abc123",
    });

    const res = await callTool(server, "twining_commits", {
      commit_hash: "abc123",
    });
    const parsed = parseToolResponse(res) as { decisions: Array<{ id: string }> };
    expect(parsed).toHaveProperty("decisions");
    expect(Array.isArray(parsed.decisions)).toBe(true);
    expect(parsed.decisions.length).toBeGreaterThanOrEqual(1);
    expect(parsed.decisions[0]!.id).toBe(id);
  });
});

describe("twining_decide — creation-time status (2.5.0)", () => {
  const storedStatus = async (id: string): Promise<string> => {
    const res = await callTool(server, "twining_why", { ids: [id] });
    const parsed = parseToolResponse(res) as {
      decisions: Array<{ id: string; status: string }>;
    };
    return parsed.decisions.find((d) => d.id === id)!.status;
  };

  it("creates a provisional decision when status is given and defaults to active", async () => {
    const res = await callTool(server, "twining_decide", {
      ...validDecision,
      reversible: false,
      status: "provisional",
    });
    const { id } = parseToolResponse(res) as { id: string };
    expect(await storedStatus(id)).toBe("provisional");

    const res2 = await callTool(server, "twining_decide", validDecision);
    const { id: id2 } = parseToolResponse(res2) as { id: string };
    expect(await storedStatus(id2)).toBe("active");
  });

  it("rejects lifecycle-outcome statuses at creation — engine-enforced, not schema-only", async () => {
    const res = await callTool(server, "twining_decide", {
      ...validDecision,
      status: "superseded",
    });
    expect(res.content[0]!.text).toContain("error");
  });
});
