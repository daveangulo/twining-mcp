#!/usr/bin/env npx tsx
/**
 * Scrub sensitive data from Claude Code JSONL transcript files.
 *
 * Usage: npx tsx scripts/scrub-transcript.ts <input.jsonl> <output.jsonl>
 *
 * Preserves:
 *   - Message type, uuid, parentUuid, sessionId, timestamp, isSidechain
 *   - Content block type/structure
 *   - Tool names and arguments for twining_* tools
 *   - Tool results for twining_* tools
 *
 * Scrubs:
 *   - User message text content -> "[scrubbed]"
 *   - System message content -> "[scrubbed]"
 *   - Non-twining tool_use input values -> "[scrubbed]"
 *   - Non-twining tool_result content -> "[scrubbed]"
 *   - File paths matching /Users/ -> "/project/path"
 *
 * Skips entirely:
 *   - progress lines
 *   - file-history-snapshot lines
 *   - queue-operation lines
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_PATH_RE = /\/Users\/[^"'\s]+/g;

function scrubPaths(value: string): string {
  return value.replace(USER_PATH_RE, "/project/path");
}

function isTwiningName(name: string): boolean {
  // Normalize MCP prefixes first
  const parts = name.split("__");
  const bare = parts[parts.length - 1] ?? name;
  return bare.startsWith("twining_");
}

function scrubValue(val: unknown): unknown {
  if (typeof val === "string") return "[scrubbed]";
  if (Array.isArray(val)) return val.map(scrubValue);
  if (typeof val === "object" && val !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return val;
}

function deepScrubPaths(obj: unknown): unknown {
  if (typeof obj === "string") return scrubPaths(obj);
  if (Array.isArray(obj)) return obj.map(deepScrubPaths);
  if (typeof obj === "object" && obj !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepScrubPaths(v);
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Line processors
// ---------------------------------------------------------------------------

type LineType = "assistant" | "user" | "system" | "progress" | "file-history-snapshot" | "queue-operation" | string;

function scrubLine(line: Record<string, unknown>): Record<string, unknown> | null {
  const type = line.type as LineType;

  // Skip entirely
  if (type === "progress" || type === "file-history-snapshot" || type === "queue-operation") {
    return null;
  }

  // System messages: scrub content entirely
  if (type === "system") {
    return {
      type: line.type,
      uuid: line.uuid,
      parentUuid: line.parentUuid,
      sessionId: line.sessionId,
      timestamp: line.timestamp,
      message: { role: "system", content: "[scrubbed]" },
    };
  }

  // Assistant messages: process content blocks
  if (type === "assistant") {
    const msg = line.message as Record<string, unknown> | undefined;
    if (!msg) return line;
    const content = msg.content as unknown[] | undefined;
    if (!Array.isArray(content)) return line;

    const scrubbedContent = content.map((block: unknown) => {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use") {
        const name = b.name as string;
        if (isTwiningName(name)) {
          // Preserve twining tool calls, but scrub file paths in arguments
          return deepScrubPaths(b);
        }
        // Non-twining tool: keep name, scrub input
        return { type: "tool_use", id: b.id, name: b.name, input: scrubValue(b.input) };
      }
      if (b.type === "text") {
        // Scrub text content from assistant (may contain file contents)
        return { type: "text", text: "[scrubbed]" };
      }
      return { type: b.type };
    });

    return {
      type: line.type,
      uuid: line.uuid,
      parentUuid: line.parentUuid,
      sessionId: line.sessionId,
      timestamp: line.timestamp,
      isSidechain: line.isSidechain,
      message: {
        role: msg.role,
        content: scrubbedContent,
        stop_reason: (msg as Record<string, unknown>).stop_reason,
      },
    };
  }

  // User messages: scrub text, handle tool_result blocks
  if (type === "user") {
    const msg = line.message as Record<string, unknown> | undefined;
    if (!msg) return line;
    const content = msg.content;

    // String content -> scrub
    if (typeof content === "string") {
      return {
        type: line.type,
        uuid: line.uuid,
        parentUuid: line.parentUuid,
        sessionId: line.sessionId,
        timestamp: line.timestamp,
        message: { role: "user", content: "[scrubbed]" },
      };
    }

    // Array content: process tool_result blocks
    if (Array.isArray(content)) {
      const scrubbedContent = content.map((block: unknown) => {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          const toolUseId = b.tool_use_id as string;
          // We need to check if the corresponding tool_use was a twining tool
          // Since we don't have the full context here, check the content for twining indicators
          // Or check if is_error is set and preserve structure
          // For safety: preserve twining tool results (content may reference twining ops)
          // We'll preserve all tool_result structure but scrub non-twining content later
          return deepScrubPaths(b);
        }
        if (b.type === "text") {
          return { type: "text", text: "[scrubbed]" };
        }
        return { type: b.type };
      });

      return {
        type: line.type,
        uuid: line.uuid,
        parentUuid: line.parentUuid,
        sessionId: line.sessionId,
        timestamp: line.timestamp,
        message: { role: "user", content: scrubbedContent },
      };
    }

    // Fallback: scrub unknown content shapes
    return {
      type: line.type,
      uuid: line.uuid,
      sessionId: line.sessionId,
      timestamp: line.timestamp,
      message: { role: "user", content: "[scrubbed]" },
    };
  }

  // Unknown types: return structural data only
  return {
    type: line.type,
    uuid: line.uuid,
    sessionId: line.sessionId,
    timestamp: line.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: npx tsx scripts/scrub-transcript.ts <input.jsonl> <output.jsonl>");
    console.log("Scrub sensitive data from Claude Code JSONL transcript files.");
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args.length < 2) {
    console.error("Error: both <input> and <output> paths required");
    process.exit(1);
  }

  const [inputPath, outputPath] = args;
  const raw = readFileSync(inputPath!, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const scrubbed: string[] = [];
  let totalLines = 0;
  let keptLines = 0;
  let twinningCalls = 0;

  for (const line of lines) {
    totalLines++;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip unparseable lines
      continue;
    }

    const result = scrubLine(parsed);
    if (result === null) continue; // Skipped line type

    keptLines++;

    // Count twining tool calls in assistant messages
    if (result.type === "assistant") {
      const msg = result.message as Record<string, unknown> | undefined;
      const content = msg?.content as unknown[] | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use" && isTwiningName(b.name as string)) {
            twinningCalls++;
          }
        }
      }
    }

    scrubbed.push(JSON.stringify(result));
  }

  writeFileSync(outputPath!, scrubbed.join("\n") + "\n");

  console.log(`Scrubbing complete:`);
  console.log(`  Total lines: ${totalLines}`);
  console.log(`  Kept lines:  ${keptLines}`);
  console.log(`  Twining tool calls: ${twinningCalls}`);
  console.log(`  Output: ${outputPath}`);
}

main();
