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

  it("truncates files after processing", async () => {
    const postsPath = path.join(tmpDir, "pending-posts.jsonl");
    fs.writeFileSync(
      postsPath,
      JSON.stringify({ entry_type: "finding", summary: "test" }) + "\n",
    );

    await processor.processOnStartup();
    const content = fs.readFileSync(postsPath, "utf-8");
    expect(content).toBe("");
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
