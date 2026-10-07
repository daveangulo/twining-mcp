/**
 * The v3 event store's own SQLite database (lane 02, ADR §8.1).
 *
 * Deliberately a SEPARATE file from `.twining/twining.db`: this is the v3
 * projection + journal + admission log + outbox, and it must be droppable
 * (`rm events.db` → `rebuild()`) without touching the v2 store or its schema.
 * Everything here is derived — the durable truth is the event files under
 * `.twining/events/`.
 *
 * node:sqlite only (Node >= 22.13, zero native dependencies), opened with the
 * same WAL + busy_timeout + BEGIN IMMEDIATE pattern as src/storage/sqlite/db.ts.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

export const EVENTS_SCHEMA_VERSION = 3;

/**
 * journal: one row per (event id, digest) OFFERED to this replica.
 *
 * Keying on (id, digest) rather than id alone is what makes a conflicting
 * duplicate representable at all: the second row is retained as evidence with
 * state `rejected`/`conflicting_duplicate` while the first row — the one that
 * owns the id, `canonical = 1` — is never touched (ADR §1.2, R07).
 *
 * `state` carries the ADMISSION ladder only (local_persisted | received |
 * pending_parents | admitted | quarantined | rejected | projected). The
 * transfer ladder (exported | transferred) lives per transport in `outbox`,
 * because R08 forbids collapsing the two (C10 A11, C14 A-RCP1).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  id             TEXT NOT NULL,
  digest         TEXT NOT NULL,
  canonical      INTEGER NOT NULL DEFAULT 1,
  kind           TEXT NOT NULL,
  record_id      TEXT,
  record_type    TEXT,
  scope          TEXT NOT NULL,
  principal      TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  parents        TEXT NOT NULL,
  file           TEXT NOT NULL,
  /**
   * The event's exact stored bytes, cached in the journal (schema v2).
   *
   * Without this the projection re-read every admitted event FROM THE FILE, so
   * a shallow/sparse checkout or a 'reset --hard' that removed event files made
   * those records vanish at the next project() — a silent revoke, and exactly
   * what ADR §8.2 promises cannot happen ("the local journal retains every
   * admitted event"). The cache is derived like everything else here: rebuild()
   * still replays the FILES, and an event whose file is gone at rebuild time is
   * honestly reported as lost rather than resurrected from this column.
   */
  envelope       TEXT,
  /** 1 when this event's payload was destroyed locally by purge (C20). */
  purged         INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL,
  reason         TEXT,
  pending_on     TEXT,
  first_seen     TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 1,
  admissions     INTEGER NOT NULL DEFAULT 0,
  duplicate_suppressed INTEGER NOT NULL DEFAULT 0,
  conflict_rejected    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, digest)
);
CREATE INDEX IF NOT EXISTS idx_journal_state  ON journal(state);
CREATE INDEX IF NOT EXISTS idx_journal_record ON journal(record_id);

CREATE TABLE IF NOT EXISTS admission_log (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  digest   TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  reason   TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admission_event ON admission_log(event_id);

CREATE TABLE IF NOT EXISTS projections (
  record_id TEXT PRIMARY KEY,
  data      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  principal TEXT PRIMARY KEY,
  data      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  transport  TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  digest     TEXT NOT NULL,
  state      TEXT NOT NULL,
  carrier_id TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  acked      INTEGER NOT NULL DEFAULT 0,
  uncertain  INTEGER NOT NULL DEFAULT 0,
  uncertain_windows TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (transport, event_id)
);

/**
 * Which carrier representations delivered an event (C14 A-EV4/A-EV7).
 * Projection state on the admission log, never a field of the immutable
 * envelope (lead ruling, conflict 6): a rewrite adds a representation, it
 * never mints an event.
 */
CREATE TABLE IF NOT EXISTS representations (
  event_id   TEXT NOT NULL,
  carrier    TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  reachable  INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (event_id, carrier, carrier_id)
);

/**
 * One row per IMPORT ATTEMPT of an artifact that was not a well-formed event
 * (C17 'ingest_attempts'): a truncated part, a merge-conflicted file, a batch
 * that arrived incomplete, an envelope from a newer client.
 *
 * Keyed on the sha256 of the observed bytes, so a byte-identical re-ingest is
 * the SAME attempt with a higher retry count — never a second entry (C17 A15) —
 * and the original bytes stay retrievable at their original hash (A16).
 */
CREATE TABLE IF NOT EXISTS ingest_attempts (
  artifact_id    TEXT PRIMARY KEY,
  carrier        TEXT NOT NULL,
  carrier_id     TEXT,
  disposition    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  observed_bytes INTEGER NOT NULL,
  declared_bytes INTEGER,
  completeness   TEXT,
  bytes_file     TEXT NOT NULL,
  retry_count    INTEGER NOT NULL DEFAULT 1,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  detail         TEXT
);

/**
 * Batches the store knows are unresolved (C17 §5.4): while one is open, any
 * answer served from a locally-held version carries a fallback marker naming
 * it, and no consequential action qualifies from that version.
 */
CREATE TABLE IF NOT EXISTS pending_imports (
  batch_id     TEXT PRIMARY KEY,
  carrier      TEXT NOT NULL,
  reason       TEXT NOT NULL,
  missing      TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  opened_at    TEXT NOT NULL,
  resolved_at  TEXT
);

/**
 * Local destructive operations (C20): purge removes the local bytes and keeps a
 * tombstone; forget removes only the projection row. Both are LOCAL acts — the
 * tombstone event is what propagates — so they live beside the derived index
 * and are enumerated by the erasure report rather than inferred from absence.
 */
CREATE TABLE IF NOT EXISTS local_erasures (
  record_id TEXT NOT NULL,
  op        TEXT NOT NULL,
  at        TEXT NOT NULL,
  detail    TEXT,
  PRIMARY KEY (record_id, op)
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function eventsDbPath(twiningDir: string): string {
  return path.join(twiningDir, "store", "events.db");
}

/** Open (creating if needed) `<twiningDir>/store/events.db` and apply the schema. */
export function openEventsDatabase(twiningDir: string): SqliteDatabase {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDatabase };
  const file = eventsDbPath(twiningDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const row = db.prepare("PRAGMA user_version;").get() as { user_version: number | bigint } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current === 0) db.exec(`PRAGMA user_version = ${EVENTS_SCHEMA_VERSION};`);
  else if (current > EVENTS_SCHEMA_VERSION) {
    db.close();
    throw new Error(`events.db schema version ${current} is newer than this build supports (${EVENTS_SCHEMA_VERSION})`);
  } else if (current < EVENTS_SCHEMA_VERSION) {
    // v1 → v2: the journal gains its envelope cache. CREATE TABLE IF NOT EXISTS
    // leaves an existing table alone, so the column is added explicitly; a v1
    // row simply has NULL there and falls back to reading its file, which is
    // the pre-v2 behaviour rather than a failure.
    const cols = db.prepare("PRAGMA table_info(journal);").all() as Array<{ name: string }>;
    if (!cols.some((c) => String(c.name) === "envelope")) db.exec("ALTER TABLE journal ADD COLUMN envelope TEXT;");
    // v2 → v3: the purge marker. A row without it is simply not purged.
    if (!cols.some((c) => String(c.name) === "purged")) db.exec("ALTER TABLE journal ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;");
    db.exec(`PRAGMA user_version = ${EVENTS_SCHEMA_VERSION};`);
  }
  return db;
}

/** Read-modify-write inside an IMMEDIATE transaction (see src/storage/sqlite/db.ts). */
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
      /* connection state unknown — the original error matters more */
    }
    throw err;
  }
}

/** Remove the derived database and its WAL sidecars (rebuild()'s first step). */
export function dropEventsDatabase(twiningDir: string): void {
  const file = eventsDbPath(twiningDir);
  for (const p of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* best effort — a missing file is the desired end state anyway */
    }
  }
}
