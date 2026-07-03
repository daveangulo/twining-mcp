/**
 * Embedding reconciliation (W2.3 phase 2): converge the embeddings table to
 * the record tables. Skipped where node:sqlite is unavailable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type SqliteDatabase } from "../src/storage/sqlite/db.js";
import {
  SqliteBlackboardStore,
  SqliteDecisionStore,
  SqliteIndexManager,
} from "../src/storage/sqlite/sqlite-stores.js";
import { reconcileEmbeddings } from "../src/storage/sync/embedding-reconcile.js";
import {
  blackboardEmbedText,
  embedContentHash,
} from "../src/embeddings/embed-text.js";
import {
  enterReadOnlyMode,
  exitReadOnlyMode,
} from "../src/storage/file-store.js";
import type { Embedder } from "../src/embeddings/embedder.js";
import type { BlackboardEntry } from "../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

/** Deterministic stand-in for the model; records every text it embeds. */
function fakeEmbedder(): Embedder & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    embedded,
    embed: async (text: string) => {
      embedded.push(text);
      return [text.length, 1, 0];
    },
  } as unknown as Embedder & { embedded: string[] };
}

/** Model-unavailable stand-in (embed always null, like fallback mode). */
function nullEmbedder(): Embedder {
  return { embed: async () => null } as unknown as Embedder;
}

let twiningDir: string;
let db: SqliteDatabase;
let bb: SqliteBlackboardStore;
let dc: SqliteDecisionStore;
let im: SqliteIndexManager;

beforeEach(() => {
  twiningDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-reconcile-"));
  if (!HAS_SQLITE) return;
  db = openDatabase(twiningDir);
  bb = new SqliteBlackboardStore(db);
  dc = new SqliteDecisionStore(db);
  im = new SqliteIndexManager(db);
});

afterEach(() => {
  if (HAS_SQLITE) db.close();
  fs.rmSync(twiningDir, { recursive: true, force: true });
});

async function seedPost(summary = "pulled finding"): Promise<BlackboardEntry> {
  return bb.append({
    entry_type: "finding",
    summary,
    detail: "detail",
    tags: [],
    scope: "src/",
    agent_id: "main",
  });
}

async function seedDecision() {
  return dc.create({
    agent_id: "main",
    domain: "architecture",
    scope: "src/",
    summary: "decision summary",
    context: "ctx",
    rationale: "because",
    alternatives: [],
    confidence: "high",
    affected_files: [],
    affected_symbols: [],
    reversible: true,
  } as never);
}

describe.skipIf(!HAS_SQLITE)("embedding reconcile", () => {
  it("embeds records that have no vector (the post-ingest case) and stamps the hash", async () => {
    const entry = await seedPost();
    const decision = await seedDecision();
    const embedder = fakeEmbedder();

    const stats = await reconcileEmbeddings(db, embedder);
    expect(stats.embedded).toBe(2);
    expect(embedder.embedded).toHaveLength(2);

    const row = db
      .prepare(
        "SELECT content_hash FROM embeddings WHERE index_name = 'blackboard' AND id = ?",
      )
      .get(entry.id) as { content_hash: string };
    expect(row.content_hash).toBe(embedContentHash(blackboardEmbedText(entry)));
    expect(await im.getVector("decisions", decision.id)).not.toBeNull();
  });

  it("is idempotent: a converged table produces zero work and zero model calls", async () => {
    await seedPost();
    await reconcileEmbeddings(db, fakeEmbedder());

    const second = fakeEmbedder();
    const stats = await reconcileEmbeddings(db, second);
    expect(stats).toEqual({ embedded: 0, backfilled: 0, deleted: 0, pending: 0 });
    expect(second.embedded).toHaveLength(0);
  });

  it("re-embeds only records whose embed text changed", async () => {
    const entry = await seedPost();
    const decision = await seedDecision();
    await reconcileEmbeddings(db, fakeEmbedder());

    // Simulate ingest updating a pulled record's content (file wins).
    const changed = { ...entry, summary: "rewritten by a colleague" };
    db.prepare("UPDATE blackboard SET data = ? WHERE id = ?").run(
      JSON.stringify(changed),
      entry.id,
    );
    // A status flip leaves the decision's embed text unchanged.
    await dc.updateStatus(decision.id, "superseded");

    const embedder = fakeEmbedder();
    const stats = await reconcileEmbeddings(db, embedder);
    expect(stats.embedded).toBe(1);
    expect(embedder.embedded).toEqual([blackboardEmbedText(changed)]);
  });

  it("backfills a NULL hash from current text without a model call", async () => {
    const entry = await seedPost();
    await im.addEntry("blackboard", entry.id, [9, 9, 9]); // no hash — the pre-v2 shape

    const embedder = fakeEmbedder();
    const stats = await reconcileEmbeddings(db, embedder);
    expect(stats.backfilled).toBe(1);
    expect(embedder.embedded).toHaveLength(0);
    expect(await im.getVector("blackboard", entry.id)).toEqual([9, 9, 9]); // vector trusted

    const row = db
      .prepare(
        "SELECT content_hash FROM embeddings WHERE index_name = 'blackboard' AND id = ?",
      )
      .get(entry.id) as { content_hash: string };
    expect(row.content_hash).toBe(embedContentHash(blackboardEmbedText(entry)));
  });

  it("deletes embeddings whose record is gone (ingest deletions, dismissals)", async () => {
    await im.addEntry("blackboard", "ghost-id", [1, 1, 1]);
    const stats = await reconcileEmbeddings(db, fakeEmbedder());
    expect(stats.deleted).toBe(1);
    expect(await im.getVector("blackboard", "ghost-id")).toBeNull();
  });

  it("without a model: cleanup and backfill still run, missing vectors stay pending", async () => {
    const entry = await seedPost("has stale vector");
    await im.addEntry("blackboard", entry.id, [5, 5, 5]);
    await seedPost("never embedded");
    await im.addEntry("blackboard", "ghost-id", [1, 1, 1]);

    const stats = await reconcileEmbeddings(db, nullEmbedder());
    expect(stats).toEqual({ embedded: 0, backfilled: 1, deleted: 1, pending: 1 });
  });

  it("no-ops under the format-version read-only gate", async () => {
    await seedPost();
    enterReadOnlyMode("test");
    try {
      const embedder = fakeEmbedder();
      const stats = await reconcileEmbeddings(db, embedder);
      expect(stats).toEqual({ embedded: 0, backfilled: 0, deleted: 0, pending: 0 });
      expect(embedder.embedded).toHaveLength(0);
    } finally {
      exitReadOnlyMode();
    }
  });
});
