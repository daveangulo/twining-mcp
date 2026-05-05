/**
 * Integration tests for the housekeeping tool surface — twining_housekeeping
 * with staleness_review, and twining_archive_stale.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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

function gitInit(dir: string, branch = "main"): void {
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@x"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: dir });
}

beforeEach(() => {
  tmpDir = createTmpProjectDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("twining_housekeeping with staleness_review", () => {
  it("flags decisions whose scope path no longer exists", async () => {
    gitInit(tmpDir);
    fs.mkdirSync(path.join(tmpDir, "src", "kept"), { recursive: true });
    server = createTestServer(tmpDir);

    // Record a decision against a path that exists, and one against a path that doesn't.
    await callTool(server, "twining_record", {
      summary: "Initial work in src/kept",
      decisions: [{ summary: "Chose A over B for kept code", rationale: "kept reasoning" }],
      scope: "src/kept/",
    });
    await callTool(server, "twining_record", {
      summary: "Work in src/gone (which we'll delete)",
      decisions: [{ summary: "Chose C over D for gone code", rationale: "doomed reasoning" }],
      scope: "src/gone/",
    });

    const res = await callTool(server, "twining_housekeeping", { staleness_review: true });
    const parsed = parseToolResponse(res) as {
      staleness_review?: { threshold: number; candidates: Array<{ summary: string; scope: string; reasons: Array<{ signal: string }> }> };
    };

    expect(parsed.staleness_review).toBeDefined();
    expect(parsed.staleness_review!.candidates.length).toBeGreaterThanOrEqual(1);
    const goneCandidate = parsed.staleness_review!.candidates.find((c) =>
      c.scope === "src/gone/",
    );
    expect(goneCandidate).toBeDefined();
    expect(goneCandidate!.reasons.some((r) => r.signal === "scope_path_missing")).toBe(true);
  });

  it("does not return staleness_review when not requested", async () => {
    gitInit(tmpDir);
    server = createTestServer(tmpDir);
    const res = await callTool(server, "twining_housekeeping", {});
    const parsed = parseToolResponse(res) as { staleness_review?: unknown };
    expect(parsed.staleness_review).toBeUndefined();
  });
});

describe("twining_archive_stale", () => {
  it("archives a decision (status -> archived) and a blackboard entry by ID", async () => {
    gitInit(tmpDir);
    fs.mkdirSync(path.join(tmpDir, "src", "kept"), { recursive: true });
    server = createTestServer(tmpDir);

    // Create one decision and one finding.
    const recordRes = await callTool(server, "twining_record", {
      summary: "Some work",
      decisions: [{ summary: "Test decision for archival", rationale: "x" }],
      findings: ["A finding to archive"],
      scope: "src/kept/",
    });
    const recordParsed = parseToolResponse(recordRes) as {
      decisions_created: Array<{ id: string }>;
      findings_created: Array<{ id: string }>;
    };
    const decisionId = recordParsed.decisions_created[0]!.id;
    const findingId = recordParsed.findings_created[0]!.id;

    const archiveRes = await callTool(server, "twining_archive_stale", {
      ids: [decisionId, findingId],
      reason: "test cleanup",
    });
    const archiveParsed = parseToolResponse(archiveRes) as {
      archived_decisions: string[];
      archived_entries: string[];
      not_found: string[];
      total_archived: number;
    };

    expect(archiveParsed.archived_decisions).toContain(decisionId);
    expect(archiveParsed.archived_entries).toContain(findingId);
    expect(archiveParsed.not_found).toEqual([]);
    expect(archiveParsed.total_archived).toBe(2);
  });

  it("returns not_found for unknown IDs without throwing", async () => {
    gitInit(tmpDir);
    server = createTestServer(tmpDir);
    const res = await callTool(server, "twining_archive_stale", {
      ids: ["does-not-exist-1", "does-not-exist-2"],
    });
    const parsed = parseToolResponse(res) as {
      archived_decisions: string[];
      archived_entries: string[];
      not_found: string[];
      total_archived: number;
    };
    expect(parsed.archived_decisions).toEqual([]);
    expect(parsed.not_found.length).toBe(2);
    expect(parsed.total_archived).toBe(0);
  });
});
