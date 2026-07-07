/**
 * Integration tests for the archive-compaction housekeeping pass (#35) —
 * twining_housekeeping with compact_archives: true.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createTmpProjectDir,
  createTestServer,
  callTool,
  parseToolResponse,
} from "../helpers.js";

let tmpDir: string;
let server: McpServer;

interface CompactionShape {
  archive_compaction?: {
    files: Array<{
      file: string;
      junk_count: number;
      survivor_count: number;
      bytes_reclaimable: number;
      deleted: boolean;
    }>;
    total_junk: number;
    total_survivors: number;
    total_bytes_reclaimable: number;
    files_deleted: number;
  };
  dry_run: boolean;
  summary: string;
}

function junkLine(): string {
  return JSON.stringify({
    id: `01JUNK${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    agent_id: "main",
    entry_type: "finding",
    tags: ["archive"],
    scope: "project",
    summary: "Archive: 1 entries archived",
    detail:
      "Archive summary: 1 entries archived. finding: 1 entries (Archive: 1 entries archived).",
  });
}

function legitLine(summary: string): string {
  return JSON.stringify({
    id: `01LEGIT${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    agent_id: "main",
    entry_type: "finding",
    tags: [],
    scope: "src/auth/",
    summary,
    detail: "real finding",
  });
}

function seedArchive(name: string, lines: string[]): string {
  const archiveDir = path.join(tmpDir, ".twining", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const file = path.join(archiveDir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

beforeEach(() => {
  tmpDir = createTmpProjectDir();
  server = createTestServer(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_housekeeping with compact_archives", () => {
  it("is not run unless requested", async () => {
    seedArchive("2025-11-01-blackboard.jsonl", [junkLine()]);
    const res = await callTool(server, "twining_housekeeping", {});
    const parsed = parseToolResponse(res) as CompactionShape;
    expect(parsed.archive_compaction).toBeUndefined();
  });

  it("previews junk counts by default without mutating archive files", async () => {
    const file = seedArchive("2025-11-01-blackboard.jsonl", [
      junkLine(),
      legitLine("real archived finding"),
      junkLine(),
    ]);
    const before = fs.readFileSync(file, "utf-8");

    const res = await callTool(server, "twining_housekeeping", {
      compact_archives: true,
    });
    const parsed = parseToolResponse(res) as CompactionShape;

    expect(parsed.dry_run).toBe(true);
    expect(parsed.archive_compaction).toBeDefined();
    expect(parsed.archive_compaction!.total_junk).toBe(2);
    expect(parsed.archive_compaction!.total_survivors).toBe(1);
    expect(parsed.archive_compaction!.files_deleted).toBe(0);
    expect(parsed.summary).toContain("[preview]");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("compacts on execute, deletes emptied files, and posts an audit-trail finding", async () => {
    const mixed = seedArchive("2025-11-01-blackboard.jsonl", [
      junkLine(),
      legitLine("survivor finding"),
    ]);
    const allJunk = seedArchive("2025-11-02-blackboard.jsonl", [
      junkLine(),
      junkLine(),
    ]);

    const res = await callTool(server, "twining_housekeeping", {
      compact_archives: true,
      execute: true,
    });
    const parsed = parseToolResponse(res) as CompactionShape;

    expect(parsed.archive_compaction!.total_junk).toBe(3);
    expect(parsed.archive_compaction!.total_survivors).toBe(1);
    expect(parsed.archive_compaction!.files_deleted).toBe(1);

    // Mixed file keeps only the survivor; all-junk file is gone.
    const remaining = fs.readFileSync(mixed, "utf-8");
    expect(remaining).toContain("survivor finding");
    expect(remaining).not.toContain("Archive: 1 entries archived");
    expect(fs.existsSync(allJunk)).toBe(false);

    // Audit trail posted to the blackboard (mirrors twining_archive_stale).
    // Read through the tool surface — backend-agnostic (fresh test projects
    // resolve to the sqlite backend, so blackboard.jsonl stays empty).
    const readRes = await callTool(server, "twining_read", {
      tags: ["archive-compaction"],
    });
    const entries = (
      parseToolResponse(readRes) as {
        entries: Array<{ entry_type: string; summary: string; tags: string[] }>;
      }
    ).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("finding");
    expect(entries[0]!.summary).toContain("3");
  });

  it("does not post an audit finding on preview or when nothing was dropped", async () => {
    seedArchive("2025-11-01-blackboard.jsonl", [legitLine("only real entries")]);

    await callTool(server, "twining_housekeeping", { compact_archives: true });
    await callTool(server, "twining_housekeeping", {
      compact_archives: true,
      execute: true,
    });

    const readRes = await callTool(server, "twining_read", {
      tags: ["archive-compaction"],
    });
    const entries = (parseToolResponse(readRes) as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(0);
  });
});
