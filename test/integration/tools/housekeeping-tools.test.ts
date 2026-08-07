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

    // Record a decision against a path that exists, and one against a path
    // that doesn't. Since D3, a lone scope_path_missing signal (0.8) cannot
    // cross the 0.95 threshold — the doomed decision also names missing
    // affected_files so corroborated signals flag it (noisy-or ≈ 0.99).
    await callTool(server, "twining_record", {
      summary: "Initial work in src/kept",
      decisions: [{ summary: "Chose A over B for kept code", rationale: "kept reasoning" }],
      scope: "src/kept/",
    });
    await callTool(server, "twining_record", {
      summary: "Work in src/gone (which we'll delete)",
      decisions: [{ summary: "Chose C over D for gone code", rationale: "doomed reasoning" }],
      scope: "src/gone/",
      affected_files: ["src/gone/a.ts", "src/gone/b.ts"],
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

describe("twining_housekeeping with merge_sweep", () => {
  it("first call records the branch snapshot and returns initial_record=true", async () => {
    gitInit(tmpDir);
    execFileSync("git", ["branch", "feature/x"], { cwd: tmpDir });
    server = createTestServer(tmpDir);

    const res = await callTool(server, "twining_housekeeping", {
      merge_sweep: true,
      execute: true,
    });
    const parsed = parseToolResponse(res) as {
      merge_sweep?: {
        initial_record: boolean;
        enumerated: boolean;
        current_branches: string[];
        deleted_branches: string[];
        candidates: unknown[];
      };
    };
    expect(parsed.merge_sweep).toBeDefined();
    expect(parsed.merge_sweep!.initial_record).toBe(true);
    expect(parsed.merge_sweep!.enumerated).toBe(true);
    expect(parsed.merge_sweep!.current_branches).toContain("feature/x");
    expect(parsed.merge_sweep!.candidates).toEqual([]);
  });

  it("flags entries from a branch deleted between two housekeeping runs", async () => {
    gitInit(tmpDir);
    execFileSync("git", ["branch", "feature/short-lived"], { cwd: tmpDir });
    execFileSync("git", ["checkout", "-q", "feature/short-lived"], { cwd: tmpDir });
    server = createTestServer(tmpDir);

    // Record a decision while we're on the short-lived branch.
    const recordRes = await callTool(server, "twining_record", {
      summary: "Spike on short-lived branch",
      decisions: [{ summary: "Tried approach X for the spike", rationale: "spike-only" }],
      scope: "project",
    });
    const recorded = parseToolResponse(recordRes) as {
      decisions_created: Array<{ id: string }>;
    };
    const decisionId = recorded.decisions_created[0]!.id;

    // First housekeeping pass — execute=true advances the baseline.
    await callTool(server, "twining_housekeeping", {
      merge_sweep: true,
      execute: true,
    });

    // Switch back to main and delete the spike branch.
    execFileSync("git", ["checkout", "-q", "main"], { cwd: tmpDir });
    execFileSync("git", ["branch", "-D", "feature/short-lived"], { cwd: tmpDir });

    // Second housekeeping pass — feature/short-lived is gone now.
    const sweepRes = await callTool(server, "twining_housekeeping", {
      merge_sweep: true,
    });
    const sweep = parseToolResponse(sweepRes) as {
      merge_sweep?: {
        initial_record: boolean;
        deleted_branches: string[];
        candidates: Array<{ id: string; branch: string; kind: string }>;
      };
    };

    expect(sweep.merge_sweep!.initial_record).toBe(false);
    expect(sweep.merge_sweep!.deleted_branches).toContain("feature/short-lived");
    const cand = sweep.merge_sweep!.candidates.find((c) => c.id === decisionId);
    expect(cand).toBeDefined();
    expect(cand!.branch).toBe("feature/short-lived");
    expect(cand!.kind).toBe("decision");
  });

  it("preview-mode (execute=false) does NOT advance the baseline — deletions persist across previews", async () => {
    // Regression for the dry-run silently advances bug. If a preview pass
    // were to consume the deletion, sweep2 below would return [].
    gitInit(tmpDir);
    execFileSync("git", ["branch", "feature/preview-target"], { cwd: tmpDir });
    server = createTestServer(tmpDir);

    // Seed baseline (execute=true).
    await callTool(server, "twining_housekeeping", {
      merge_sweep: true,
      execute: true,
    });

    execFileSync("git", ["branch", "-D", "feature/preview-target"], {
      cwd: tmpDir,
    });

    const sweep1 = parseToolResponse(
      await callTool(server, "twining_housekeeping", { merge_sweep: true }),
    ) as { merge_sweep: { deleted_branches: string[] } };
    expect(sweep1.merge_sweep.deleted_branches).toContain("feature/preview-target");

    // Second preview must still see the same deletion (not consumed).
    const sweep2 = parseToolResponse(
      await callTool(server, "twining_housekeeping", { merge_sweep: true }),
    ) as { merge_sweep: { deleted_branches: string[] } };
    expect(sweep2.merge_sweep.deleted_branches).toContain("feature/preview-target");
  });

  it("returns enumerated=false in a non-git project and does not flag anything", async () => {
    // No gitInit — tmpDir is not a git repo.
    server = createTestServer(tmpDir);
    const res = await callTool(server, "twining_housekeeping", { merge_sweep: true });
    const parsed = parseToolResponse(res) as {
      merge_sweep?: { enumerated: boolean; deleted_branches: string[]; candidates: unknown[] };
    };
    expect(parsed.merge_sweep!.enumerated).toBe(false);
    expect(parsed.merge_sweep!.deleted_branches).toEqual([]);
    expect(parsed.merge_sweep!.candidates).toEqual([]);
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

  it("records per-item reasons in the audit-trail finding (#16)", async () => {
    gitInit(tmpDir);
    fs.mkdirSync(path.join(tmpDir, "src", "kept"), { recursive: true });
    server = createTestServer(tmpDir);

    const recordRes = await callTool(server, "twining_record", {
      summary: "Some work",
      findings: ["Wave 3 review action items", "JWT auth flow notes"],
      scope: "src/kept/",
    });
    const recordParsed = parseToolResponse(recordRes) as {
      findings_created: Array<{ id: string }>;
    };
    const [staleId, otherId] = recordParsed.findings_created.map((f) => f.id);

    await callTool(server, "twining_archive_stale", {
      ids: [staleId!, otherId!],
      reason: "semantic review pass",
      reasons: {
        [staleId!]: "References closed Wave 3 sprint — concept no longer exists",
        [otherId!]: "Stale per model score 0.9",
      },
    });

    // The audit-trail finding carries each item's reason text.
    const readRes = await callTool(server, "twining_read", {
      entry_types: ["finding"],
    });
    const readParsed = parseToolResponse(readRes) as {
      entries: Array<{ summary: string; detail: string }>;
    };
    const audit = readParsed.entries.find((e) =>
      e.summary.includes("stale items"),
    );
    expect(audit).toBeTruthy();
    expect(audit!.detail).toContain(staleId!);
    expect(audit!.detail).toContain(
      "References closed Wave 3 sprint — concept no longer exists",
    );
    expect(audit!.detail).toContain("Stale per model score 0.9");
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

describe("twining_unarchive + archive visibility (D3 recovery)", () => {
  it("restores archived decisions to active and posts an audit finding", async () => {
    gitInit(tmpDir);
    server = createTestServer(tmpDir);

    const rec = parseToolResponse(
      await callTool(server, "twining_record", {
        summary: "Decision that will be wrongly archived",
        decisions: [{ summary: "Chose X over Y for the doomed area", rationale: "solid reasoning" }],
        scope: "src/doomed/",
      }),
    ) as { decisions_created: Array<{ id: string }> };
    const decisionId = rec.decisions_created[0]!.id;

    await callTool(server, "twining_archive_stale", { ids: [decisionId] });

    const restored = parseToolResponse(
      await callTool(server, "twining_unarchive", {
        ids: [decisionId, "missing-id"],
        reason: "false positive from compound-scope bug",
      }),
    ) as { restored: string[]; not_archived: string[]; not_found: string[] };
    expect(restored.restored).toEqual([decisionId]);
    expect(restored.not_found).toEqual(["missing-id"]);

    // Restored decision is authoritative again in why().
    const why = parseToolResponse(
      await callTool(server, "twining_why", { scope: "src/doomed/" }),
    ) as { decisions: Array<{ id: string; status: string }> };
    const match = why.decisions.find((d) => d.id === decisionId);
    expect(match).toBeDefined();
    expect(match!.status).toBe("active");

    // Re-unarchiving reports not_archived, not an error.
    const again = parseToolResponse(
      await callTool(server, "twining_unarchive", { ids: [decisionId] }),
    ) as { restored: string[]; not_archived: string[] };
    expect(again.restored).toEqual([]);
    expect(again.not_archived).toEqual([decisionId]);
  });

  it("assemble and why report archived decisions as archived_excluded_count instead of silence", async () => {
    gitInit(tmpDir);
    server = createTestServer(tmpDir);

    const rec = parseToolResponse(
      await callTool(server, "twining_record", {
        summary: "Only decision in this scope",
        decisions: [{ summary: "Chose M over N in the blinded area", rationale: "reasoning" }],
        scope: "src/blinded/",
      }),
    ) as { decisions_created: Array<{ id: string }> };
    await callTool(server, "twining_archive_stale", {
      ids: [rec.decisions_created[0]!.id],
    });

    const why = parseToolResponse(
      await callTool(server, "twining_why", { scope: "src/blinded/" }),
    ) as { decisions: unknown[]; archived_excluded_count?: number };
    expect(why.decisions).toEqual([]);
    expect(why.archived_excluded_count).toBe(1);

    const assemble = parseToolResponse(
      await callTool(server, "twining_assemble", {
        task: "verify the blinded gate says so",
        scope: "src/blinded/",
      }),
    ) as { briefing: string; archived_excluded_count?: number };
    expect(assemble.archived_excluded_count).toBe(1);
    expect(assemble.briefing).toContain("archived decision(s) in this scope are excluded");
  });

  it("archive_stale warns on batches above max(20, 5% of live decisions)", async () => {
    gitInit(tmpDir);
    server = createTestServer(tmpDir);

    // 21 bogus blackboard-side IDs — above the floor of 20; all not_found,
    // the warning keys on requested batch size, not archive success.
    const ids = Array.from({ length: 21 }, (_, i) => `bogus-${i}`);
    const parsed = parseToolResponse(
      await callTool(server, "twining_archive_stale", { ids }),
    ) as { warning?: string };
    expect(parsed.warning).toBeDefined();
    expect(parsed.warning).toContain("heuristics");

    const small = parseToolResponse(
      await callTool(server, "twining_archive_stale", { ids: ["one-id"] }),
    ) as { warning?: string };
    expect(small.warning).toBeUndefined();
  });
});

describe("archive_stale blackboard tombstones + status archivable count (review fixes)", () => {
  it("archive_stale writes a dismissal tombstone for blackboard entries (they are deleted, not status-flipped)", async () => {
    gitInit(tmpDir);
    server = createTestServer(tmpDir);

    const posted = parseToolResponse(
      await callTool(server, "twining_post", {
        entry_type: "finding",
        summary: "stale finding to be archived",
        scope: "src/",
      }),
    ) as { id: string };

    await callTool(server, "twining_archive_stale", {
      ids: [posted.id],
      reason: "flagged by staleness review",
    });

    const archiveDir = path.join(tmpDir, ".twining", "archive");
    const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
    expect(files.length).toBe(1);
    const lines = fs
      .readFileSync(path.join(archiveDir, files[0]!), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const tomb = lines.find((l) => l.id === posted.id);
    expect(tomb).toBeDefined();
    expect(tomb.summary).toBe("stale finding to be archived");
    expect(tomb.dismissed.reason).toBe("flagged by staleness review");
    expect(tomb.dismissed.dismissed_by).toBe("archive_stale");
  });

  it("twining_status computes needs_archiving from the archive partition, not the raw count", async () => {
    gitInit(tmpDir);

    // Seed BEFORE creating the server (auto-backend resolves at startup;
    // legacy jsonl content pins the files backend). 6 OPEN needs against a
    // threshold of 5 — the raw count exceeds it, but every entry is exempt
    // from archiving, so recommending an archive would be a permanent false
    // positive steering agents into pointless sweeps.
    const twiningDir = path.join(tmpDir, ".twining");
    fs.appendFileSync(
      path.join(twiningDir, "config.yml"),
      "archive:\n  max_blackboard_entries_before_archive: 5\n",
    );
    const lines = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        id: `need-${String(i).padStart(4, "0")}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        agent_id: "main",
        entry_type: "need",
        tags: [],
        scope: "src/",
        summary: `open need ${i}`,
        detail: "",
      }),
    );
    fs.appendFileSync(
      path.join(twiningDir, "blackboard.jsonl"),
      lines.join("\n") + "\n",
    );
    server = createTestServer(tmpDir);

    const status = parseToolResponse(
      await callTool(server, "twining_status", {}),
    ) as { blackboard_entries: number; needs_archiving: boolean; warnings: string[] };
    expect(status.blackboard_entries).toBeGreaterThanOrEqual(6);
    expect(status.needs_archiving).toBe(false);
    expect(status.warnings.join(" ")).not.toContain("archive recommended");
  });
});
