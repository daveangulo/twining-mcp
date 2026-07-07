/**
 * Tests for the archive compactor — the #35 repair pass for repos damaged
 * by the pre-1.24.0 auto-archive feedback loop.
 *
 * The junk signature matched here was verified stable across the full
 * history of src/engine/archiver.ts (commits 1135323 → dfd6add/1.24.0):
 *   entry_type "finding", summary `Archive: ${n} entries archived`,
 *   tags ["archive"], scope "project", agent_id "main" (engine default,
 *   archiver never overrides), detail starting
 *   `Archive summary: ${n} entries archived.`
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isArchiverLoopJunk,
  compactArchives,
  type ArchiveCompactionReport,
} from "../src/engine/archive-compactor.js";

let tmpDir: string;
let twiningDir: string;
let archiveDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-compactor-test-"));
  twiningDir = path.join(tmpDir, ".twining");
  archiveDir = path.join(twiningDir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;

/** A loop-generated archiver summary entry, as archived to disk. */
function junkEntry(n = 1): Record<string, unknown> {
  seq++;
  return {
    id: `01JUNK${String(seq).padStart(20, "0")}`,
    timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
    agent_id: "main",
    entry_type: "finding",
    tags: ["archive"],
    scope: "project",
    summary: `Archive: ${n} entries archived`,
    detail: `Archive summary: ${n} entries archived. finding: ${n} entries (Archive: 1 entries archived).`,
  };
}

/** A legitimate archived entry — must always survive compaction. */
function legitEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  seq++;
  return {
    id: `01LEGIT${String(seq).padStart(19, "0")}`,
    timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
    agent_id: "main",
    entry_type: "finding",
    tags: [],
    scope: "src/auth/",
    summary: "Auth tokens stored in localStorage — fails SOC2",
    detail: "Found while reviewing session handling.",
    ...overrides,
  };
}

function writeArchiveFile(name: string, lines: string[]): string {
  const file = path.join(archiveDir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("isArchiverLoopJunk", () => {
  it("matches the archiver's loop summary entries at any count", () => {
    expect(isArchiverLoopJunk(JSON.stringify(junkEntry(1)))).toBe(true);
    expect(isArchiverLoopJunk(JSON.stringify(junkEntry(42)))).toBe(true);
    expect(isArchiverLoopJunk(JSON.stringify(junkEntry(7596560)))).toBe(true);
  });

  it("preserves ordinary archived findings", () => {
    expect(isArchiverLoopJunk(JSON.stringify(legitEntry()))).toBe(false);
  });

  it("preserves entries whose summary merely resembles the archiver's", () => {
    // Trailing text after the signature
    expect(
      isArchiverLoopJunk(
        JSON.stringify(legitEntry({ summary: "Archive: 3 entries archived today" })),
      ),
    ).toBe(false);
    // Leading text before the signature
    expect(
      isArchiverLoopJunk(
        JSON.stringify(legitEntry({ summary: "Note: Archive: 3 entries archived" })),
      ),
    ).toBe(false);
  });

  it("requires every field of the archiver signature (when in doubt, exclude)", () => {
    const junk = junkEntry(2);
    // Wrong entry_type
    expect(
      isArchiverLoopJunk(JSON.stringify({ ...junk, entry_type: "status" })),
    ).toBe(false);
    // Missing the "archive" tag
    expect(isArchiverLoopJunk(JSON.stringify({ ...junk, tags: [] }))).toBe(false);
    expect(
      isArchiverLoopJunk(JSON.stringify({ ...junk, tags: ["housekeeping"] })),
    ).toBe(false);
    // Wrong scope — the archiver always posted scope "project"
    expect(
      isArchiverLoopJunk(JSON.stringify({ ...junk, scope: "src/engine/" })),
    ).toBe(false);
    // Wrong agent — the archiver's post always carried the "main" default
    expect(
      isArchiverLoopJunk(JSON.stringify({ ...junk, agent_id: "helper-bot" })),
    ).toBe(false);
    // Detail not produced by buildSummary
    expect(
      isArchiverLoopJunk(
        JSON.stringify({ ...junk, detail: "hand-written note about archiving" }),
      ),
    ).toBe(false);
  });

  it("never treats corrupt or non-object lines as junk", () => {
    expect(isArchiverLoopJunk("{not json")).toBe(false);
    expect(isArchiverLoopJunk("")).toBe(false);
    expect(isArchiverLoopJunk('"Archive: 1 entries archived"')).toBe(false);
    expect(isArchiverLoopJunk("null")).toBe(false);
  });
});

describe("compactArchives — preview (default)", () => {
  it("reports per-file and total junk/survivor counts and reclaimable bytes without writing", async () => {
    const junk1 = JSON.stringify(junkEntry(1));
    const junk2 = JSON.stringify(junkEntry(1));
    const legit = JSON.stringify(legitEntry());
    const fileA = writeArchiveFile("2025-11-01-blackboard.jsonl", [junk1, legit, junk2]);
    const fileB = writeArchiveFile("2025-11-02-blackboard.jsonl", [
      JSON.stringify(legitEntry()),
    ]);
    const beforeA = fs.readFileSync(fileA, "utf-8");
    const beforeB = fs.readFileSync(fileB, "utf-8");

    const report = await compactArchives(twiningDir);

    expect(report.files).toHaveLength(2);
    const a = report.files.find((f) => f.file === fileA)!;
    expect(a.junk_count).toBe(2);
    expect(a.survivor_count).toBe(1);
    expect(a.bytes_reclaimable).toBe(
      Buffer.byteLength(junk1) + 1 + Buffer.byteLength(junk2) + 1,
    );
    expect(a.deleted).toBe(false);
    const b = report.files.find((f) => f.file === fileB)!;
    expect(b.junk_count).toBe(0);
    expect(b.survivor_count).toBe(1);

    expect(report.total_junk).toBe(2);
    expect(report.total_survivors).toBe(2);
    expect(report.total_bytes_reclaimable).toBe(a.bytes_reclaimable);
    expect(report.files_deleted).toBe(0);

    // Preview must not mutate anything
    expect(fs.readFileSync(fileA, "utf-8")).toBe(beforeA);
    expect(fs.readFileSync(fileB, "utf-8")).toBe(beforeB);
    expect(fs.readdirSync(archiveDir).sort()).toEqual([
      "2025-11-01-blackboard.jsonl",
      "2025-11-02-blackboard.jsonl",
    ]);
  });

  it("counts corrupt lines as survivors", async () => {
    writeArchiveFile("2025-11-03-blackboard.jsonl", [
      JSON.stringify(junkEntry(1)),
      "{corrupt line",
      JSON.stringify(legitEntry()),
    ]);
    const report = await compactArchives(twiningDir);
    expect(report.total_junk).toBe(1);
    expect(report.total_survivors).toBe(2);
  });

  it("returns an empty report when the archive directory does not exist", async () => {
    fs.rmSync(archiveDir, { recursive: true });
    const report = await compactArchives(twiningDir);
    expect(report.files).toEqual([]);
    expect(report.total_junk).toBe(0);
    expect(report.total_survivors).toBe(0);
    expect(report.files_deleted).toBe(0);
  });

  it("ignores non-jsonl files and subdirectories", async () => {
    fs.writeFileSync(path.join(archiveDir, "notes.txt"), "not an archive\n");
    fs.mkdirSync(path.join(archiveDir, "sub.jsonl")); // directory with .jsonl name
    writeArchiveFile("2025-11-04-blackboard.jsonl", [JSON.stringify(junkEntry(1))]);

    const report = await compactArchives(twiningDir);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]!.file.endsWith("2025-11-04-blackboard.jsonl")).toBe(true);
  });

  it("scans any .jsonl file in archive/, regardless of naming scheme", async () => {
    // Defensive: archive/ layout is backend-agnostic and other writers may
    // have used different names — the junk signature, not the filename,
    // gates what is dropped.
    writeArchiveFile("legacy-archive.jsonl", [
      JSON.stringify(junkEntry(1)),
      JSON.stringify(legitEntry()),
    ]);
    const report = await compactArchives(twiningDir);
    expect(report.total_junk).toBe(1);
    expect(report.total_survivors).toBe(1);
  });
});

describe("compactArchives — execute", () => {
  it("drops junk, preserves survivors (including corrupt lines) verbatim and in order", async () => {
    const legit1 = JSON.stringify(legitEntry());
    const corrupt = '{"id": "truncated-write';
    const legit2 = JSON.stringify(legitEntry({ entry_type: "warning" }));
    const file = writeArchiveFile("2025-11-05-blackboard.jsonl", [
      JSON.stringify(junkEntry(1)),
      legit1,
      corrupt,
      JSON.stringify(junkEntry(3)),
      legit2,
    ]);

    const report = await compactArchives(twiningDir, { execute: true });

    expect(report.total_junk).toBe(2);
    expect(report.total_survivors).toBe(3);
    expect(fs.readFileSync(file, "utf-8")).toBe(
      [legit1, corrupt, legit2].join("\n") + "\n",
    );
    // No temp files left behind
    expect(fs.readdirSync(archiveDir)).toEqual(["2025-11-05-blackboard.jsonl"]);
  });

  it("deletes archive files that end up empty", async () => {
    const file = writeArchiveFile("2025-11-06-blackboard.jsonl", [
      JSON.stringify(junkEntry(1)),
      JSON.stringify(junkEntry(1)),
    ]);
    const kept = writeArchiveFile("2025-11-07-blackboard.jsonl", [
      JSON.stringify(legitEntry()),
    ]);

    const report = await compactArchives(twiningDir, { execute: true });

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(report.files_deleted).toBe(1);
    const deleted = report.files.find((f) => f.file === file)!;
    expect(deleted.deleted).toBe(true);
    expect(deleted.survivor_count).toBe(0);
  });

  it("leaves files with no junk completely untouched", async () => {
    const legit = JSON.stringify(legitEntry());
    const file = writeArchiveFile("2025-11-08-blackboard.jsonl", [legit]);
    const statBefore = fs.statSync(file);

    const report = await compactArchives(twiningDir, { execute: true });

    expect(report.total_junk).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toBe(legit + "\n");
    // Same inode — the file was not rewritten
    expect(fs.statSync(file).ino).toBe(statBefore.ino);
    expect(fs.readdirSync(archiveDir)).toEqual(["2025-11-08-blackboard.jsonl"]);
  });

  it("does not delete files that were already empty (nothing provably junk)", async () => {
    const file = path.join(archiveDir, "2025-11-09-blackboard.jsonl");
    fs.writeFileSync(file, "");
    const report = await compactArchives(twiningDir, { execute: true });
    expect(fs.existsSync(file)).toBe(true);
    expect(report.files_deleted).toBe(0);
  });
});

describe("compactArchives — streaming at scale", () => {
  it(
    "compacts a ~100MB / 100k-line file with bounded memory",
    { timeout: 120_000 },
    async () => {
      // Generate the file by streaming so the test itself stays bounded.
      // Each junk line carries a ~1KB detail, mirroring real loop output
      // (grouped buildSummary text). 100k lines ≈ 100MB+.
      const file = path.join(archiveDir, "2025-11-10-blackboard.jsonl");
      const survivors: string[] = [];
      const ws = fs.createWriteStream(file);
      const pad = "x".repeat(1024);
      const writeLine = (line: string) =>
        new Promise<void>((resolve) => {
          if (ws.write(line + "\n")) resolve();
          else ws.once("drain", () => resolve());
        });
      let junkWritten = 0;
      for (let i = 0; i < 100_000; i++) {
        if (i % 1000 === 500) {
          const s = JSON.stringify(legitEntry({ detail: `survivor ${i}` }));
          survivors.push(s);
          await writeLine(s);
        } else if (i % 10_000 === 9999) {
          const c = `{"corrupt": ${i}`; // unparseable, must survive
          survivors.push(c);
          await writeLine(c);
        } else {
          const j = junkEntry(1);
          j.detail = `Archive summary: 1 entries archived. finding: 1 entries (Archive: 1 entries archived). ${pad}`;
          await writeLine(JSON.stringify(j));
          junkWritten++;
        }
      }
      await new Promise<void>((resolve, reject) => {
        ws.end(() => resolve());
        ws.on("error", reject);
      });
      const fileSize = fs.statSync(file).size;
      expect(fileSize).toBeGreaterThan(80 * 1024 * 1024);

      // Sample heap usage while the compactor runs. A buffering
      // implementation would hold the whole file (as UTF-16 strings,
      // ~2x file size) in memory; streaming keeps the peak far below.
      const baseline = process.memoryUsage().heapUsed;
      let peak = baseline;
      const sampler = setInterval(() => {
        const h = process.memoryUsage().heapUsed;
        if (h > peak) peak = h;
      }, 20);

      let report: ArchiveCompactionReport;
      try {
        report = await compactArchives(twiningDir, { execute: true });
      } finally {
        clearInterval(sampler);
      }

      expect(report.total_junk).toBe(junkWritten);
      expect(report.total_survivors).toBe(survivors.length);
      expect(fs.readFileSync(file, "utf-8")).toBe(survivors.join("\n") + "\n");
      expect(report.total_bytes_reclaimable).toBeGreaterThan(80 * 1024 * 1024);

      const peakDeltaMB = (peak - baseline) / (1024 * 1024);
      // Streaming peaks at a few MB; whole-file buffering would exceed
      // the file size itself. Generous bound to stay CI-stable.
      expect(peakDeltaMB).toBeLessThan(fileSize / (1024 * 1024) / 2);
    },
  );
});
