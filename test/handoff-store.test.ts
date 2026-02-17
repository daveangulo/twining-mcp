import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HandoffStore } from "../src/storage/handoff-store.js";
import type {
  HandoffRecord,
  HandoffResult,
  HandoffIndexEntry,
} from "../src/utils/types.js";

let tmpDir: string;
let store: HandoffStore;

function makeHandoffInput(
  overrides: Record<string, unknown> = {},
): Omit<HandoffRecord, "id" | "created_at"> {
  return {
    source_agent: "agent-alpha",
    target_agent: "agent-beta",
    scope: "src/auth/",
    summary: "Completed auth module implementation",
    results: [
      {
        description: "Implemented JWT middleware",
        status: "completed" as const,
        artifacts: ["src/auth/jwt.ts"],
      },
    ],
    context_snapshot: {
      decision_ids: ["DEC001"],
      warning_ids: [],
      finding_ids: ["FND001"],
      summaries: ["Auth module ready for review"],
    },
    ...overrides,
  } as Omit<HandoffRecord, "id" | "created_at">;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-hoff-test-"));
  fs.mkdirSync(path.join(tmpDir, "handoffs"), { recursive: true });
  store = new HandoffStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HandoffStore.create", () => {
  it("generates ULID id and sets created_at", async () => {
    const handoff = await store.create(makeHandoffInput());
    expect(handoff.id).toHaveLength(26); // ULID length
    expect(handoff.created_at).toBeTruthy();
    expect(new Date(handoff.created_at).toISOString()).toBe(
      handoff.created_at,
    );
  });

  it("writes individual JSON file at handoffs/{id}.json", async () => {
    const handoff = await store.create(makeHandoffInput());
    const filePath = path.join(tmpDir, "handoffs", `${handoff.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.summary).toBe("Completed auth module implementation");
    expect(content.id).toBe(handoff.id);
  });

  it("appends entry to index.jsonl", async () => {
    const handoff = await store.create(makeHandoffInput());
    const indexPath = path.join(tmpDir, "handoffs", "index.jsonl");
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, "utf-8").trim();
    const entry = JSON.parse(content) as HandoffIndexEntry;
    expect(entry.id).toBe(handoff.id);
    expect(entry.source_agent).toBe("agent-alpha");
    expect(entry.acknowledged).toBe(false);
  });

  it('computes correct result_status "completed" when all completed', async () => {
    const handoff = await store.create(
      makeHandoffInput({
        results: [
          { description: "Task A", status: "completed" },
          { description: "Task B", status: "completed" },
        ],
      }),
    );
    const indexPath = path.join(tmpDir, "handoffs", "index.jsonl");
    const content = fs.readFileSync(indexPath, "utf-8").trim();
    const entry = JSON.parse(content) as HandoffIndexEntry;
    expect(entry.result_status).toBe("completed");
  });

  it('computes "mixed" result_status when results have different statuses', async () => {
    const handoff = await store.create(
      makeHandoffInput({
        results: [
          { description: "Task A", status: "completed" },
          { description: "Task B", status: "blocked" },
        ],
      }),
    );
    const indexPath = path.join(tmpDir, "handoffs", "index.jsonl");
    const content = fs.readFileSync(indexPath, "utf-8").trim();
    const entry = JSON.parse(content) as HandoffIndexEntry;
    expect(entry.result_status).toBe("mixed");
  });

  it('computes "completed" result_status when results array is empty', async () => {
    const handoff = await store.create(
      makeHandoffInput({ results: [] }),
    );
    const indexPath = path.join(tmpDir, "handoffs", "index.jsonl");
    const content = fs.readFileSync(indexPath, "utf-8").trim();
    const entry = JSON.parse(content) as HandoffIndexEntry;
    expect(entry.result_status).toBe("completed");
  });
});

describe("HandoffStore.get", () => {
  it("returns null for non-existent id", async () => {
    const result = await store.get("NONEXISTENT0000000000000000");
    expect(result).toBeNull();
  });

  it("returns full record for existing handoff", async () => {
    const created = await store.create(makeHandoffInput());
    const retrieved = await store.get(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.summary).toBe("Completed auth module implementation");
    expect(retrieved!.source_agent).toBe("agent-alpha");
    expect(retrieved!.results).toHaveLength(1);
    expect(retrieved!.context_snapshot.decision_ids).toEqual(["DEC001"]);
  });

  it("survives store re-instantiation (persistence test)", async () => {
    const created = await store.create(makeHandoffInput());
    // Create a new store instance pointing to same directory
    const newStore = new HandoffStore(tmpDir);
    const retrieved = await newStore.get(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.summary).toBe("Completed auth module implementation");
  });
});

describe("HandoffStore.list", () => {
  it("returns all entries when no filters", async () => {
    await store.create(makeHandoffInput({ summary: "Handoff 1" }));
    await store.create(makeHandoffInput({ summary: "Handoff 2" }));
    await store.create(makeHandoffInput({ summary: "Handoff 3" }));
    const entries = await store.list();
    expect(entries).toHaveLength(3);
  });

  it("filters by source_agent", async () => {
    await store.create(
      makeHandoffInput({ source_agent: "agent-alpha", summary: "From alpha" }),
    );
    await store.create(
      makeHandoffInput({ source_agent: "agent-beta", summary: "From beta" }),
    );
    const entries = await store.list({ source_agent: "agent-alpha" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("From alpha");
  });

  it("filters by target_agent", async () => {
    await store.create(
      makeHandoffInput({ target_agent: "agent-gamma", summary: "To gamma" }),
    );
    await store.create(
      makeHandoffInput({ target_agent: "agent-delta", summary: "To delta" }),
    );
    const entries = await store.list({ target_agent: "agent-gamma" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("To gamma");
  });

  it("filters by scope (prefix match, bidirectional)", async () => {
    await store.create(
      makeHandoffInput({ scope: "src/auth/jwt.ts", summary: "JWT" }),
    );
    await store.create(
      makeHandoffInput({ scope: "src/api/", summary: "API" }),
    );
    // Filter with broader scope matches narrower entry
    const entries1 = await store.list({ scope: "src/auth/" });
    expect(entries1).toHaveLength(1);
    expect(entries1[0]!.summary).toBe("JWT");

    // Filter with narrower scope matches broader entry
    await store.create(
      makeHandoffInput({ scope: "src/", summary: "All src" }),
    );
    const entries2 = await store.list({ scope: "src/auth/" });
    expect(entries2).toHaveLength(2); // JWT + All src
  });

  it("filters by since timestamp", async () => {
    const before = new Date("2025-01-01T00:00:00.000Z").toISOString();
    await store.create(makeHandoffInput({ summary: "Recent" }));
    const entries = await store.list({ since: before });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Recent");

    // Future timestamp should exclude everything
    const future = new Date("2099-01-01T00:00:00.000Z").toISOString();
    const empty = await store.list({ since: future });
    expect(empty).toHaveLength(0);
  });

  it("applies limit", async () => {
    await store.create(makeHandoffInput({ summary: "H1" }));
    await store.create(makeHandoffInput({ summary: "H2" }));
    await store.create(makeHandoffInput({ summary: "H3" }));
    const entries = await store.list({ limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("combines multiple filters", async () => {
    await store.create(
      makeHandoffInput({
        source_agent: "alpha",
        scope: "src/auth/",
        summary: "Match",
      }),
    );
    await store.create(
      makeHandoffInput({
        source_agent: "alpha",
        scope: "src/api/",
        summary: "Wrong scope",
      }),
    );
    await store.create(
      makeHandoffInput({
        source_agent: "beta",
        scope: "src/auth/",
        summary: "Wrong agent",
      }),
    );
    const entries = await store.list({
      source_agent: "alpha",
      scope: "src/auth/",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Match");
  });

  it("returns newest first (descending created_at)", async () => {
    // Create with small delays to ensure different timestamps
    const h1 = await store.create(makeHandoffInput({ summary: "First" }));
    const h2 = await store.create(makeHandoffInput({ summary: "Second" }));
    const h3 = await store.create(makeHandoffInput({ summary: "Third" }));
    const entries = await store.list();
    expect(entries[0]!.summary).toBe("Third");
    expect(entries[entries.length - 1]!.summary).toBe("First");
  });
});

describe("HandoffStore.acknowledge", () => {
  it("sets acknowledged_by and acknowledged_at on file", async () => {
    const created = await store.create(makeHandoffInput());
    const acked = await store.acknowledge(created.id, "agent-beta");
    expect(acked.acknowledged_by).toBe("agent-beta");
    expect(acked.acknowledged_at).toBeTruthy();
    expect(new Date(acked.acknowledged_at!).toISOString()).toBe(
      acked.acknowledged_at,
    );

    // Verify persisted to file
    const fromDisk = await store.get(created.id);
    expect(fromDisk!.acknowledged_by).toBe("agent-beta");
    expect(fromDisk!.acknowledged_at).toBeTruthy();
  });

  it("updates index entry acknowledged=true", async () => {
    const created = await store.create(makeHandoffInput());
    await store.acknowledge(created.id, "agent-beta");
    const entries = await store.list();
    const entry = entries.find((e) => e.id === created.id);
    expect(entry).toBeDefined();
    expect(entry!.acknowledged).toBe(true);
  });

  it("throws for non-existent handoff", async () => {
    await expect(
      store.acknowledge("NONEXISTENT0000000000000000", "agent-beta"),
    ).rejects.toThrow();
  });
});

describe("HandoffStore edge cases", () => {
  it("gracefully handles missing index.jsonl (returns empty array)", async () => {
    // Don't create index file — list should return empty
    const freshDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "twining-hoff-empty-"),
    );
    fs.mkdirSync(path.join(freshDir, "handoffs"), { recursive: true });
    const freshStore = new HandoffStore(freshDir);
    const entries = await freshStore.list();
    expect(entries).toHaveLength(0);
    fs.rmSync(freshDir, { recursive: true, force: true });
  });
});
