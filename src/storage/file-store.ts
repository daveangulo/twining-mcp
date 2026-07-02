/**
 * Low-level file I/O with advisory locking and atomic writes.
 * All writes use proper-lockfile for concurrent safety and go through
 * atomicWriteFileSync (temp file + rename) so a crash mid-write can never
 * leave a truncated data file.
 * Engine and store modules use these — never direct fs calls.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { TwiningError } from "../utils/errors.js";

/**
 * Shared advisory-lock options for every file-backed store.
 * The cumulative retry budget (~24s) MUST exceed `stale` (10s): when a
 * process dies while holding a lock, waiters need to outlast the stale
 * window so they can steal the dead lock instead of throwing ELOCKED —
 * a failure mode the multiwriter soak's kill test reproduces.
 */
export const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 12, factor: 2, minTimeout: 100, maxTimeout: 3000 },
  stale: 10000,
  onCompromised: (err) => {
    console.error("[twining] Lock compromised:", err.message);
  },
};

/**
 * Read-only mode: set at startup when the on-disk .twining/ format is newer
 * than this server supports (config.version > SUPPORTED_CONFIG_VERSION).
 * Reads keep working; every write refuses with FORMAT_VERSION_TOO_NEW so a
 * stale client can never diverge a migrated project.
 */
let readOnlyReason: string | null = null;

export function enterReadOnlyMode(reason: string): void {
  readOnlyReason = reason;
}

/** Test-only escape hatch — module state would otherwise leak across tests. */
export function exitReadOnlyMode(): void {
  readOnlyReason = null;
}

export function isReadOnly(): boolean {
  return readOnlyReason !== null;
}

function assertWritable(): void {
  if (readOnlyReason !== null) {
    throw new TwiningError(readOnlyReason, "FORMAT_VERSION_TOO_NEW");
  }
}

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. Rename is atomic on POSIX, so readers observe
 * either the old content or the new content — never a torn write, even if
 * the process is killed mid-write.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  assertWritable();
  const tmpPath = `${filePath}.${process.pid}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup — the original error is what matters
    }
    throw err;
  }
}

/**
 * Create a file if and only if it does not exist yet (exclusive create).
 * The naive `if (!existsSync) writeFileSync(...)` has a cross-process race:
 * B can pass the existence check before A's file appears, then B's
 * initializer write clobbers data A committed in between — a lost-update
 * bug the multiwriter soak reproduces. O_EXCL makes creation atomic.
 */
export function ensureFileExists(filePath: string, initial = ""): void {
  try {
    fs.writeFileSync(filePath, initial, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Read and parse a JSON file. Throws if file doesn't exist.
 * Retries once on a parse failure: with rename-based writes a torn read is
 * impossible, but this guards against files last written by older releases.
 */
export async function readJSON<T>(filePath: string): Promise<T> {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  }
}

/** Write JSON to file atomically under advisory lock. */
export async function writeJSON(
  filePath: string,
  data: unknown,
): Promise<void> {
  assertWritable();
  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure file exists for proper-lockfile (it locks based on file existence)
  ensureFileExists(filePath);
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
  } finally {
    await release();
  }
}

/** Append a single JSON object as a line to a JSONL file under advisory lock. */
export async function appendJSONL(
  filePath: string,
  data: unknown,
): Promise<void> {
  assertWritable();
  // Ensure file exists for locking
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  ensureFileExists(filePath);
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
  } finally {
    await release();
  }
}

/**
 * Read a JSONL file and parse each line.
 * Corrupt lines are skipped with a warning to stderr.
 * No locking needed for reads — appends are line-buffered and whole-file
 * rewrites are atomic renames, so a line is either absent, complete, or
 * (at worst, for a torn append tail) skipped by the parse guard below.
 */
export async function readJSONL<T>(filePath: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const results: T[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      console.error(
        `[twining] Skipping corrupt JSONL line in ${path.basename(filePath)}`,
      );
    }
  }
  return results;
}

/**
 * Overwrite a JSONL file atomically under lock.
 * Used by archiver to rewrite blackboard after removing archived entries.
 */
export async function writeJSONL(
  filePath: string,
  data: unknown[],
): Promise<void> {
  assertWritable();
  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure file exists for proper-lockfile
  ensureFileExists(filePath);
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    const content =
      data.length > 0
        ? data.map((item) => JSON.stringify(item)).join("\n") + "\n"
        : "";
    atomicWriteFileSync(filePath, content);
  } finally {
    await release();
  }
}

/** Ensure a directory exists, creating it recursively if needed. */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
