import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { Archiver } from "../src/engine/archiver.js";
import { readJSONL } from "../src/storage/file-store.js";
import type { BlackboardEntry } from "../src/utils/types.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let blackboardEngine: BlackboardEngine;
let archiver: Archiver;

/** Helper to create a blackboard entry with specific timestamp. */
async function postEntry(
  type: string,
  summary: string,
  timestamp: string,
): Promise<void> {
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
  };
  const bbPath = path.join(tmpDir, "blackboard.jsonl");
  fs.appendFileSync(bbPath, JSON.stringify(entry) + "\n");
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
    await postEntry("warning", "Old warning", "2024-01-01T00:00:00.000Z");

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
    await postEntry("warning", "Batch 2 warning", "2024-06-01T00:00:00.000Z");

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
    await postEntry("warning", "Old warning", "2024-01-01T00:00:00.000Z");
    await postEntry("need", "Old need", "2024-01-01T00:00:00.000Z");

    const result = await archiver.archive({
      before: "2025-01-01T00:00:00.000Z",
      keep_decisions: true,
      summarize: false,
    });

    // Only warning and need should be archived (not decision)
    expect(result.archived_count).toBe(2);

    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("decision");
  });
});
