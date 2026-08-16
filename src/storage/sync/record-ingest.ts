/**
 * Record ingest (FOUNDATION-PLAN W2.3): converge the sqlite database to the
 * committed export tree under .twining/records/.
 *
 * Runs on server startup — the common flow is `git pull` (or branch switch /
 * merge) followed by a new session, so startup is where another user's or
 * branch's records arrive. Idempotent by construction: upsert-by-ULID,
 * update only when serialized content differs (file wins — the tree is the
 * committed truth), delete rows whose file is gone. Because two branches'
 * export trees union-merge in git with no conflicts (distinct ULID
 * filenames), ingest after a merge yields the union of both branches'
 * records — the multi-user model from the plan's D2.
 *
 * Safety guards:
 * - No records/ directory at all → skip entirely (file backend, or a team
 *   that gitignores the export tree). Never treat "no tree" as "delete all".
 * - Deletion propagation applies per kind, and only when that kind's
 *   directory exists.
 * - Unparseable files are skipped with a warning, never deleted.
 */
import fs from "node:fs";
import path from "node:path";
import { RecordExporter, stableStringify } from "./record-export.js";
import { generateId } from "../../utils/ids.js";
import { isReadOnly } from "../file-store.js";
import type { SqliteDatabase } from "../sqlite/db.js";
import { withWriteTxn } from "../sqlite/db.js";
import type {
  BlackboardEntry,
  Decision,
  Entity,
  HandoffIndexEntry,
  HandoffRecord,
  Relation,
} from "../../utils/types.js";

export interface IngestStats {
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  /** File-wins updates that DOWNGRADED a decision's lifecycle status (e.g. overridden → provisional) — usually an uncommitted status write discarded by a git operation (field D14). */
  lifecycle_reverts: number;
  /** Per-record detail for lifecycle_reverts — feeds the blackboard warning ingest posts. scope is the reverted decision's own scope, so the warning surfaces in narrow-scope assembles. */
  lifecycle_revert_details: Array<{
    id: string;
    from: string;
    to: string;
    scope: string;
  }>;
}

/** provisional < active < retired; a file-wins move to a lower rank is a revert. */
const LIFECYCLE_RANK: Record<string, number> = {
  provisional: 0,
  active: 1,
  superseded: 2,
  overridden: 2,
  archived: 2,
};

/**
 * Only these db-side statuses arm the revert detector: they have no
 * sanctioned undo verb, so a file-wins downgrade of them is either a
 * discarded uncommitted write or branch/history divergence — never a
 * routine lifecycle flow. active→provisional (twining_reconsider) and
 * archived→anything (twining_unarchive) are first-class transitions that
 * legitimately arrive via git and must not fire the alarm.
 */
const REVERT_WATCHED = new Set(["overridden", "superseded"]);

function* jsonFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, dirent.name);
    if (dirent.isDirectory()) yield* jsonFiles(p);
    else if (dirent.name.endsWith(".json")) yield p;
  }
}

function readRecord<T>(filePath: string, stats: IngestStats): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    console.error(
      `[twining] Skipping unparseable record file: ${path.basename(filePath)}`,
    );
    stats.skipped++;
    return null;
  }
}

function handoffIndexEntry(record: HandoffRecord): HandoffIndexEntry {
  let result_status: HandoffIndexEntry["result_status"] = "completed";
  if (record.results.length > 0) {
    const statuses = new Set(record.results.map((r) => r.status));
    result_status = statuses.size === 1 ? record.results[0]!.status : "mixed";
  }
  return {
    id: record.id,
    created_at: record.created_at,
    source_agent: record.source_agent,
    target_agent: record.target_agent,
    scope: record.scope,
    summary: record.summary,
    result_status,
    acknowledged: Boolean(record.acknowledged_by),
  };
}

interface KindSpec {
  dir: string;
  table: string;
  insert(db: SqliteDatabase, record: never): void;
  update(db: SqliteDatabase, record: never): void;
}

/**
 * Converge the database to the export tree. Returns per-run stats.
 * Synchronous — called once at startup before the server takes traffic.
 */
export function ingestRecords(
  db: SqliteDatabase,
  twiningDir: string,
): IngestStats {
  const stats: IngestStats = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    lifecycle_reverts: 0,
    lifecycle_revert_details: [],
  };
  const recordsDir = path.join(twiningDir, "records");
  if (!fs.existsSync(recordsDir)) return stats;

  const kinds: KindSpec[] = [
    {
      dir: path.join(recordsDir, "posts"),
      table: "blackboard",
      insert: (d, e: BlackboardEntry) =>
        void d
          .prepare(
            "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
          )
          .run(e.id, e.entry_type, e.scope, e.timestamp, JSON.stringify(e)),
      update: (d, e: BlackboardEntry) =>
        void d
          .prepare(
            "UPDATE blackboard SET entry_type = ?, scope = ?, timestamp = ?, data = ? WHERE id = ?",
          )
          .run(e.entry_type, e.scope, e.timestamp, JSON.stringify(e), e.id),
    },
    {
      dir: path.join(recordsDir, "decisions"),
      table: "decisions",
      insert: (d, dec: Decision) =>
        void d
          .prepare(
            "INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)",
          )
          .run(dec.id, dec.status, dec.timestamp, JSON.stringify(dec)),
      update: (d, dec: Decision) =>
        void d
          .prepare(
            "UPDATE decisions SET status = ?, timestamp = ?, data = ? WHERE id = ?",
          )
          .run(dec.status, dec.timestamp, JSON.stringify(dec), dec.id),
    },
    {
      dir: path.join(recordsDir, "graph", "entities"),
      table: "entities",
      insert: (d, e: Entity) =>
        void d
          .prepare(
            "INSERT INTO entities (id, name, type, data) VALUES (?, ?, ?, ?)",
          )
          .run(e.id, e.name, e.type, JSON.stringify(e)),
      update: (d, e: Entity) =>
        void d
          .prepare("UPDATE entities SET name = ?, type = ?, data = ? WHERE id = ?")
          .run(e.name, e.type, JSON.stringify(e), e.id),
    },
    {
      dir: path.join(recordsDir, "graph", "relations"),
      table: "relations",
      insert: (d, r: Relation) =>
        void d
          .prepare(
            "INSERT INTO relations (id, source, target, data) VALUES (?, ?, ?, ?)",
          )
          .run(r.id, r.source, r.target, JSON.stringify(r)),
      update: (d, r: Relation) =>
        void d
          .prepare(
            "UPDATE relations SET source = ?, target = ?, data = ? WHERE id = ?",
          )
          .run(r.source, r.target, JSON.stringify(r), r.id),
    },
    {
      dir: path.join(recordsDir, "handoffs"),
      table: "handoffs",
      insert: (d, h: HandoffRecord) =>
        void d
          .prepare(
            "INSERT INTO handoffs (id, created_at, data, index_data) VALUES (?, ?, ?, ?)",
          )
          .run(
            h.id,
            h.created_at,
            JSON.stringify(h),
            JSON.stringify(handoffIndexEntry(h)),
          ),
      update: (d, h: HandoffRecord) =>
        void d
          .prepare(
            "UPDATE handoffs SET created_at = ?, data = ?, index_data = ? WHERE id = ?",
          )
          .run(
            h.created_at,
            JSON.stringify(h),
            JSON.stringify(handoffIndexEntry(h)),
            h.id,
          ),
    },
  ];

  for (const kind of kinds) {
    // Never propagate deletions from a kind whose directory doesn't exist.
    if (!fs.existsSync(kind.dir)) continue;

    // Load current DB rows for this kind, keyed by id.
    const dbRows = new Map<string, string>(
      db
        .prepare(`SELECT id, data FROM ${kind.table}`)
        .all()
        .map((r) => [r.id as string, r.data as string]),
    );

    const fileIds = new Set<string>();
    withWriteTxn(db, () => {
      for (const filePath of jsonFiles(kind.dir)) {
        const record = readRecord<{ id: string }>(filePath, stats);
        if (!record || typeof record.id !== "string") continue;
        fileIds.add(record.id);
        const existing = dbRows.get(record.id);
        if (existing === undefined) {
          kind.insert(db, record as never);
          stats.inserted++;
        } else if (
          stableStringify(JSON.parse(existing)) !== stableStringify(record)
        ) {
          // File wins: the export tree is the committed truth at ingest time.
          // But a file-wins DOWNGRADE of a decision's lifecycle usually means
          // a not-yet-committed status write (override/supersede/archive/
          // promote) was discarded by a git operation on the records tree
          // (field D14) — count it and name the record so the loss is
          // visible instead of silent. Precedence itself is unchanged.
          if (kind.table === "decisions") {
            const dbStatus = (JSON.parse(existing) as { status?: string })
              .status;
            const fileStatus = (record as { status?: string }).status;
            const dbRank = dbStatus ? LIFECYCLE_RANK[dbStatus] : undefined;
            const fileRank = fileStatus
              ? LIFECYCLE_RANK[fileStatus]
              : undefined;
            if (
              dbStatus !== undefined &&
              REVERT_WATCHED.has(dbStatus) &&
              dbRank !== undefined &&
              fileRank !== undefined &&
              fileRank < dbRank
            ) {
              stats.lifecycle_reverts++;
              stats.lifecycle_revert_details.push({
                id: record.id,
                from: dbStatus,
                to: fileStatus ?? "(none)",
                scope:
                  (record as { scope?: string }).scope ?? "project",
              });
              console.error(
                `[twining] ingest file-wins downgraded decision ${record.id} from "${dbStatus}" to "${fileStatus}" — either a not-yet-committed lifecycle write was discarded by a git operation on the records tree, or branches/history legitimately diverge here`,
              );
            }
          }
          kind.update(db, record as never);
          stats.updated++;
        }
      }
      for (const id of dbRows.keys()) {
        if (!fileIds.has(id)) {
          db.prepare(`DELETE FROM ${kind.table} WHERE id = ?`).run(id);
          stats.deleted++;
        }
      }
    });
  }

  // A reverted lifecycle write must reach the AGENT, not just the server
  // log (the D14 visibility follow-up): post a blackboard warning — db row
  // plus mirror file, so the warning itself survives future ingests. One
  // warning PER DISTINCT DECISION SCOPE, scoped to the reverted decision's
  // own scope — assemble's scope lane is bidirectional path-prefix, so a
  // "project"-scoped warning would never surface in the narrow-scope
  // assembles the gates mandate (review finding). The direct INSERT skips
  // embedding; the scope lane, not the semantic lane, is the surfacing
  // path. Non-fatal by design.
  // Read-only mode (FORMAT_VERSION_TOO_NEW): the mirror write would be
  // refused by assertWritable while the direct db INSERT is not — a db-only
  // row the next ingest's deletion propagation silently removes. Skip the
  // post entirely; the counter and log lines above still fire.
  if (stats.lifecycle_revert_details.length > 0 && !isReadOnly()) {
    const byScope = new Map<string, typeof stats.lifecycle_revert_details>();
    for (const d of stats.lifecycle_revert_details) {
      const list = byScope.get(d.scope);
      if (list) list.push(d);
      else byScope.set(d.scope, [d]);
    }
    const exporter = new RecordExporter(twiningDir);
    // Per-scope isolation: one scope's failure must not abandon the rest.
    for (const [scope, details] of byScope) {
      try {
        const detail = details
          .map((r) => `${r.id}: "${r.from}" -> "${r.to}"`)
          .join("\n");
        const entry: BlackboardEntry = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          agent_id: "twining-ingest",
          entry_type: "warning",
          tags: ["ingest", "lifecycle-revert"],
          scope,
          summary: `Ingest reverted ${details.length} decision lifecycle write(s) — the committed records tree overrode newer db state (discarded uncommitted write or branch divergence)`.slice(
            0,
            200,
          ),
          detail,
        };
        // Ping-pong dedupe INSIDE one write txn — two servers starting
        // concurrently after the same git operation must not double-post
        // (the unwrapped check-then-act hazard the relation upsert's own
        // comment names). Identity is (scope, detail) among UNRESOLVED
        // warnings: a resolved predecessor must not mask a recurrence —
        // that recurrence is exactly what this warning exists to surface.
        const inserted = withWriteTxn(db, () => {
          const duplicate = db
            .prepare(
              "SELECT data FROM blackboard WHERE entry_type = 'warning' AND scope = ?",
            )
            .all(scope)
            .map((r) => JSON.parse(r.data as string) as BlackboardEntry)
            .some(
              (e) =>
                e.tags?.includes("lifecycle-revert") &&
                e.status !== "resolved" &&
                e.detail === detail,
            );
          if (duplicate) return false;
          db.prepare(
            "INSERT INTO blackboard (id, entry_type, scope, timestamp, data) VALUES (?, ?, ?, ?, ?)",
          ).run(
            entry.id,
            entry.entry_type,
            entry.scope,
            entry.timestamp,
            JSON.stringify(entry),
          );
          return true;
        });
        if (!inserted) continue;
        try {
          exporter.post(entry);
        } catch (err) {
          // Mirror write failed: a db-only row would be silently deleted by
          // the next ingest's deletion propagation — remove it now so db
          // and tree never diverge, and surface the loss loudly.
          db.prepare("DELETE FROM blackboard WHERE id = ?").run(entry.id);
          throw err;
        }
      } catch (err) {
        console.error(
          `[twining] lifecycle-revert warning post failed for scope "${scope}" (non-fatal):`,
          err,
        );
      }
    }
  }

  return stats;
}
