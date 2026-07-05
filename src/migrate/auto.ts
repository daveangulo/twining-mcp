// src/migrate/auto.ts
/**
 * Opt-in startup auto-migration (v2.0 proposal V4, approved option b).
 *
 * The v2 default for legacy projects is a NUDGE, not a migration —
 * auto-running would surprise-mutate a tracked config.yml and drop a
 * records/ tree into every teammate's diff the first time one person
 * upgrades. Users opt in explicitly with TWINING_AUTO_MIGRATE=1 or
 * `storage.auto_migrate: true`.
 *
 * Runs before the MCP transport connects, but stdout is still the
 * JSON-RPC channel — console.error only. Every failure is non-fatal:
 * the session boots on the file backend and the nudge still shows.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { resolveAutoBackend } from "../storage/backend-resolve.js";
import { sqliteAvailable } from "../storage/sqlite/db.js";

export async function maybeAutoMigrate(projectRoot: string): Promise<void> {
  const twiningDir = path.join(projectRoot, ".twining");
  if (!fs.existsSync(twiningDir)) return;

  const config = loadConfig(twiningDir);
  const optedIn =
    process.env.TWINING_AUTO_MIGRATE === "1" ||
    config.storage?.auto_migrate === true;
  if (!optedIn) return;

  // An explicit backend choice always wins — auto-migrate only acts where
  // the auto-resolution would have nudged.
  if ((config.storage?.backend ?? "auto") !== "auto") return;
  if (resolveAutoBackend(twiningDir).reason !== "legacy-content") return;

  if (!sqliteAvailable()) {
    console.error(
      "[twining] auto-migrate requested but node:sqlite is unavailable " +
        "(requires Node >= 22.13) — staying on the file backend.",
    );
    return;
  }

  console.error("[twining] auto-migrate: migrating legacy files → sqlite…");
  try {
    // Loaded only when a migration actually runs — the common no-opt-in
    // startup never pays for the migrate module chain.
    const { migrateForward } = await import("./forward.js");
    const report = await migrateForward({ projectRoot, dryRun: false });
    if (report.finalized) {
      console.error("[twining] auto-migrate complete — backend is now sqlite.");
    } else {
      console.error(
        "[twining] auto-migrate did not finalize (verification failed) — " +
          "staying on the file backend. Run `npx twining-mcp migrate` manually.",
      );
    }
  } catch (err) {
    console.error(
      "[twining] auto-migrate failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
