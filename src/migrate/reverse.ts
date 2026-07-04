// src/migrate/reverse.ts
/**
 * Reverse migration (FOUNDATION-PLAN W3: "the reverse export path so
 * nobody is locked in"): sqlite backend → file backend.
 *
 * The committed records/ tree is the durable truth (design D1), so the
 * db is first converged to it (ordinary ingest), then the file-backend
 * layout is written wholesale from the sqlite read model. EXCEPTION:
 * when the project runs with storage.export_records disabled, sqlite-era
 * records were never mirrored into records/ — the db is the only complete
 * state and the stale tree must NOT be ingested (deletion propagation
 * would drop every unmirrored row before export). In that configuration
 * ingest is skipped and the export comes from the database alone.
 * The layout written:
 *
 *   blackboard.jsonl            one JSON line per entry, insertion order
 *   decisions/<id>.json          + decisions/index.json (from getIndex())
 *   graph/entities.json, graph/relations.json
 *   handoffs/<id>.json           + handoffs/index.jsonl (from index_data)
 *
 * Existing file-layout paths are copied to .twining/pre-reverse-backup/
 * before being overwritten. records/ and twining.db are left in place —
 * deleting committed state is not this tool's call — but the tree FREEZES
 * at this point: the CLI prints the warning note that returning to sqlite
 * later requires re-running `twining-mcp migrate` (or removing the tree),
 * or startup ingest would resurrect the frozen tree over newer records.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { atomicWriteFileSync, ensureDir } from "../storage/file-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import {
  SqliteBlackboardStore,
  SqliteDecisionStore,
  SqliteGraphStore,
  SqliteHandoffStore,
} from "../storage/sqlite/sqlite-stores.js";
import { openDatabase, sqliteAvailable } from "../storage/sqlite/db.js";
import { ingestRecords } from "../storage/sync/record-ingest.js";
import { setStorageBackend } from "./config-edit.js";
import { verifyContains, type ReadModelStores } from "./verify.js";
import type { ForwardOptions, MigrateReport } from "./forward.js";

export async function migrateReverse(
  opts: Omit<ForwardOptions, "checkOnly">,
): Promise<MigrateReport> {
  const twiningDir = path.join(opts.projectRoot, ".twining");
  if (!fs.existsSync(twiningDir)) {
    throw new Error(`no .twining/ directory at ${twiningDir} — nothing to migrate`);
  }
  if (!sqliteAvailable()) {
    throw new Error(
      "node:sqlite is unavailable (requires Node >= 22.13) — cannot read the sqlite state to reverse it",
    );
  }
  const hasDb = fs.existsSync(path.join(twiningDir, "twining.db"));
  const hasTree = fs.existsSync(path.join(twiningDir, "records"));
  if (!hasDb && !hasTree) {
    throw new Error(
      "no sqlite state found (neither twining.db nor records/) — nothing to reverse",
    );
  }

  const notes = [
    "records/ tree and twining.db are left in place but FROZEN — re-run `twining-mcp migrate` before switching back to sqlite, or remove .twining/records/",
    "file-backend embedding indexes are not rebuilt; search uses keyword fallback for unembedded records",
    "stop running Twining sessions before migrating — the backend flip does not coordinate with live server processes",
  ];

  // With export_records disabled, sqlite-era records have no files in
  // records/ — ingesting the stale tree would delete their rows before the
  // export. The db is the only complete state; export from it alone.
  const config = loadConfig(twiningDir);
  // Re-run guard: config only flips at finalize, so a mid-failure re-run
  // still sees backend "sqlite" and is allowed; "files" means a completed
  // reverse (or a project that never migrated) — nothing to do.
  if (config.storage?.backend === "files") {
    throw new Error(
      "storage.backend is already 'files' — nothing to reverse; if you want to return to sqlite, run twining-mcp migrate (without --reverse)",
    );
  }
  const exportOff = config.storage?.export_records === false;
  if (exportOff) {
    notes.push(
      "export_records is disabled — records/ tree ignored; exporting from the database alone",
    );
  }

  const db = openDatabase(twiningDir);
  try {
    // Tree is truth (except export-off): converge the db to it before exporting.
    if (!exportOff) ingestRecords(db, twiningDir);

    const sqlite: ReadModelStores = {
      blackboardStore: new SqliteBlackboardStore(db),
      decisionStore: new SqliteDecisionStore(db),
      graphStore: new SqliteGraphStore(db),
      handoffStore: new SqliteHandoffStore(db),
    };

    const entries = (await sqlite.blackboardStore.read()).entries;
    const decisionIndex = await sqlite.decisionStore.getIndex();
    const entities = await sqlite.graphStore.getEntities();
    const relations = await sqlite.graphStore.getRelations();
    const handoffIndex = await sqlite.handoffStore.list({});
    const counts = {
      posts: entries.length,
      decisions: decisionIndex.length,
      entities: entities.length,
      relations: relations.length,
      handoffs: handoffIndex.length,
    };

    if (opts.dryRun) {
      return {
        ok: true, counts, missing: [], mismatched: [],
        dryRun: true, verified: false, finalized: false,
        configBackup: null, configHadComments: false, notes,
        orphans_salvaged: 0,
      };
    }

    // Back up the file-layout paths this run overwrites. Deliberately
    // LAST-WINS ("what this run is about to overwrite" — the undo of the
    // latest reverse), unlike config-edit's first-wins .pre-migrate.bak
    // ("the original before any migration") — different semantics, don't
    // unify them.
    const backupDir = path.join(twiningDir, "pre-reverse-backup");
    ensureDir(backupDir);
    for (const rel of ["blackboard.jsonl", "decisions", "graph", "handoffs"]) {
      const src = path.join(twiningDir, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(backupDir, rel), { recursive: true, force: true });
      }
    }

    // Write the file-backend layout from the sqlite read model.
    atomicWriteFileSync(
      path.join(twiningDir, "blackboard.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
    );

    ensureDir(path.join(twiningDir, "decisions"));
    for (const ix of decisionIndex) {
      const decision = await sqlite.decisionStore.get(ix.id);
      if (decision) {
        atomicWriteFileSync(
          path.join(twiningDir, "decisions", `${decision.id}.json`),
          JSON.stringify(decision, null, 2),
        );
      }
    }
    atomicWriteFileSync(
      path.join(twiningDir, "decisions", "index.json"),
      JSON.stringify(decisionIndex, null, 2),
    );

    ensureDir(path.join(twiningDir, "graph"));
    atomicWriteFileSync(
      path.join(twiningDir, "graph", "entities.json"),
      JSON.stringify(entities, null, 2),
    );
    atomicWriteFileSync(
      path.join(twiningDir, "graph", "relations.json"),
      JSON.stringify(relations, null, 2),
    );

    ensureDir(path.join(twiningDir, "handoffs"));
    for (const ix of handoffIndex) {
      const record = await sqlite.handoffStore.get(ix.id);
      if (record) {
        atomicWriteFileSync(
          path.join(twiningDir, "handoffs", `${record.id}.json`),
          JSON.stringify(record, null, 2),
        );
      }
    }
    // Byte-exact reproduction of the stored index rows: handoffIndex from
    // list({}) would be the abstraction-respecting equivalent, but verbatim
    // bytes keep the reversed file identical to what the sqlite store
    // maintained.
    const indexRows = db
      .prepare("SELECT index_data FROM handoffs ORDER BY seq")
      .all()
      .map((r) => r.index_data as string);
    atomicWriteFileSync(
      path.join(twiningDir, "handoffs", "index.jsonl"),
      indexRows.join("\n") + (indexRows.length ? "\n" : ""),
    );

    // Verify: everything sqlite can read is now in the file layout.
    const files: ReadModelStores = {
      blackboardStore: new BlackboardStore(twiningDir),
      decisionStore: new DecisionStore(twiningDir),
      graphStore: new GraphStore(twiningDir),
      handoffStore: new HandoffStore(twiningDir),
    };
    const verdict = await verifyContains(sqlite, files);
    if (!verdict.ok) {
      return {
        ...verdict, dryRun: false, verified: false, finalized: false,
        configBackup: null, configHadComments: false, notes,
        orphans_salvaged: 0,
      };
    }

    const edit = setStorageBackend(twiningDir, "files");
    return {
      ...verdict, dryRun: false, verified: true, finalized: true,
      configBackup: edit.backedUpTo, configHadComments: edit.hadComments, notes,
      orphans_salvaged: 0,
    };
  } finally {
    db.close();
  }
}
