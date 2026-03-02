/**
 * Transcript analyzer: parses Claude Code JSONL session logs into ScorerInput[].
 *
 * Extracts twining_* tool calls from assistant messages, pairs them with
 * tool_result blocks from user messages via tool_use_id, normalizes MCP
 * tool name prefixes, and segments into workflow chunks at twining_assemble
 * boundaries.
 *
 * Produces the same ScorerInput format used by synthetic scenarios, so
 * the same deterministic scorers can evaluate real transcripts.
 */
import { z } from "zod";
import type { NormalizedToolCall, ScorerInput } from "./scenario-schema.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParseResult {
  /** One ScorerInput per workflow segment. */
  segments: ScorerInput[];
  /** Session-level metadata. */
  sessionMeta: {
    sessionId: string;
    totalLines: number;
    twinningCallCount: number;
    parseWarnings: string[];
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ExtractedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
}

interface ExtractedToolResult {
  toolUseId: string;
  content: string | null;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas for JSONL line validation
// ---------------------------------------------------------------------------

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()).default({}),
});

const AssistantLineSchema = z.object({
  type: z.literal("assistant"),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(
      z.union([
        ToolUseBlockSchema,
        z.object({ type: z.string() }).passthrough(),
      ]),
    ),
  }),
});

const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z
    .union([
      z.string(),
      z.array(
        z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
      ),
    ])
    .optional()
    .nullable(),
  is_error: z.boolean().optional(),
});

const UserLineSchema = z.object({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          ToolResultBlockSchema,
          z.object({ type: z.string() }).passthrough(),
        ]),
      ),
    ]),
  }),
});

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize MCP-prefixed tool names to bare format.
 *
 * Known patterns:
 *   mcp__twining__twining_post -> twining_post
 *   mcp__plugin_twining_twining__twining_post -> twining_post
 *   twining_post -> twining_post (unchanged)
 */
export function normalizeMcpToolName(rawName: string): string {
  const parts = rawName.split("__");
  return parts[parts.length - 1] ?? rawName;
}

/**
 * Check whether a normalized tool name belongs to the Twining tool set.
 */
export function isTwiningTool(name: string): boolean {
  return name.startsWith("twining_");
}

// ---------------------------------------------------------------------------
// Content normalization
// ---------------------------------------------------------------------------

/**
 * Normalize tool_result content to string | null.
 *
 * Handles three observed formats:
 *   - string: return as-is
 *   - array of {type: "text", text: string}: join text values
 *   - undefined/null: return null
 */
function normalizeResultContent(
  content: string | { type: string; text?: string }[] | undefined | null,
): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((block): block is { type: string; text: string } => typeof block.text === "string")
      .map((block) => block.text);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workflow segmentation
// ---------------------------------------------------------------------------

/**
 * Split tool calls into workflow segments at twining_assemble boundaries.
 * An assemble call starts a new segment (unless it's the very first call).
 * If no assemble calls exist, the entire sequence is one segment.
 */
function segmentByWorkflow(
  calls: NormalizedToolCall[],
): { calls: NormalizedToolCall[]; startIndex: number }[] {
  if (calls.length === 0) return [];

  const segments: { calls: NormalizedToolCall[]; startIndex: number }[] = [];
  let current: NormalizedToolCall[] = [];
  let startIndex = 0;

  for (const call of calls) {
    if (call.tool.startsWith("twining_assemble") && current.length > 0) {
      segments.push({ calls: current, startIndex });
      current = [];
      startIndex = call.index;
    }
    current.push(call);
  }

  if (current.length > 0) {
    segments.push({ calls: current, startIndex });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a Claude Code JSONL session log into ScorerInput segments.
 *
 * Process:
 * 1. Parse each line as JSON (skip malformed with warning)
 * 2. Extract tool_use blocks from assistant messages
 * 3. Extract tool_result blocks from user messages
 * 4. Normalize MCP tool names, filter to twining_* only
 * 5. Pair tool calls with their results via tool_use_id
 * 6. Segment into workflows at twining_assemble boundaries
 * 7. Build ScorerInput per segment with metadata
 */
export function parseTranscript(jsonlContent: string): ParseResult {
  const warnings: string[] = [];
  let sessionId = "";

  // Handle empty input
  const rawLines = jsonlContent.split("\n").filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) {
    return {
      segments: [],
      sessionMeta: {
        sessionId: "",
        totalLines: 0,
        twinningCallCount: 0,
        parseWarnings: [],
      },
    };
  }

  const totalLines = rawLines.length;

  // Pass 1: Extract tool_use calls from assistant messages
  const toolCalls: ExtractedToolCall[] = [];
  // Pass 2: Extract tool_result from user messages
  const toolResults = new Map<string, ExtractedToolResult>();

  for (let i = 0; i < rawLines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLines[i]!);
    } catch {
      warnings.push(`Line ${i}: invalid JSON`);
      continue;
    }

    // Try to extract sessionId from first assistant message
    const anyObj = parsed as Record<string, unknown>;
    if (!sessionId && anyObj.sessionId && typeof anyObj.sessionId === "string") {
      sessionId = anyObj.sessionId;
    }

    // Skip non-object lines
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }

    const lineType = (parsed as { type?: string }).type;

    // Extract tool_use from assistant messages
    if (lineType === "assistant") {
      const assistantParse = AssistantLineSchema.safeParse(parsed);
      if (!assistantParse.success) {
        // Not a valid assistant message with content blocks -- skip silently
        // (could be missing message field, missing content, etc.)
        continue;
      }
      const data = assistantParse.data;
      for (const block of data.message.content) {
        if (block.type === "tool_use") {
          const tuParse = ToolUseBlockSchema.safeParse(block);
          if (tuParse.success) {
            toolCalls.push({
              id: tuParse.data.id,
              name: tuParse.data.name,
              input: tuParse.data.input,
              timestamp: data.timestamp,
            });
          }
        }
      }
    }

    // Extract tool_result from user messages
    if (lineType === "user") {
      const userParse = UserLineSchema.safeParse(parsed);
      if (!userParse.success) continue;
      const content = userParse.data.message.content;
      if (typeof content === "string") continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          const trParse = ToolResultBlockSchema.safeParse(block);
          if (trParse.success) {
            toolResults.set(trParse.data.tool_use_id, {
              toolUseId: trParse.data.tool_use_id,
              content: normalizeResultContent(trParse.data.content),
              isError: trParse.data.is_error ?? false,
            });
          }
        }
      }
    }
  }

  // Normalize names, filter to twining_*, assign indices, pair results
  let index = 0;
  const normalizedCalls: NormalizedToolCall[] = [];

  for (const tc of toolCalls) {
    const normalizedName = normalizeMcpToolName(tc.name);
    if (!isTwiningTool(normalizedName)) continue;

    const call: NormalizedToolCall = {
      tool: normalizedName,
      arguments: tc.input,
      index: index++,
    };

    // Pair with result if available
    const result = toolResults.get(tc.id);
    if (result) {
      call.result = { content: result.content, isError: result.isError };
    }

    normalizedCalls.push(call);
  }

  // Segment by workflow
  const rawSegments = segmentByWorkflow(normalizedCalls);

  // Build ScorerInput per segment
  const segments: ScorerInput[] = rawSegments.map((seg, segIndex) => ({
    calls: seg.calls,
    metadata: {
      source: "transcript",
      sessionId,
      segmentIndex: segIndex,
      startIndex: seg.startIndex,
      toolCount: seg.calls.length,
    },
  }));

  return {
    segments,
    sessionMeta: {
      sessionId,
      totalLines,
      twinningCallCount: normalizedCalls.length,
      parseWarnings: warnings,
    },
  };
}
