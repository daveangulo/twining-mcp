// src/migrate/config-edit.ts
/**
 * Surgical config.yml edit for migrations: set storage.backend, preserve
 * everything else, back up the original. Touches `version` only on
 * explicit request (opts.formatVersion): forward finalize stamps 2 — the
 * W0.4 mixed-team lockout that turns stale 1.x clients read-only on a
 * migrated repo — and reverse restores 1 so 1.x clients work again.
 *
 * yaml.load→dump drops comments; the caller must warn (using hadComments)
 * and point at the backup. Twining itself never writes comments.
 *
 * The backup is first-wins: if config.yml.pre-migrate.bak already exists it
 * is NOT overwritten — the first backup is the true pre-migration original,
 * and a forward-then-reverse run must not clobber it. The backup path is
 * still returned in that case.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { atomicWriteFileSync } from "../storage/file-store.js";

export interface ConfigEditResult {
  backedUpTo: string | null;
  hadComments: boolean;
}

export function setStorageBackend(
  twiningDir: string,
  backend: "files" | "sqlite",
  opts?: { formatVersion?: number },
): ConfigEditResult {
  const configPath = path.join(twiningDir, "config.yml");

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      yaml.dump({ version: opts?.formatVersion ?? 1, storage: { backend } }),
    );
    return { backedUpTo: null, hadComments: false };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const backupPath = configPath + ".pre-migrate.bak";
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
  }

  const loaded = yaml.load(raw);
  if (loaded !== null && loaded !== undefined && (typeof loaded !== "object" || Array.isArray(loaded))) {
    throw new Error(
      `config.yml is malformed (non-object YAML root) — fix or remove it; the original is backed up at ${backupPath}`,
    );
  }

  const parsed = (loaded ?? {}) as Record<string, unknown>;
  const storage = (parsed.storage ?? {}) as Record<string, unknown>;
  storage.backend = backend;
  parsed.storage = storage;
  if (opts?.formatVersion !== undefined) {
    parsed.version = opts.formatVersion;
  }
  atomicWriteFileSync(configPath, yaml.dump(parsed));

  return { backedUpTo: backupPath, hadComments: raw.includes("#") };
}
