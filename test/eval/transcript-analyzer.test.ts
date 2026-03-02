import { describe, it, expect } from "vitest";
import { parseTranscript, normalizeMcpToolName, isTwiningTool } from "./transcript-analyzer.js";
import type { NormalizedToolCall } from "./scenario-schema.js";

// ---------------------------------------------------------------------------
// Helper: build JSONL lines
// ---------------------------------------------------------------------------

function assistantWithTools(
  tools: { name: string; input?: Record<string, unknown>; id?: string }[],
  opts?: { sessionId?: string; uuid?: string },
): string {
  return JSON.stringify({
    type: "assistant",
    uuid: opts?.uuid ?? "asst-1",
    sessionId: opts?.sessionId ?? "session-1",
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: tools.map((t, i) => ({
        type: "tool_use",
        id: t.id ?? `tool-use-${i}`,
        name: t.name,
        input: t.input ?? {},
      })),
    },
  });
}

function userWithResults(
  results: { tool_use_id: string; content?: string | unknown[]; is_error?: boolean }[],
): string {
  return JSON.stringify({
    type: "user",
    uuid: "user-1",
    message: {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// NormalizedToolCall result field
// ---------------------------------------------------------------------------

describe("NormalizedToolCall result field", () => {
  it("has optional result field with content and isError", () => {
    const call: NormalizedToolCall = {
      tool: "twining_post",
      arguments: {},
      index: 0,
      result: { content: "some result", isError: false },
    };
    expect(call.result).toEqual({ content: "some result", isError: false });
  });

  it("allows result to be undefined", () => {
    const call: NormalizedToolCall = {
      tool: "twining_post",
      arguments: {},
      index: 0,
    };
    expect(call.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeMcpToolName
// ---------------------------------------------------------------------------

describe("normalizeMcpToolName", () => {
  it("normalizes mcp__twining__twining_post to twining_post", () => {
    expect(normalizeMcpToolName("mcp__twining__twining_post")).toBe("twining_post");
  });

  it("normalizes mcp__plugin_twining_twining__twining_post to twining_post", () => {
    expect(normalizeMcpToolName("mcp__plugin_twining_twining__twining_post")).toBe("twining_post");
  });

  it("returns bare names unchanged", () => {
    expect(normalizeMcpToolName("twining_decide")).toBe("twining_decide");
  });

  it("normalizes other MCP-prefixed non-twining names", () => {
    expect(normalizeMcpToolName("mcp__serena__get_symbols")).toBe("get_symbols");
  });
});

// ---------------------------------------------------------------------------
// isTwiningTool
// ---------------------------------------------------------------------------

describe("isTwiningTool", () => {
  it("returns true for twining_ prefixed names", () => {
    expect(isTwiningTool("twining_post")).toBe(true);
    expect(isTwiningTool("twining_decide")).toBe(true);
    expect(isTwiningTool("twining_assemble_context")).toBe(true);
  });

  it("returns false for non-twining names", () => {
    expect(isTwiningTool("get_symbols")).toBe(false);
    expect(isTwiningTool("Read")).toBe(false);
    expect(isTwiningTool("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript: tool_use extraction
// ---------------------------------------------------------------------------

describe("parseTranscript tool_use extraction", () => {
  it("extracts tool_use blocks from assistant messages", () => {
    const jsonl = assistantWithTools([
      { name: "mcp__twining__twining_post", input: { content: "hello" } },
    ]);
    const result = parseTranscript(jsonl);
    expect(result.segments.length).toBeGreaterThanOrEqual(1);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls).toHaveLength(1);
    expect(allCalls[0].tool).toBe("twining_post");
    expect(allCalls[0].arguments).toEqual({ content: "hello" });
  });

  it("filters out non-twining tool calls after normalization", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_post", id: "t1" },
        { name: "mcp__serena__get_symbols", id: "t2" },
        { name: "Read", id: "t3" },
      ]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls).toHaveLength(1);
    expect(allCalls[0].tool).toBe("twining_post");
  });
});

// ---------------------------------------------------------------------------
// parseTranscript: tool_result pairing
// ---------------------------------------------------------------------------

describe("parseTranscript tool_result pairing", () => {
  it("pairs tool_result blocks with tool_use via tool_use_id", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_post", input: { content: "test" }, id: "tu-1" },
      ]),
      userWithResults([
        { tool_use_id: "tu-1", content: "Success: posted" },
      ]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls).toHaveLength(1);
    expect(allCalls[0].result).toEqual({ content: "Success: posted", isError: false });
  });

  it("handles array content format in tool_result", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_decide", id: "tu-2" },
      ]),
      userWithResults([
        {
          tool_use_id: "tu-2",
          content: [{ type: "text", text: "Decision recorded" }],
        },
      ]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls[0].result).toEqual({ content: "Decision recorded", isError: false });
  });

  it("handles undefined/null content in tool_result", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_post", id: "tu-3" },
      ]),
      userWithResults([
        { tool_use_id: "tu-3" },
      ]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls[0].result).toEqual({ content: null, isError: false });
  });

  it("handles is_error: true tool results", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_post", id: "tu-4" },
      ]),
      userWithResults([
        { tool_use_id: "tu-4", content: "Error: not found", is_error: true },
      ]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls[0].result).toEqual({ content: "Error: not found", isError: true });
  });
});

// ---------------------------------------------------------------------------
// parseTranscript: MCP name normalization
// ---------------------------------------------------------------------------

describe("parseTranscript MCP name normalization", () => {
  it("normalizes both MCP prefix patterns", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_post", id: "t1" },
      ]),
      assistantWithTools([
        { name: "mcp__plugin_twining_twining__twining_decide", id: "t2" },
      ]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls.map((c) => c.tool)).toEqual(["twining_post", "twining_decide"]);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript: malformed input handling
// ---------------------------------------------------------------------------

describe("parseTranscript malformed input handling", () => {
  it("skips malformed JSON lines with warnings", () => {
    const jsonl = [
      "this is not JSON",
      assistantWithTools([{ name: "mcp__twining__twining_post" }]),
      "{incomplete",
    ].join("\n");
    const result = parseTranscript(jsonl);
    expect(result.sessionMeta.parseWarnings.length).toBeGreaterThanOrEqual(2);
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls).toHaveLength(1);
  });

  it("skips lines with missing/unexpected fields with warnings", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant" }), // missing message field
      JSON.stringify({ type: "assistant", message: { role: "assistant" } }), // missing content
      assistantWithTools([{ name: "mcp__twining__twining_post" }]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    // At least the valid line produces a call
    const allCalls = result.segments.flatMap((s) => s.calls);
    expect(allCalls).toHaveLength(1);
  });

  it("handles empty input", () => {
    const result = parseTranscript("");
    expect(result.segments).toEqual([]);
    expect(result.sessionMeta.parseWarnings).toHaveLength(0);
    expect(result.sessionMeta.totalLines).toBe(0);
    expect(result.sessionMeta.twinningCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript: workflow segmentation
// ---------------------------------------------------------------------------

describe("parseTranscript workflow segmentation", () => {
  it("splits at twining_assemble boundaries", () => {
    const jsonl = [
      assistantWithTools([{ name: "mcp__twining__twining_assemble_context", id: "a1" }]),
      assistantWithTools([{ name: "mcp__twining__twining_post", id: "p1" }]),
      assistantWithTools([{ name: "mcp__twining__twining_decide", id: "d1" }]),
      assistantWithTools([{ name: "mcp__twining__twining_assemble_context", id: "a2" }]),
      assistantWithTools([{ name: "mcp__twining__twining_post", id: "p2" }]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].calls).toHaveLength(3);
    expect(result.segments[1].calls).toHaveLength(2);
  });

  it("produces a single segment when no assemble calls", () => {
    const jsonl = [
      assistantWithTools([{ name: "mcp__twining__twining_post", id: "p1" }]),
      assistantWithTools([{ name: "mcp__twining__twining_decide", id: "d1" }]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseTranscript: session metadata
// ---------------------------------------------------------------------------

describe("parseTranscript session metadata", () => {
  it("returns totalLines, twinningCallCount, parseWarnings", () => {
    const jsonl = [
      assistantWithTools([
        { name: "mcp__twining__twining_post", id: "t1" },
        { name: "mcp__twining__twining_decide", id: "t2" },
      ]),
      JSON.stringify({ type: "progress", data: "something" }),
      "bad json",
    ].join("\n");
    const result = parseTranscript(jsonl);
    expect(result.sessionMeta.totalLines).toBe(3);
    expect(result.sessionMeta.twinningCallCount).toBe(2);
    expect(result.sessionMeta.parseWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts sessionId from first assistant message", () => {
    const jsonl = assistantWithTools(
      [{ name: "mcp__twining__twining_post" }],
      { sessionId: "test-session-42" },
    );
    const result = parseTranscript(jsonl);
    expect(result.sessionMeta.sessionId).toBe("test-session-42");
  });

  it("includes source and segment metadata in ScorerInput", () => {
    const jsonl = [
      assistantWithTools([{ name: "mcp__twining__twining_assemble_context", id: "a1" }]),
      assistantWithTools([{ name: "mcp__twining__twining_post", id: "p1" }]),
      assistantWithTools([{ name: "mcp__twining__twining_assemble_context", id: "a2" }]),
      assistantWithTools([{ name: "mcp__twining__twining_decide", id: "d1" }]),
    ].join("\n");
    const result = parseTranscript(jsonl);
    expect(result.segments[0].metadata).toMatchObject({
      source: "transcript",
      segmentIndex: 0,
    });
    expect(result.segments[1].metadata).toMatchObject({
      source: "transcript",
      segmentIndex: 1,
    });
  });
});
