/**
 * Low-level file I/O with advisory locking.
 * All writes use proper-lockfile for concurrent safety.
 * Engine and store modules use these — never direct fs calls.
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10000,
  onCompromised: (err) => {
    console.error("[twining] Lock compromised:", err.message);
  },
};

/** Read and parse a JSON file. Throws if file doesn't exist. */
export async function readJSON<T>(filePath: string): Promise<T> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/** Write JSON to file under advisory lock. */
export async function writeJSON(
  filePath: string,
  data: unknown,
): Promise<void> {
  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure file exists for proper-lockfile (it locks based on file existence)
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "");
  }
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } finally {
    await release();
  }
}

/** Append a single JSON object as a line to a JSONL file under advisory lock. */
export async function appendJSONL(
  filePath: string,
  data: unknown,
): Promise<void> {
  // Ensure file exists for locking
  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, "");
  }
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
 * No locking needed for reads.
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
  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure file exists for proper-lockfile
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "");
  }
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    const content =
      data.length > 0
        ? data.map((item) => JSON.stringify(item)).join("\n") + "\n"
        : "";
    fs.writeFileSync(filePath, content);
  } finally {
    await release();
  }
}

/** Ensure a directory exists, creating it recursively if needed. */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
