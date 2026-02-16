/**
 * Tests for SearchEngine, cosineSimilarity, and keywordSearch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SearchEngine,
  cosineSimilarity,
  keywordSearch,
} from "../src/embeddings/search.js";
import { Embedder } from "../src/embeddings/embedder.js";
import { IndexManager } from "../src/embeddings/index-manager.js";
import type { BlackboardEntry, Decision } from "../src/utils/types.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twining-search-test-"));
}

function makeEntry(
  id: string,
  summary: string,
  detail: string = "",
  entry_type: string = "finding",
): BlackboardEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    agent_id: "test",
    entry_type: entry_type as BlackboardEntry["entry_type"],
    tags: [],
    scope: "project",
    summary,
    detail,
  };
}

function makeDecision(
  id: string,
  summary: string,
  rationale: string = "",
  context: string = "",
): Decision {
  return {
    id,
    timestamp: new Date().toISOString(),
    agent_id: "test",
    domain: "implementation",
    scope: "project",
    summary,
    context,
    rationale,
    constraints: [],
    alternatives: [],
    depends_on: [],
    confidence: "medium",
    status: "active",
    reversible: true,
    affected_files: [],
    affected_symbols: [],
  };
}

describe("cosineSimilarity", () => {
  it("should return 1.0 for identical normalized vectors", () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const normalized = v.map((x) => x / mag);
    const sim = cosineSimilarity(normalized, normalized);
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it("should return 0.0 for orthogonal vectors", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("should return -1.0 for opposite normalized vectors", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("should handle empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("should return value between -1 and 1 for arbitrary normalized vectors", () => {
    const a = [0.6, 0.8, 0];
    const b = [0, 0.6, 0.8];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });
});

describe("keywordSearch", () => {
  it("should find items matching query terms", () => {
    const items = [
      { id: "1", text: "The auth module handles JWT tokens" },
      { id: "2", text: "The database stores user data" },
      { id: "3", text: "JWT authentication is secure" },
    ];

    const results = keywordSearch("JWT auth", items, 10);
    expect(results.length).toBeGreaterThan(0);

    // Items 1 and 3 both match both terms ("jwt" and "auth")
    // Item 2 should NOT be in results (no "jwt" or "auth")
    const ids = results.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("3");
    expect(ids).not.toContain("2");
  });

  it("should return empty for no matches", () => {
    const items = [
      { id: "1", text: "hello world" },
      { id: "2", text: "foo bar" },
    ];

    const results = keywordSearch("nonexistent term", items, 10);
    expect(results).toHaveLength(0);
  });

  it("should respect limit parameter", () => {
    const items = [
      { id: "1", text: "test item one" },
      { id: "2", text: "test item two" },
      { id: "3", text: "test item three" },
    ];

    const results = keywordSearch("test", items, 2);
    expect(results).toHaveLength(2);
  });

  it("should handle empty query", () => {
    const items = [{ id: "1", text: "some text" }];
    const results = keywordSearch("", items, 10);
    expect(results).toHaveLength(0);
  });

  it("should be case-insensitive", () => {
    const items = [{ id: "1", text: "Authentication Module" }];
    const results = keywordSearch("authentication module", items, 10);
    expect(results).toHaveLength(1);
  });

  it("should score items with more term occurrences higher", () => {
    const items = [
      { id: "1", text: "auth" },
      { id: "2", text: "auth auth auth" },
    ];

    const results = keywordSearch("auth", items, 10);
    expect(results).toHaveLength(2);
    // Item 2 should score higher due to more occurrences
    expect(results[0]!.id).toBe("2");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });
});

describe("SearchEngine", () => {
  describe("searchBlackboard (fallback mode)", () => {
    it("should use keyword search when embedder is in fallback mode", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);
      (embedder as any).fallbackMode = true;

      const indexManager = new IndexManager(tmpDir);
      const engine = new SearchEngine(embedder, indexManager);

      const entries = [
        makeEntry("1", "JWT authentication setup", "Using jose library"),
        makeEntry("2", "Database schema design", "PostgreSQL with Prisma"),
        makeEntry("3", "Auth middleware", "JWT token validation"),
      ];

      const { results, fallback_mode } = await engine.searchBlackboard(
        "JWT authentication",
        entries,
      );

      expect(fallback_mode).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      // Entries 1 and 3 should be returned (they match "JWT" and/or "authentication")
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain("1");
    });

    it("should filter by entry_types", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);
      (embedder as any).fallbackMode = true;

      const indexManager = new IndexManager(tmpDir);
      const engine = new SearchEngine(embedder, indexManager);

      const entries = [
        makeEntry("1", "JWT finding", "", "finding"),
        makeEntry("2", "JWT warning", "", "warning"),
        makeEntry("3", "JWT status", "", "status"),
      ];

      const { results } = await engine.searchBlackboard("JWT", entries, {
        entry_types: ["finding"],
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe("1");
    });

    it("should respect limit", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);
      (embedder as any).fallbackMode = true;

      const indexManager = new IndexManager(tmpDir);
      const engine = new SearchEngine(embedder, indexManager);

      const entries = Array.from({ length: 20 }, (_, i) =>
        makeEntry(`entry-${i}`, `test item ${i}`),
      );

      const { results } = await engine.searchBlackboard("test", entries, {
        limit: 5,
      });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("should return empty results for empty entries", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);
      (embedder as any).fallbackMode = true;

      const indexManager = new IndexManager(tmpDir);
      const engine = new SearchEngine(embedder, indexManager);

      const { results } = await engine.searchBlackboard("test", []);
      expect(results).toHaveLength(0);
    });
  });

  describe("searchBlackboard (semantic mode with mock vectors)", () => {
    it("should rank entries by cosine similarity", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);

      // Mock the embed method to return a fixed vector
      const queryVector = [1, 0, 0]; // Points in x direction
      (embedder as any).fallbackMode = false;
      (embedder as any).pipeline = true; // Pretend initialized
      embedder.embed = async () => queryVector;

      const indexManager = new IndexManager(tmpDir);
      // Pre-populate index with known vectors
      await indexManager.addEntry("blackboard", "close", [0.9, 0.1, 0]); // Close to query
      await indexManager.addEntry("blackboard", "far", [0, 0.1, 0.9]); // Far from query
      await indexManager.addEntry("blackboard", "medium", [0.5, 0.5, 0]); // Medium

      const engine = new SearchEngine(embedder, indexManager);

      const entries = [
        makeEntry("close", "close match"),
        makeEntry("far", "far match"),
        makeEntry("medium", "medium match"),
      ];

      const { results, fallback_mode } = await engine.searchBlackboard(
        "test query",
        entries,
      );

      expect(fallback_mode).toBe(false);
      expect(results).toHaveLength(3);
      // "close" should rank first (highest cosine similarity to [1,0,0])
      expect(results[0]!.entry.id).toBe("close");
      // "far" should rank last
      expect(results[2]!.entry.id).toBe("far");
    });
  });

  describe("searchDecisions (fallback mode)", () => {
    it("should use keyword search for decisions", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);
      (embedder as any).fallbackMode = true;

      const indexManager = new IndexManager(tmpDir);
      const engine = new SearchEngine(embedder, indexManager);

      const decisions = [
        makeDecision("d1", "Use JWT for auth", "Stateless, scalable"),
        makeDecision("d2", "Use PostgreSQL", "Relational data model"),
      ];

      const { results, fallback_mode } = await engine.searchDecisions(
        "JWT authentication",
        decisions,
      );

      expect(fallback_mode).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.decision.id).toBe("d1");
    });

    it("should return empty for no matching decisions", async () => {
      const tmpDir = makeTempDir();
      const embedder = new Embedder(tmpDir);
      (embedder as any).fallbackMode = true;

      const indexManager = new IndexManager(tmpDir);
      const engine = new SearchEngine(embedder, indexManager);

      const { results } = await engine.searchDecisions(
        "nonexistent topic",
        [],
      );
      expect(results).toHaveLength(0);
    });
  });
});
