import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { ENTRY_TYPES } from "../src/utils/types.js";

let tmpDir: string;
let store: BlackboardStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-bb-test-"));
  // Create the blackboard file
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  store = new BlackboardStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("BlackboardStore.append", () => {
  it("appends entry and returns it with id and timestamp", async () => {
    const result = await store.append({
      entry_type: "finding",
      summary: "Test finding",
      detail: "Some detail",
      tags: ["test"],
      scope: "project",
      agent_id: "main",
    });
    expect(result.id).toHaveLength(26);
    expect(result.timestamp).toBeTruthy();
    expect(result.entry_type).toBe("finding");
    expect(result.summary).toBe("Test finding");
  });
});

describe("BlackboardStore.read", () => {
  it("reads back appended entries", async () => {
    await store.append({
      entry_type: "finding",
      summary: "Finding 1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "warning",
      summary: "Warning 1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    const { entries, total_count } = await store.read();
    expect(entries).toHaveLength(2);
    expect(total_count).toBe(2);
  });

  it("filters by entry_type", async () => {
    await store.append({
      entry_type: "finding",
      summary: "F1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "warning",
      summary: "W1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "need",
      summary: "N1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    const { entries } = await store.read({ entry_types: ["warning"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("warning");
  });

  it("filters by tags (OR match)", async () => {
    await store.append({
      entry_type: "finding",
      summary: "F1",
      detail: "",
      tags: ["auth", "backend"],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "finding",
      summary: "F2",
      detail: "",
      tags: ["frontend"],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "finding",
      summary: "F3",
      detail: "",
      tags: ["auth"],
      scope: "project",
      agent_id: "main",
    });
    const { entries } = await store.read({ tags: ["auth"] });
    expect(entries).toHaveLength(2);
  });

  it("filters by scope with prefix matching", async () => {
    await store.append({
      entry_type: "finding",
      summary: "F1",
      detail: "",
      tags: [],
      scope: "src/auth/jwt.ts",
      agent_id: "main",
    });
    await store.append({
      entry_type: "finding",
      summary: "F2",
      detail: "",
      tags: [],
      scope: "src/api/routes.ts",
      agent_id: "main",
    });
    await store.append({
      entry_type: "finding",
      summary: "F3",
      detail: "",
      tags: [],
      scope: "src/auth/session.ts",
      agent_id: "main",
    });
    const { entries } = await store.read({ scope: "src/auth/" });
    expect(entries).toHaveLength(2);
  });

  it("filters by since timestamp", async () => {
    // Use a past timestamp for "old" entries and future for filter
    await store.append({
      entry_type: "finding",
      summary: "Old",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });

    // Wait a small amount to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 10));
    const since = new Date().toISOString();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.append({
      entry_type: "finding",
      summary: "New",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    const { entries } = await store.read({ since });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("New");
  });

  it("applies limit after filtering", async () => {
    for (let i = 0; i < 10; i++) {
      await store.append({
        entry_type: "finding",
        summary: `Entry ${i}`,
        detail: "",
        tags: [],
        scope: "project",
        agent_id: "main",
      });
    }
    const { entries, total_count } = await store.read({ limit: 5 });
    expect(entries).toHaveLength(5);
    expect(total_count).toBe(10);
  });
});

describe("BlackboardStore.recent", () => {
  it("returns last N entries", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        entry_type: "finding",
        summary: `Entry ${i}`,
        detail: "",
        tags: [],
        scope: "project",
        agent_id: "main",
      });
    }
    const entries = await store.recent(3);
    expect(entries).toHaveLength(3);
    // Most recent first (reverse chronological)
    expect(entries[0]!.summary).toBe("Entry 4");
    expect(entries[2]!.summary).toBe("Entry 2");
  });

  it("filters by entry type before taking recent", async () => {
    await store.append({
      entry_type: "finding",
      summary: "F1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "warning",
      summary: "W1",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    await store.append({
      entry_type: "finding",
      summary: "F2",
      detail: "",
      tags: [],
      scope: "project",
      agent_id: "main",
    });
    const entries = await store.recent(10, ["warning"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_type).toBe("warning");
  });
});

describe("ENTRY_TYPES validation", () => {
  it("all 10 entry types are valid", () => {
    expect(ENTRY_TYPES).toHaveLength(10);
    for (const type of ENTRY_TYPES) {
      expect(typeof type).toBe("string");
    }
  });
});
