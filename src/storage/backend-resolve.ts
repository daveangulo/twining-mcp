/**
 * v2 default-backend resolution (proposal V2): when config.yml has no
 * explicit storage.backend (merged default "auto"), pick the backend by
 * inspecting the .twining/ directory:
 *
 *   1. sqlite state present (a REAL twining.db — nonzero size with the
 *      SQLite magic header — or any file under records/) → "sqlite": an
 *      already-migrated or sqlite-era project. A 0-byte or garbage
 *      twining.db (crash, disk-full, interrupted migration) is NOT state:
 *      the 2026-08-15 field audit found three stores reading as empty
 *      because a bare existence test selected sqlite beside 1,342 unread
 *      legacy decisions.
 *   2. legacy content present and no sqlite state → "files": the flip
 *      must never boot an empty database next to real legacy state
 *      (silent amnesia). The caller nudges toward `twining-mcp migrate`.
 *   3. nothing yet → "sqlite": new projects land on v2's default.
 *
 * Ambiguity rule: any unreadable or malformed legacy file counts as
 * legacy CONTENT — misdetection must land on "files" (safe), never on
 * an empty database.
 */
import fs from "node:fs";
import path from "node:path";

export interface AutoResolution {
  backend: "files" | "sqlite";
  reason: "sqlite-state" | "legacy-content" | "fresh";
}

export function resolveAutoBackend(twiningDir: string): AutoResolution {
  if (hasSqliteState(twiningDir)) {
    return { backend: "sqlite", reason: "sqlite-state" };
  }
  if (hasLegacyContent(twiningDir)) {
    return { backend: "files", reason: "legacy-content" };
  }
  return { backend: "sqlite", reason: "fresh" };
}

function hasSqliteState(twiningDir: string): boolean {
  if (isRealSqliteDb(path.join(twiningDir, "twining.db"))) return true;
  const records = path.join(twiningDir, "records");
  if (!fs.existsSync(records)) return false;
  return dirHasAnyFile(records);
}

const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Existence is not state: only a file that could actually hold rows counts.
 * Anything unreadable or headerless falls through to legacy detection, per
 * the ambiguity rule above — misdetection must land on "files", never on
 * an empty database.
 */
function isRealSqliteDb(dbPath: string): boolean {
  try {
    if (fs.statSync(dbPath).size < SQLITE_MAGIC.length) return false;
    const fd = fs.openSync(dbPath, "r");
    try {
      const buf = Buffer.alloc(SQLITE_MAGIC.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("latin1") === SQLITE_MAGIC;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function dirHasAnyFile(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && dirHasAnyFile(path.join(dir, entry.name))) {
      return true;
    }
  }
  return false;
}

export function hasLegacyContent(twiningDir: string): boolean {
  const blackboard = path.join(twiningDir, "blackboard.jsonl");
  if (fs.existsSync(blackboard)) {
    try {
      if (fs.readFileSync(blackboard, "utf-8").trim().length > 0) return true;
    } catch {
      return true;
    }
  }

  const decisionsDir = path.join(twiningDir, "decisions");
  if (fs.existsSync(decisionsDir)) {
    try {
      for (const name of fs.readdirSync(decisionsDir)) {
        if (name === "index.json") {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(decisionsDir, name), "utf-8"),
          );
          if (Array.isArray(parsed) && parsed.length > 0) return true;
        } else if (name.endsWith(".json")) {
          // Stray decision files count even when the index is empty —
          // the field-observed index desync must not read as "fresh".
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  for (const relPath of [
    path.join("graph", "entities.json"),
    path.join("graph", "relations.json"),
  ]) {
    const file = path.join(twiningDir, relPath);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) return true;
    } catch {
      return true;
    }
  }

  return false;
}
