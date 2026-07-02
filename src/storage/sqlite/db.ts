/**
 * SQLite database handle for the sqlite storage backend (FOUNDATION-PLAN W2.2).
 *
 * Uses the built-in `node:sqlite` (Node >= 22.13, zero native dependencies —
 * decision D6). Loaded via require so availability can be probed synchronously
 * inside createServer; on older Node the probe fails and the caller falls back
 * to the file backend with a warning. The backend is opt-in
 * (config `storage.backend: "sqlite"`) until v2.0 makes it the default.
 *
 * One database per project at .twining/twining.db, WAL mode for concurrent
 * multi-process access, busy_timeout for writer contention, and
 * PRAGMA user_version for schema migrations.
 */
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Minimal structural types for node:sqlite (still marked experimental). */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export const SQLITE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blackboard (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  entry_type TEXT NOT NULL,
  scope      TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blackboard_type ON blackboard(entry_type);
CREATE INDEX IF NOT EXISTS idx_blackboard_ts   ON blackboard(timestamp);

CREATE TABLE IF NOT EXISTS decisions (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL UNIQUE,
  status    TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);

CREATE TABLE IF NOT EXISTS entities (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS relations (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  id     TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  data   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  data     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL,
  index_data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  index_name TEXT NOT NULL,
  id         TEXT NOT NULL,
  vector     BLOB NOT NULL,
  PRIMARY KEY (index_name, id)
);
`;

/** Probe whether node:sqlite is available on this runtime. */
export function sqliteAvailable(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

/**
 * Open (creating if needed) the project database and apply the schema.
 * Throws when node:sqlite is unavailable — callers should probe first.
 */
export function openDatabase(twiningDir: string): SqliteDatabase {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(path.join(twiningDir, "twining.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const row = db.prepare("PRAGMA user_version;").get() as
    | { user_version: number | bigint }
    | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current === 0) {
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};`);
  } else if (current > SQLITE_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `twining.db schema version ${current} is newer than this release supports (${SQLITE_SCHEMA_VERSION}) — update twining-mcp.`,
    );
  }
  // current < SQLITE_SCHEMA_VERSION: future migrations run here.
  return db;
}

/**
 * Run a read-modify-write cycle inside an IMMEDIATE transaction.
 * WAL serializes individual statements, not statement PAIRS: two processes
 * can both SELECT the same row and the second UPDATE silently clobbers the
 * first's merge — a lost-update race the multiwriter soak reproduces.
 * BEGIN IMMEDIATE takes the write lock up front (waiting on busy_timeout),
 * making the whole cycle atomic across processes.
 */
export function withWriteTxn<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // connection state unknown — original error matters more
    }
    throw err;
  }
}

/**
 * Serialize a float vector to a BLOB (little-endian float64 — exact
 * round-trip parity with the JSON file backend; float32 would silently
 * perturb similarity scores across backends).
 */
export function vectorToBlob(vector: number[]): Uint8Array {
  return new Uint8Array(Float64Array.from(vector).buffer);
}

/** Deserialize a BLOB back into a float vector. */
export function blobToVector(blob: Uint8Array): number[] {
  const floats = new Float64Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / 8,
  );
  return Array.from(floats);
}
