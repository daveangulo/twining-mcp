/**
 * Embedding reconciliation (FOUNDATION-PLAN W2.3 phase 2): converge the
 * embeddings table to the record tables after ingest changes them.
 *
 * The live write path embeds each record as it is created; ingest bypasses
 * that path, so pulled or branch-switched records arrive with no vectors
 * (search degrades to per-record keyword fallback until fixed). This module
 * closes the gap as a full converge pass rather than a per-ingest delta —
 * it is idempotent, self-healing (records posted while the model was
 * unavailable get embedded on a later pass), and needs no change-tracking
 * plumbing through the ingest code.
 *
 * Per (index, record) the rules are, in order:
 * - record gone            → delete the embedding row (orphan cleanup)
 * - no embedding row       → embed and insert (with content hash)
 * - hash NULL, vector kept → backfill the hash from current text, no model
 *   call. NULL means "written before hashes existed" (pre-v2 rows, or the
 *   soak's bare addEntry) and record embed text is immutable in practice,
 *   so the existing vector is trusted. A record whose text was rewritten by
 *   ingest inside that window keeps a stale vector until its next change —
 *   accepted: the window is one startup, and hash comparison catches every
 *   change after backfill.
 * - hash differs           → re-embed (the only model calls a pulled
 *   status-change costs are zero: status edits leave embed text unchanged)
 *
 * Concurrency: model inference never runs inside a transaction; every write
 * is a single upsert/delete statement, so concurrent reconcilers duplicate
 * at most some work, never corrupt state. Fallback mode (no model) still
 * performs cleanup and backfill — only embedding work is skipped.
 */
import type { Embedder } from "../../embeddings/embedder.js";
import {
  blackboardEmbedText,
  decisionEmbedText,
  embedContentHash,
} from "../../embeddings/embed-text.js";
import { isReadOnly } from "../file-store.js";
import type { BlackboardEntry, Decision } from "../../utils/types.js";
import { vectorToBlob, type SqliteDatabase } from "../sqlite/db.js";

export interface ReconcileStats {
  embedded: number;
  backfilled: number;
  deleted: number;
  /** Records left without a vector (model unavailable or embed failed). */
  pending: number;
}

const INDEXES = [
  {
    indexName: "blackboard",
    table: "blackboard",
    text: (data: string) => blackboardEmbedText(JSON.parse(data) as BlackboardEntry),
  },
  {
    indexName: "decisions",
    table: "decisions",
    text: (data: string) => decisionEmbedText(JSON.parse(data) as Decision),
  },
] as const;

/** Converge the embeddings table to the record tables. Never throws. */
export async function reconcileEmbeddings(
  db: SqliteDatabase,
  embedder: Embedder,
): Promise<ReconcileStats> {
  const stats: ReconcileStats = {
    embedded: 0,
    backfilled: 0,
    deleted: 0,
    pending: 0,
  };
  if (isReadOnly()) return stats;

  for (const { indexName, table, text } of INDEXES) {
    try {
      stats.deleted += Number(
        db
          .prepare(
            `DELETE FROM embeddings WHERE index_name = ? AND id NOT IN (SELECT id FROM ${table})`,
          )
          .run(indexName).changes,
      );

      const hashes = new Map<string, string | null>(
        db
          .prepare("SELECT id, content_hash FROM embeddings WHERE index_name = ?")
          .all(indexName)
          .map((r) => [r.id as string, r.content_hash as string | null]),
      );

      const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as {
        id: string;
        data: string;
      }[];

      for (const row of rows) {
        let hash: string;
        try {
          hash = embedContentHash(text(row.data));
        } catch {
          continue; // unparseable row data — ingest already warned
        }

        if (!hashes.has(row.id)) {
          // No vector at all — embed (skipped cheaply in fallback mode).
          const vector = await embedder.embed(text(row.data));
          if (vector) {
            db.prepare(
              "INSERT INTO embeddings (index_name, id, vector, content_hash) VALUES (?, ?, ?, ?) " +
                "ON CONFLICT(index_name, id) DO UPDATE SET vector = excluded.vector, content_hash = excluded.content_hash",
            ).run(indexName, row.id, vectorToBlob(vector), hash);
            stats.embedded++;
          } else {
            stats.pending++;
          }
        } else if (hashes.get(row.id) === null) {
          db.prepare(
            "UPDATE embeddings SET content_hash = ? WHERE index_name = ? AND id = ? AND content_hash IS NULL",
          ).run(hash, indexName, row.id);
          stats.backfilled++;
        } else if (hashes.get(row.id) !== hash) {
          const vector = await embedder.embed(text(row.data));
          if (vector) {
            db.prepare(
              "UPDATE embeddings SET vector = ?, content_hash = ? WHERE index_name = ? AND id = ?",
            ).run(vectorToBlob(vector), hash, indexName, row.id);
            stats.embedded++;
          } else {
            stats.pending++;
          }
        }
      }
    } catch (err) {
      console.error(
        `[twining] Embedding reconcile failed for ${indexName} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return stats;
}
