import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes a unix-timestamp sentinel that the pre-commit hook compares against
 * `git log -1 --format=%ct HEAD`. Any successful twining_record / twining_post /
 * twining_decide call refreshes it; the hook permits the commit when the
 * sentinel is newer than HEAD. Best-effort — never throws.
 */
export function writeRecordSentinel(twiningDir: string): void {
  try {
    writeFileSync(
      join(twiningDir, ".last-record"),
      String(Math.floor(Date.now() / 1000)),
      { encoding: "utf-8" },
    );
  } catch {
    // non-fatal: hook will fall back to deny + the user re-records, no data lost
  }
}
