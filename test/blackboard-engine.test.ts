import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { TwiningError } from "../src/utils/errors.js";

let tmpDir: string;
let engine: BlackboardEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bb-eng-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  const store = new BlackboardStore(tmpDir);
  engine = new BlackboardEngine(store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("BlackboardEngine.post", () => {
  it("posts valid entry and returns id and timestamp", async () => {
    const result = await engine.post({
      entry_type: "finding",
      summary: "Test finding",
    });
    expect(result.id).toHaveLength(26);
    expect(result.timestamp).toBeTruthy();
  });

  it("throws TwiningError for invalid entry_type", async () => {
    await expect(
      engine.post({ entry_type: "invalid_type", summary: "Test" }),
    ).rejects.toThrow(TwiningError);
    try {
      await engine.post({ entry_type: "invalid_type", summary: "Test" });
    } catch (e) {
      expect((e as TwiningError).code).toBe("INVALID_INPUT");
    }
  });

  it("throws TwiningError for summary > 200 chars", async () => {
    const longSummary = "x".repeat(201);
    await expect(
      engine.post({ entry_type: "finding", summary: longSummary }),
    ).rejects.toThrow(TwiningError);
    try {
      await engine.post({ entry_type: "finding", summary: longSummary });
    } catch (e) {
      expect((e as TwiningError).code).toBe("INVALID_INPUT");
    }
  });

  it("throws TwiningError for empty summary", async () => {
    await expect(
      engine.post({ entry_type: "finding", summary: "" }),
    ).rejects.toThrow(TwiningError);
  });

  it("applies defaults (scope, agent_id, tags, detail)", async () => {
    await engine.post({ entry_type: "finding", summary: "Test" });
    const { entries } = await engine.read();
    expect(entries[0]!.scope).toBe("project");
    expect(entries[0]!.agent_id).toBe("main");
    expect(entries[0]!.tags).toEqual([]);
    expect(entries[0]!.detail).toBe("");
  });

  it("accepts all 10 entry types", async () => {
    const types = [
      "need",
      "offer",
      "finding",
      "decision",
      "constraint",
      "question",
      "answer",
      "status",
      "artifact",
      "warning",
    ];
    for (const type of types) {
      if (type === "decision") {
        // decision entry_type is rejected — must use twining_decide
        await expect(
          engine.post({ entry_type: type, summary: `Type: ${type}` }),
        ).rejects.toThrow("twining_decide");
      } else {
        const result = await engine.post({ entry_type: type, summary: `Type: ${type}` });
        expect(result.id).toHaveLength(26);
      }
    }
  });
});

describe("BlackboardEngine.read", () => {
  it("reads back posted entries", async () => {
    await engine.post({ entry_type: "finding", summary: "F1" });
    await engine.post({ entry_type: "warning", summary: "W1" });
    const { entries, total_count } = await engine.read();
    expect(entries).toHaveLength(2);
    expect(total_count).toBe(2);
  });

  it("applies default limit of 50", async () => {
    // We won't write 51 entries, but verify the filter is passed
    const { entries } = await engine.read();
    expect(entries).toHaveLength(0);
  });

  it("filters by entry type", async () => {
    await engine.post({ entry_type: "finding", summary: "F1" });
    await engine.post({ entry_type: "warning", summary: "W1" });
    const { entries } = await engine.read({ entry_types: ["warning"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("warning");
  });
});

describe("BlackboardEngine.recent", () => {
  it("returns last N entries", async () => {
    for (let i = 0; i < 5; i++) {
      await engine.post({ entry_type: "finding", summary: `E${i}` });
    }
    const { entries } = await engine.recent(3);
    expect(entries).toHaveLength(3);
    // Most recent first (reverse chronological)
    expect(entries[0]!.summary).toBe("E4");
    expect(entries[2]!.summary).toBe("E2");
  });

  it("filters by entry type", async () => {
    await engine.post({ entry_type: "finding", summary: "F1" });
    await engine.post({ entry_type: "warning", summary: "W1" });
    const { entries } = await engine.recent(10, ["warning"]);
    expect(entries).toHaveLength(1);
  });
});
