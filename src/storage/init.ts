/**
 * Directory initialization for .twining/ structure.
 * Creates all directories and default files on first tool call.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { DEFAULT_CONFIG } from "../config.js";

/**
 * Create the .twining/ directory structure if it doesn't exist.
 * Silent auto-create per user decision — no user interaction.
 */
export function initTwiningDir(projectRoot: string): void {
  const twiningDir = path.join(projectRoot, ".twining");

  // If already exists, nothing to do
  if (fs.existsSync(twiningDir)) return;

  // Create directory structure (spec section 2.2)
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "graph"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "embeddings"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "archive"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "handoffs"), { recursive: true });

  // Config with project name auto-detected
  const config = {
    ...DEFAULT_CONFIG,
    project_name: path.basename(projectRoot),
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

  // Gitignore (spec section 2.3 + model cache + local runtime state)
  fs.writeFileSync(
    path.join(twiningDir, ".gitignore"),
    [
      "embeddings/*.index",
      "archive/",
      "models/",
      "metrics.jsonl",
      "pending-posts.jsonl",
      "pending-actions.jsonl",
      ".last-record",
      ".last-known-branches.json",
    ].join("\n") + "\n",
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
