import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { Archiver } from "../src/engine/archiver.js";
import { readJSONL } from "../src/storage/file-store.js";
import type { BlackboardEntry, TwiningConfig } from "../src/utils/types.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let blackboardEngine: BlackboardEngine;
let archiver: Archiver;

/** Helper to create a blackboard entry with specific timestamp. */
async function postEntry(
  type: string,
  summary: string,
  timestamp: string,
  extra: Partial<BlackboardEntry> = {},
): Promise<string> {
  // Write directly to JSONL to control timestamp
  const entry = {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp,
    agent_id: "test",
    entry_type: type,
    tags: ["test"],
    scope: "project",
    summary,
    detail: "",
    ...extra,
  };
  const bbPath = path.join(tmpDir, "blackboard.jsonl");
  fs.appendFileSync(bbPath, JSON.stringify(entry) + "\n");
  return entry.id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-archiver-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  blackboardStore = new BlackboardStore(tmpDir);
  blackboardEngine = new BlackboardEngine(blackboardStore);
  archiver = new Archiver(tmpDir, blackboardStore, blackboardEngine, null);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Archiver.archive", () => {
  it("moves entries older than cutoff to archive file, keeping newer entries in blackboard", async () => {
    await postEntry("finding", "Old finding", "2025-01-01T00:00:00.000Z");
    await postEntry("finding", "Recent finding", "2025-06-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-03-01T00:00:00.000Z",
      summarize: false,
    });

    expect(result.archived_count).toBe(1);
    expect(result.archive_file).toContain("2025-03-01-blackboard.jsonl");

    // Check archive file contains old entry
    const archived = await readJSONL<BlackboardEntry>(result.archive_file);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.summary).toBe("Old finding");

    // Check blackboard still has the recent entry
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Recent finding");
  });

  it("never archives decision entries even if older than cutoff", async () => {
    await postEntry("decision", "Old decision", "2024-01-01T00:00:00.000Z");
    await postEntry("finding", "Old finding", "2024-01-01T00:00:00.000Z");
    await postEntry("finding", "Recent finding", "2025-06-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-03-01T00:00:00.000Z",
      summarize: false,
    });

    // Only the old finding should be archived, not the decision
    expect(result.archived_count).toBe(1);

    // Blackboard should still have the decision and recent finding
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(2);
    const types = entries.map((e) => e.entry_type);
    expect(types).toContain("decision");
    expect(types).toContain("finding");
  });

  it("posts summary finding to blackboard when summarize=true", async () => {
    await postEntry("finding", "Old finding 1", "2024-01-01T00:00:00.000Z");
    await postEntry("status", "Old status", "2024-01-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: true,
    });

    expect(result.archived_count).toBe(2);
    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain("2 entries archived");

    // The summary finding should now be in the blackboard
    const { entries } = await blackboardStore.read();
    const summaryEntry = entries.find(
      (e) => e.entry_type === "finding" && e.summary.includes("Archive:"),
    );
    expect(summaryEntry).toBeTruthy();
    expect(summaryEntry!.tags).toContain("archive");
  });

  it("returns archived_count: 0 when nothing matches cutoff", async () => {
    await postEntry("finding", "Recent finding", "2025-12-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: false,
    });

    expect(result.archived_count).toBe(0);
    expect(result.archive_file).toBe("");
  });

  it("appends to same-day archive file on multiple archives", async () => {
    await postEntry("finding", "Batch 1 finding", "2024-01-01T00:00:00.000Z");

    const result1 = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: false,
    });
    expect(result1.archived_count).toBe(1);

    // Add another old entry and archive again with same date prefix
    await postEntry("status", "Batch 2 status", "2024-06-01T00:00:00.000Z");

    const result2 = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: false,
    });
    expect(result2.archived_count).toBe(1);

    // Both archives should have used the same file
    expect(result1.archive_file).toBe(result2.archive_file);

    // Archive file should have 2 entries total
    const archived = await readJSONL<BlackboardEntry>(result1.archive_file);
    expect(archived).toHaveLength(2);
  });

  it("generates a summary capped at reasonable length", async () => {
    // Create many entries to test summary capping
    for (let i = 0; i < 50; i++) {
      await postEntry(
        "finding",
        `Finding ${i} with a reasonably long summary text to test capping behavior`,
        "2024-01-01T00:00:00.000Z",
      );
    }

    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: true,
    });

    expect(result.summary).toBeTruthy();
    expect(result.summary!.length).toBeLessThanOrEqual(2000);
  });

  it("returns empty for empty blackboard", async () => {
    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: false,
    });

    expect(result.archived_count).toBe(0);
    expect(result.archive_file).toBe("");
  });

  it("archives non-decision entries when keep_decisions is true (default)", async () => {
    await postEntry("decision", "Important decision", "2024-01-01T00:00:00.000Z");
    await postEntry("finding", "Old finding", "2024-01-01T00:00:00.000Z");
    await postEntry("status", "Old status", "2024-01-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      keep_decisions: true,
      summarize: false,
    });

    // Only finding and status should be archived (not decision)
    expect(result.archived_count).toBe(2);

    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("decision");
  });

  it("posts no summary entry when nothing is archivable", async () => {
    await postEntry("finding", "Recent finding", "2025-12-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: true,
    });

    expect(result.archived_count).toBe(0);
    expect(result.summary).toBeUndefined();

    // No "Archive: N entries archived" summary should have been posted.
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
    const summaryEntry = entries.find((e) => e.summary.includes("Archive:"));
    expect(summaryEntry).toBeUndefined();
  });

  it("archiver's own summary post does not recursively re-trigger another archive", async () => {
    // Set up a scenario where, absent the _skipAutoArchive flag on the
    // summary post, the post-archive blackboard state (1 surviving recent
    // finding + the new summary entry, which is tag-excluded) would still
    // meet the threshold and re-fire the archiver — the exact loop that
    // produced millions of "Archive: 1 entries archived" junk entries.
    await postEntry("finding", "Old finding", "2024-01-01T00:00:00.000Z");
    await postEntry("finding", "Recent finding", "2025-06-01T00:00:00.000Z");

    const config: TwiningConfig = {
      ...DEFAULT_CONFIG,
      archive: {
        ...DEFAULT_CONFIG.archive,
        max_blackboard_entries_before_archive: 1,
      },
    };
    blackboardEngine.setArchiver(archiver, config);
    const archiveSpy = vi.spyOn(archiver, "archive");

    await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      summarize: true,
    });

    // Allow any (bugged) fire-and-forget recursive call to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(archiveSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Archiver open needs/warnings exemption (#40)", () => {
  const OLD = "2025-01-01T00:00:00.000Z";
  const LATER = "2025-01-02T00:00:00.000Z";
  const CUTOFF = "2025-03-01T00:00:00.000Z";

  it("does not archive an unresolved need older than the cutoff by default", async () => {
    await postEntry("need", "Open obligation", OLD);
    await postEntry("finding", "Old finding", OLD);

    const result = await archiver.archive({ before: CUTOFF, summarize: false });

    expect(result.archived_count).toBe(1);
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("need");
  });

  it("does not archive an unresolved warning older than the cutoff by default", async () => {
    await postEntry("warning", "Fragile spot", OLD);

    const result = await archiver.archive({ before: CUTOFF, summarize: false });

    expect(result.archived_count).toBe(0);
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
  });

  it("archives a need that a later entry resolved via relates_to", async () => {
    const needId = await postEntry("need", "Add rate limiting", OLD);
    await postEntry("status", "Rate limiting added", LATER, {
      relates_to: [needId],
    });

    const result = await archiver.archive({ before: CUTOFF, summarize: false });

    // Both the resolved need and its resolver are old enough to go.
    expect(result.archived_count).toBe(2);
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(0);
  });

  it("archives old needs and warnings when keep_open_needs_warnings is false", async () => {
    await postEntry("need", "Open obligation", OLD);
    await postEntry("warning", "Fragile spot", OLD);

    const result = await archiver.archive({
      before: CUTOFF,
      summarize: false,
      keep_open_needs_warnings: false,
    });

    expect(result.archived_count).toBe(2);
  });

  it("reports how many open needs/warnings were exempted", async () => {
    await postEntry("need", "Open obligation", OLD);
    await postEntry("warning", "Fragile spot", OLD);
    await postEntry("finding", "Old finding", OLD);

    const result = await archiver.archive({ before: CUTOFF, summarize: false });

    expect(result.archived_count).toBe(1);
    expect(result.kept_open_count).toBe(2);
  });
});

describe("Archiver.plan (#39)", () => {
  it("reports the would-be archive partition without touching the store", async () => {
    await postEntry("finding", "Old finding", "2025-01-01T00:00:00.000Z");
    await postEntry("need", "Open obligation", "2025-01-01T00:00:00.000Z");
    await postEntry("finding", "Recent finding", "2025-06-01T00:00:00.000Z");

    const plan = await archiver.plan({ before: "2025-03-01T00:00:00.000Z" });

    expect(plan.to_archive.map((e) => e.summary)).toEqual(["Old finding"]);
    expect(plan.kept_open_count).toBe(1);
    // Pure: nothing moved, nothing written.
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(3);
    expect(fs.existsSync(path.join(tmpDir, "archive"))).toBe(false);
  });
});
