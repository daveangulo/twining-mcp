/**
 * Directory initialization for .twining/ structure.
 * Creates all directories and default files on first tool call.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { DEFAULT_CONFIG, SUPPORTED_CONFIG_VERSION } from "../config.js";
// Safe to import statically on any Node version: node:sqlite is only
// required inside sqliteAvailable(), never at module load.
import { sqliteAvailable } from "./sqlite/db.js";

/**
 * Canonical .twining/.gitignore entries (spec section 2.3 + model cache +
 * local runtime state). Fresh stores get the full list; existing stores are
 * reconciled additively on every startup (#44) — entries added in later
 * releases (.last-record was the field casualty: 137 commits of churn plus
 * a stale committed sentinel on fresh clones) never reached old stores.
 */
const GITIGNORE_ENTRIES = [
  "embeddings/*.index",
  "archive/",
  "models/",
  "metrics.jsonl",
  "pending-posts.jsonl",
  "pending-actions.jsonl",
  ".last-record",
  ".last-known-branches.json",
  ".sessions/",
  "twining.db",
  "twining.db-wal",
  "twining.db-shm",
];

/**
 * Additively reconcile .twining/.gitignore with the canonical entry list:
 * append missing canonical entries, never remove or reorder user lines.
 * Creates the file if absent. gitignore cannot untrack an already-tracked
 * file — stores that committed .last-record also need a one-time
 * `git rm --cached .twining/.last-record` (documented in the CHANGELOG).
 */
function reconcileGitignore(twiningDir: string): void {
  const gitignorePath = path.join(twiningDir, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // Missing — created below with whatever entries are needed.
  }
  const existingLines = new Set(
    existing.split("\n").map((l) => l.trim()),
  );
  const missing = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length === 0) return;

  const prefix =
    existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, prefix + missing.join("\n") + "\n");
}

/**
 * Create the .twining/ directory structure if it doesn't exist.
 * Silent auto-create per user decision — no user interaction.
 */
export function initTwiningDir(projectRoot: string): void {
  const twiningDir = path.join(projectRoot, ".twining");

  // Already exists — reconcile the gitignore (#44), nothing else to do.
  if (fs.existsSync(twiningDir)) {
    reconcileGitignore(twiningDir);
    return;
  }

  // Create directory structure (spec section 2.2)
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "graph"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "embeddings"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "archive"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "handoffs"), { recursive: true });

  // Config with project name auto-detected. The backend choice is stamped
  // explicitly — visible and committed, never left to runtime resolution —
  // and stamped as what will actually run on this machine: an old-Node
  // creator must not label a files-fallback project "sqlite" and hand a
  // new-Node teammate an empty database next to real legacy files. The
  // format version rides the backend: v2 for sqlite-era projects (locks
  // stale 1.x clients read-only), v1 for files so 1.x teammates still work.
  const backend = sqliteAvailable() ? "sqlite" : "files";
  const config = {
    ...DEFAULT_CONFIG,
    version: backend === "sqlite" ? SUPPORTED_CONFIG_VERSION : 1,
    project_name: path.basename(projectRoot),
    storage: { ...DEFAULT_CONFIG.storage, backend },
  };
  fs.writeFileSync(path.join(twiningDir, "config.yml"), yaml.dump(config));

  // Empty data files
  fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
  fs.writeFileSync(
    path.join(twiningDir, "decisions", "index.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(twiningDir, "graph", "entities.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(twiningDir, "graph", "relations.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(twiningDir, "agents", "registry.json"),
    JSON.stringify([], null, 2),
  );

  // Gitignore — canonical list shared with the existing-store reconcile.
  fs.writeFileSync(
    path.join(twiningDir, ".gitignore"),
    GITIGNORE_ENTRIES.join("\n") + "\n",
  );

  // Merge attributes: blackboard.jsonl is append-only, so concurrent
  // branches both appending at the tail should union-merge, not conflict.
  fs.writeFileSync(
    path.join(twiningDir, ".gitattributes"),
    "blackboard.jsonl merge=union\n",
  );
}

/**
 * Ensure .twining/ is initialized. Returns the .twining/ path.
 */
export function ensureInitialized(projectRoot: string): string {
  initTwiningDir(projectRoot);
  return path.join(projectRoot, ".twining");
}
