/**
 * Tests for the PendingProcessor class.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { PendingProcessor } from "../src/engine/pending-processor.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let blackboardEngine: BlackboardEngine;
let processor: PendingProcessor;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-pending-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  blackboardStore = new BlackboardStore(tmpDir);
  blackboardEngine = new BlackboardEngine(blackboardStore);
  processor = new PendingProcessor(tmpDir, blackboardEngine, null);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PendingProcessor.processOnStartup", () => {
  it("returns zeros when no pending files exist", async () => {
    const result = await processor.processOnStartup();
    expect(result.posts_processed).toBe(0);
    expect(result.actions_processed).toBe(0);
  });

  it("processes pending posts into blackboard", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    const posts = [
      { entry_type: "finding", summary: "Found something" },
      { entry_type: "warning", summary: "Watch out" },
    ];
    fs.writeFileSync(
      postsPath,
      posts.map((p) => JSON.stringify(p)).join("\n") + "\n",
    );

    const result = await processor.processOnStartup();
    expect(result.posts_processed).toBe(2);

    // Verify entries are on the blackboard
    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.summary).toBe("Found something");
    expect(entries[1]!.summary).toBe("Watch out");
  });

  it("clears the queue file after processing (rename-swap leaves nothing pending)", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    fs.writeFileSync(
      postsPath,
      JSON.stringify({ entry_type: "finding", summary: "test" }) + "\n",
    );

    await processor.processOnStartup();
    // The live file is renamed away and the swap deleted during drain, so
    // it may be absent entirely rather than present-but-empty — either way
    // there is nothing left to process.
    const content = fs.existsSync(postsPath)
      ? fs.readFileSync(postsPath, "utf-8")
      : "";
    expect(content).toBe("");
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.includes(".processing.")),
    ).toEqual([]);
  });

  it("skips malformed lines without stopping", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    fs.writeFileSync(
      postsPath,
      "not-json\n" +
        JSON.stringify({ entry_type: "finding", summary: "valid" }) +
        "\n",
    );

    const result = await processor.processOnStartup();
    expect(result.posts_processed).toBe(1);
  });

  it("processes pending actions", async () => {
    const actionsPath = path.join(tmpDir, "pending-actions.jsonl");
    // Write an action that doesn't require archiver (since we pass null)
    fs.writeFileSync(
      actionsPath,
      JSON.stringify({ action: "archive" }) + "\n",
    );

    const result = await processor.processOnStartup();
    // Archive action with null archiver still counts as processed
    expect(result.actions_processed).toBe(1);
  });

  it("handles empty pending files", async () => {
    fs.writeFileSync(path.join(tmpDir, "pending-posts.jsonl"), "");
    fs.writeFileSync(path.join(tmpDir, "pending-actions.jsonl"), "");

    const result = await processor.processOnStartup();
    expect(result.posts_processed).toBe(0);
    expect(result.actions_processed).toBe(0);
  });
});

describe("PendingProcessor.processPending (periodic drain)", () => {
  it("is a no-op when the pending files are missing", async () => {
    const result = await processor.processPending();
    expect(result.posts_processed).toBe(0);
    expect(result.actions_processed).toBe(0);
  });

  it("is a no-op when the pending files are empty", async () => {
    fs.writeFileSync(path.join(tmpDir, "pending-posts.jsonl"), "");
    const result = await processor.processPending();
    expect(result.posts_processed).toBe(0);
  });

  it("drains a post appended after startup already ran", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");

    // Startup runs against an empty/missing queue.
    await processor.processOnStartup();

    // A hook appends a post while the server is already up.
    fs.appendFileSync(
      postsPath,
      JSON.stringify({ entry_type: "status", summary: "late arrival" }) + "\n",
    );

    const result = await processor.processPending();
    expect(result.posts_processed).toBe(1);

    const { entries } = await blackboardStore.read();
    expect(entries.map((e) => e.summary)).toEqual(["late arrival"]);
  });

  it("picks up a post appended between two drains on the second drain", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");

    fs.appendFileSync(
      postsPath,
      JSON.stringify({ entry_type: "status", summary: "first" }) + "\n",
    );
    const first = await processor.processPending();
    expect(first.posts_processed).toBe(1);

    // Nothing new yet — second drain sees nothing.
    const second = await processor.processPending();
    expect(second.posts_processed).toBe(0);

    fs.appendFileSync(
      postsPath,
      JSON.stringify({ entry_type: "status", summary: "second" }) + "\n",
    );
    const third = await processor.processPending();
    expect(third.posts_processed).toBe(1);

    const { entries } = await blackboardStore.read();
    expect(entries.map((e) => e.summary)).toEqual(["first", "second"]);
  });

  it("cannot lose a post appended between the read and the truncate (rename-swap closes the window)", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    fs.writeFileSync(
      postsPath,
      JSON.stringify({ entry_type: "status", summary: "before swap" }) + "\n",
    );

    // Simulate a hook append landing after the file has been swapped out
    // for processing but before the drain finishes: recreate the live file
    // at the same path the way an unlocked `>>` append would (create if
    // missing). Mid-drain is hard to inject deterministically, so instead
    // assert the mechanism directly — a leftover per-drain swap file
    // (unique <pid>.<random> suffix) from an interrupted drain is claimed
    // by rename and recovered on the next call rather than silently dropped.
    const leftoverPath = `${postsPath}.processing.12345.abc`;
    fs.renameSync(postsPath, leftoverPath);
    fs.writeFileSync(
      postsPath,
      JSON.stringify({ entry_type: "status", summary: "appended during swap" }) + "\n",
    );

    const result = await processor.processPending();
    expect(result.posts_processed).toBe(2);

    const { entries } = await blackboardStore.read();
    expect(entries.map((e) => e.summary).sort()).toEqual([
      "appended during swap",
      "before swap",
    ]);
    expect(fs.existsSync(leftoverPath)).toBe(false);
    // No swap files of any drainer's name are left behind.
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.includes(".processing.")),
    ).toEqual([]);
  });

  it("drains a >200-char summary by truncating it and preserving the full text in detail", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    const longSummary = "x".repeat(250);
    fs.writeFileSync(
      postsPath,
      JSON.stringify({ entry_type: "status", summary: longSummary }) + "\n",
    );

    const result = await processor.processPending();
    expect(result.posts_processed).toBe(1);

    const { entries } = await blackboardStore.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary.length).toBeLessThanOrEqual(200);
    expect(entries[0]!.summary.endsWith("…")).toBe(true);
    expect(entries[0]!.detail).toContain(longSummary);
  });

  it("recovers a crashed drainer's leftover even when there is no live queue file", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    // Only the leftover exists — the crashed drainer had already renamed
    // the live file away, and no new appends have arrived since.
    fs.writeFileSync(
      `${postsPath}.processing.99999.xyz`,
      JSON.stringify({ entry_type: "status", summary: "stranded" }) + "\n",
    );

    const result = await processor.processPending();
    expect(result.posts_processed).toBe(1);

    const { entries } = await blackboardStore.read();
    expect(entries.map((e) => e.summary)).toEqual(["stranded"]);
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.includes(".processing.")),
    ).toEqual([]);
  });

  it("skips malformed lines without stopping", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    fs.writeFileSync(
      postsPath,
      "not-json\n" +
        JSON.stringify({ entry_type: "finding", summary: "valid" }) +
        "\n",
    );

    const result = await processor.processPending();
    expect(result.posts_processed).toBe(1);
  });

  it("truncates (removes) the queue file after draining", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    fs.writeFileSync(
      postsPath,
      JSON.stringify({ entry_type: "finding", summary: "test" }) + "\n",
    );

    await processor.processPending();
    // Either the file is gone or empty — both mean "nothing left to drain".
    const remaining = fs.existsSync(postsPath)
      ? fs.readFileSync(postsPath, "utf-8")
      : "";
    expect(remaining).toBe("");
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.includes(".processing.")),
    ).toEqual([]);
  });
});
