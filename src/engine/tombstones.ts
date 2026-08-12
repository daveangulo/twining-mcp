/**
 * Dismissal tombstones (D2). Dismissal deletes the live row in both backends
 * and unlinks the exported record — the tombstone appended to the day's
 * archive file is the only surviving copy, carrying the full entry plus who
 * dismissed it and why. EVERY dismissal path must write one: a dismissal
 * without a tombstone is unrecoverable data loss (review findings: both the
 * archive_stale and housekeeping-dedup paths originally lacked one).
 *
 * The archive compactor only strips its own exact junk signature, so
 * tombstone lines are preserved. Note the tombstone is machine-local —
 * .twining/archive/ is gitignored; the propagating audit trail is whatever
 * finding the dismissing tool posts.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../storage/file-store.js";
import type { BlackboardEntry } from "../utils/types.js";

export function appendDismissalTombstones(
  twiningDir: string,
  entries: BlackboardEntry[],
  meta: { reason?: string; dismissed_by?: string },
): void {
  if (entries.length === 0) return;
  const archiveDir = path.join(twiningDir, "archive");
  ensureDir(archiveDir);
  const now = new Date().toISOString();
  const file = path.join(archiveDir, `${now.slice(0, 10)}-blackboard.jsonl`);
  const lines = entries
    .map((e) =>
      JSON.stringify({
        ...e,
        dismissed: {
          dismissed_at: now,
          ...(meta.dismissed_by ? { dismissed_by: meta.dismissed_by } : {}),
          ...(meta.reason ? { reason: meta.reason } : {}),
        },
      }),
    )
    .join("\n");
  fs.appendFileSync(file, lines + "\n");
}
