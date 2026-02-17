import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionStore } from "../src/storage/decision-store.js";

let tmpDir: string;
let store: DecisionStore;

function makeDecisionInput(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "main",
    domain: "architecture",
    scope: "src/auth/",
    summary: "Use JWT for auth",
    context: "Need stateless auth",
    rationale: "Enables horizontal scaling",
    constraints: ["No sessions"],
    alternatives: [
      {
        option: "Sessions with Redis",
        pros: ["Simple"],
        cons: ["Requires Redis"],
        reason_rejected: "Too complex",
      },
    ],
    depends_on: [] as string[],
    confidence: "high" as const,
    reversible: true,
    affected_files: ["src/auth/jwt.ts"],
    affected_symbols: ["verifyToken"],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-dcsn-test-"));
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  store = new DecisionStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DecisionStore.create", () => {
  it("creates a decision with generated id and timestamp", async () => {
    const decision = await store.create(makeDecisionInput());
    expect(decision.id).toHaveLength(26);
    expect(decision.timestamp).toBeTruthy();
    expect(decision.status).toBe("active");
    expect(decision.summary).toBe("Use JWT for auth");
  });

  it("writes individual decision file", async () => {
    const decision = await store.create(makeDecisionInput());
    const filePath = path.join(tmpDir, "decisions", `${decision.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.summary).toBe("Use JWT for auth");
  });

  it("updates index with new entry", async () => {
    await store.create(makeDecisionInput());
    const index = await store.getIndex();
    expect(index).toHaveLength(1);
    expect(index[0]!.summary).toBe("Use JWT for auth");
  });
});

describe("DecisionStore.get", () => {
  it("retrieves a decision by ID", async () => {
    const created = await store.create(makeDecisionInput());
    const retrieved = await store.get(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.rationale).toBe("Enables horizontal scaling");
  });

  it("returns null for non-existent ID", async () => {
    const result = await store.get("NONEXISTENT0000000000000000");
    expect(result).toBeNull();
  });
});

describe("DecisionStore.getByScope", () => {
  it("returns matching decisions (exact scope)", async () => {
    await store.create(
      makeDecisionInput({
        scope: "src/auth/",
        affected_files: [],
        affected_symbols: [],
      }),
    );
    await store.create(
      makeDecisionInput({
        scope: "src/api/",
        summary: "API design",
        affected_files: [],
        affected_symbols: [],
      }),
    );
    const results = await store.getByScope("src/auth/");
    expect(results).toHaveLength(1);
    expect(results[0]!.scope).toBe("src/auth/");
  });

  it("returns matching decisions (prefix match)", async () => {
    await store.create(
      makeDecisionInput({
        scope: "src/auth/jwt.ts",
        affected_files: [],
        affected_symbols: [],
      }),
    );
    await store.create(
      makeDecisionInput({
        scope: "src/auth/session.ts",
        affected_files: [],
        affected_symbols: [],
      }),
    );
    await store.create(
      makeDecisionInput({
        scope: "src/api/routes.ts",
        summary: "API",
        affected_files: [],
        affected_symbols: [],
      }),
    );
    const results = await store.getByScope("src/auth/");
    expect(results).toHaveLength(2);
  });

  it("returns empty array for non-matching scope", async () => {
    await store.create(makeDecisionInput({ scope: "src/auth/" }));
    const results = await store.getByScope("src/database/");
    expect(results).toHaveLength(0);
  });

  it("matches by affected_files", async () => {
    await store.create(
      makeDecisionInput({
        scope: "project",
        affected_files: ["src/auth/jwt.ts"],
      }),
    );
    const results = await store.getByScope("src/auth/jwt.ts");
    expect(results).toHaveLength(1);
  });

  it("returns decisions sorted by timestamp descending", async () => {
    const d1 = await store.create(
      makeDecisionInput({ summary: "First decision" }),
    );
    const d2 = await store.create(
      makeDecisionInput({ summary: "Second decision" }),
    );
    const results = await store.getByScope("src/auth/");
    expect(results[0]!.summary).toBe("Second decision");
    expect(results[1]!.summary).toBe("First decision");
  });
});

describe("DecisionStore.updateStatus", () => {
  it("changes status in both file and index", async () => {
    const decision = await store.create(makeDecisionInput());
    await store.updateStatus(decision.id, "superseded");

    // Check file
    const updated = await store.get(decision.id);
    expect(updated!.status).toBe("superseded");

    // Check index
    const index = await store.getIndex();
    expect(index[0]!.status).toBe("superseded");
  });

  it("applies extra fields", async () => {
    const decision = await store.create(makeDecisionInput());
    await store.updateStatus(decision.id, "overridden", {
      overridden_by: "human",
      override_reason: "Changed requirements",
    });
    const updated = await store.get(decision.id);
    expect(updated!.overridden_by).toBe("human");
    expect(updated!.override_reason).toBe("Changed requirements");
  });
});

describe("DecisionStore.create with commit_hashes", () => {
  it("persists commit_hashes in both file and index", async () => {
    const decision = await store.create(
      makeDecisionInput({ commit_hashes: ["abc123"] }),
    );
    // Check file
    const filePath = path.join(tmpDir, "decisions", `${decision.id}.json`);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.commit_hashes).toEqual(["abc123"]);
    // Check index
    const index = await store.getIndex();
    expect(index[0]!.commit_hashes).toEqual(["abc123"]);
  });

  it("defaults commit_hashes to empty array when not provided", async () => {
    const decision = await store.create(makeDecisionInput());
    expect(decision.commit_hashes).toEqual([]);
    const index = await store.getIndex();
    expect(index[0]!.commit_hashes).toEqual([]);
  });
});

describe("DecisionStore.linkCommit", () => {
  it("adds a hash to an existing decision", async () => {
    const decision = await store.create(makeDecisionInput());
    await store.linkCommit(decision.id, "abc123");

    // Check file
    const updated = await store.get(decision.id);
    expect(updated!.commit_hashes).toContain("abc123");

    // Check index
    const index = await store.getIndex();
    expect(index[0]!.commit_hashes).toContain("abc123");
  });

  it("does not add duplicate hashes", async () => {
    const decision = await store.create(makeDecisionInput());
    await store.linkCommit(decision.id, "abc123");
    await store.linkCommit(decision.id, "abc123");

    const updated = await store.get(decision.id);
    expect(updated!.commit_hashes).toEqual(["abc123"]);

    const index = await store.getIndex();
    expect(index[0]!.commit_hashes).toEqual(["abc123"]);
  });

  it("throws for nonexistent decision", async () => {
    await expect(
      store.linkCommit("NONEXISTENT0000000000000000", "abc123"),
    ).rejects.toThrow("Decision not found");
  });
});

describe("DecisionStore.getByCommitHash", () => {
  it("returns matching decisions", async () => {
    await store.create(makeDecisionInput({ commit_hashes: ["abc123"] }));
    await store.create(
      makeDecisionInput({ summary: "Another", commit_hashes: ["def456"] }),
    );

    const results = await store.getByCommitHash("abc123");
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toBe("Use JWT for auth");
  });

  it("returns empty array for unknown hash", async () => {
    await store.create(makeDecisionInput({ commit_hashes: ["abc123"] }));
    const results = await store.getByCommitHash("unknown");
    expect(results).toHaveLength(0);
  });
});

describe("DecisionStore.getIndex", () => {
  it("stays in sync after multiple creates", async () => {
    await store.create(makeDecisionInput({ summary: "D1" }));
    await store.create(makeDecisionInput({ summary: "D2" }));
    await store.create(makeDecisionInput({ summary: "D3" }));
    const index = await store.getIndex();
    expect(index).toHaveLength(3);
    expect(index.map((e) => e.summary)).toContain("D1");
    expect(index.map((e) => e.summary)).toContain("D2");
    expect(index.map((e) => e.summary)).toContain("D3");
  });

  it("handles concurrent creates without corruption", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      store.create(makeDecisionInput({ summary: `Concurrent D${i}` })),
    );
    await Promise.all(promises);
    const index = await store.getIndex();
    expect(index).toHaveLength(5);
  });
});
