// src/migrate/cli.ts
/**
 * `twining-mcp migrate` — explicit backend migration for existing installs.
 *
 *   twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]
 *
 * Exit codes: 0 success / check passed · 1 verification failed · 2 usage or
 * environment error. Runs as a plain CLI (stdout is fine here — the MCP
 * stdio rule applies only to the server path, which this never enters).
 * Never auto-commits: it prints the git commands instead.
 */
import { migrateForward, type MigrateReport } from "./forward.js";
import { migrateReverse } from "./reverse.js";

const USAGE =
  "usage: twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]";

export async function runMigrateCli(argv: string[]): Promise<number> {
  let projectRoot = process.cwd();
  let dryRun = false;
  let check = false;
  let reverse = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project") {
      if (!argv[i + 1]) {
        console.error(`migrate: missing value for --project\n${USAGE}`);
        return 2;
      }
      projectRoot = argv[++i]!;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if (arg === "--reverse") reverse = true;
    else {
      console.error(`migrate: unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  // Reject incompatible combos at parse time — silently reinterpreting them
  // is worse than refusing: --reverse has no check mode (it would run a REAL
  // finalizing reverse while printing "check"), and a dry-run check verifies
  // nothing (dry-run never touches the db the check would read).
  if (reverse && check) {
    console.error(`migrate: --check is not supported with --reverse\n${USAGE}`);
    return 2;
  }
  if (dryRun && check) {
    console.error(`migrate: --check and --dry-run are mutually exclusive\n${USAGE}`);
    return 2;
  }

  try {
    const report = reverse
      ? await migrateReverse({ projectRoot, dryRun })
      : await migrateForward({ projectRoot, dryRun, checkOnly: check });
    printReport(report, { reverse, check, dryRun });
    if (check) return report.verified ? 0 : 1;
    if (dryRun) return 0;
    return report.verified && report.finalized ? 0 : 1;
  } catch (err) {
    console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function printReport(
  report: MigrateReport,
  mode: { reverse: boolean; check: boolean; dryRun: boolean },
): void {
  const direction = mode.reverse ? "sqlite → files" : "files → sqlite";
  const verb = mode.check ? "check" : mode.dryRun ? "dry-run" : "migration";
  console.log(`twining-mcp migrate — ${direction} ${verb}`);
  console.log(
    `  posts: ${report.counts.posts}  decisions: ${report.counts.decisions}  ` +
      `entities: ${report.counts.entities}  relations: ${report.counts.relations}  ` +
      `handoffs: ${report.counts.handoffs}`,
  );
  for (const note of report.notes) console.log(`  note: ${note}`);

  if (mode.dryRun) {
    console.log("  dry-run: nothing written. Re-run without --dry-run to migrate.");
    return;
  }
  if (!report.verified) {
    if (mode.check && report.missing.length === 0 && report.mismatched.length === 0) {
      // "not migrated" shape — the note above already explains it.
      return;
    }
    console.log("  VERIFICATION FAILED — config.yml was NOT changed.");
    for (const m of report.missing.slice(0, 20)) console.log(`    missing: ${m}`);
    for (const m of report.mismatched.slice(0, 20)) console.log(`    mismatched: ${m}`);
    const more =
      Math.max(0, report.missing.length - 20) +
      Math.max(0, report.mismatched.length - 20);
    if (more > 0) console.log(`    …and ${more} more`);
    return;
  }
  if (mode.check) {
    console.log("  check passed: target contains every source record.");
    return;
  }

  console.log(`  verified ✓  config.yml storage.backend → ${mode.reverse ? "files" : "sqlite"}`);
  if (report.configBackup) console.log(`  previous config backed up to ${report.configBackup}`);
  if (report.configHadComments) {
    console.log("  WARNING: config.yml contained comments; yaml rewrite drops them (see backup).");
  }
  if (mode.reverse) {
    console.log(
      "  WARNING: .twining/records/ and twining.db are now FROZEN. Before ever switching\n" +
        "  back to the sqlite backend, re-run `twining-mcp migrate` (or remove .twining/records/),\n" +
        "  otherwise startup ingest would resurrect this frozen tree over newer records.",
    );
  } else {
    console.log(
      "\n  Next steps (nothing has been committed for you):\n" +
        "    git add .twining/records .twining/config.yml .twining/.gitignore\n" +
        '    git commit -m "chore: migrate .twining to the sqlite backend"\n' +
        "  Teammates should update twining-mcp before pulling this commit.\n" +
        "  Stop any running twining sessions and restart them to pick up the new backend.",
    );
  }
}
