/**
 * Schema migrations for twining.db (W2.3 phase 2 introduces v2:
 * embeddings.content_hash). Skipped where node:sqlite is unavailable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDatabase,
  SQLITE_SCHEMA_VERSION,
  vectorToBlob,
} from "../src/storage/sqlite/db.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

let twiningDir: string;

beforeEach(() => {
  twiningDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-migrate-"));
});

afterEach(() => {
  fs.rmSync(twiningDir, { recursive: true, force: true });
});

/** Hand-build a v1 database: the pre-phase-2 embeddings table, version 1. */
function createV1Db(): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...p: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(path.join(twiningDir, "twining.db"));
  db.exec(`
    CREATE TABLE embeddings (
      index_name TEXT NOT NULL,
      id         TEXT NOT NULL,
      vector     BLOB NOT NULL,
      PRIMARY KEY (index_name, id)
    );
  `);
  db.prepare(
    "INSERT INTO embeddings (index_name, id, vector) VALUES (?, ?, ?)",
  ).run("blackboard", "pre-v2-row", vectorToBlob([1, 2, 3]));
  db.exec("PRAGMA user_version = 1;");
  db.close();
}

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table});`)
    .all()
    .map((r) => r.name as string);
}

describe.skipIf(!HAS_SQLITE)("twining.db schema migration", () => {
  it("fresh databases are created at the current version with content_hash", () => {
    const db = openDatabase(twiningDir);
    expect(columns(db, "embeddings")).toContain("content_hash");
    const row = db.prepare("PRAGMA user_version;").get() as {
      user_version: number | bigint;
    };
    expect(Number(row.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    db.close();
  });

  it("migrates v1 → v2: adds content_hash, keeps rows, bumps user_version", () => {
    createV1Db();
    const db = openDatabase(twiningDir);
    expect(columns(db, "embeddings")).toContain("content_hash");
    const row = db
      .prepare("SELECT id, content_hash FROM embeddings WHERE id = ?")
      .get("pre-v2-row") as { id: string; content_hash: string | null };
    expect(row.id).toBe("pre-v2-row");
    expect(row.content_hash).toBeNull(); // backfilled later by the reconciler
    const v = db.prepare("PRAGMA user_version;").get() as {
      user_version: number | bigint;
    };
    expect(Number(v.user_version)).toBe(2);
    db.close();
  });

  it("re-opening a migrated database is a no-op (idempotent)", () => {
    createV1Db();
    openDatabase(twiningDir).close();
    const db = openDatabase(twiningDir); // second open must not re-ALTER
    expect(columns(db, "embeddings")).toContain("content_hash");
    db.close();
  });

  it("still refuses databases newer than this release", () => {
    const db = openDatabase(twiningDir);
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1};`);
    db.close();
    expect(() => openDatabase(twiningDir)).toThrow(/newer than this release/);
  });
});
