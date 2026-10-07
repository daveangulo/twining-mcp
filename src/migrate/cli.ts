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
import fs from "node:fs";
import path from "node:path";
import { migrateForward, type MigrateReport } from "./forward.js";
import { migrateReverse } from "./reverse.js";
import { migrateToV3, migrateStatus, readIdMap } from "./v3-forward.js";
import { rollbackToV2, renderRollbackReport } from "./v3-rollback.js";
import { resolveProjectRoot } from "../utils/project-root.js";

const USAGE =
  "usage: twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse] [--to 3]\n" +
  "       twining-mcp rollback --to 2 [--project <dir>] [--dry-run]\n" +
  "       twining-mcp migrate-status [--project <dir>]\n" +
  "       twining-mcp events ls [--project <dir>] [--limit N]\n" +
  "       twining-mcp events show <event-id> [--project <dir>]";

export async function runMigrateCli(argv: string[]): Promise<number> {
  // Default root via the canonical resolver — TWINING_PROJECT and the
  // linked-worktree redirect apply here exactly as they do for the server,
  // so a migrate run inside a worktree targets the same store the server
  // uses. An explicit --project below still wins verbatim.
  let projectRoot = resolveProjectRoot([], process.env, process.cwd());
  let dryRun = false;
  let check = false;
  let reverse = false;
  let to: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project") {
      if (!argv[i + 1]) {
        console.error(`migrate: missing value for --project\n${USAGE}`);
        return 2;
      }
      projectRoot = argv[++i]!;
    } else if (arg === "--to") {
      const value = argv[i + 1];
      if (!value) {
        console.error(`migrate: missing value for --to\n${USAGE}`);
        return 2;
      }
      i += 1;
      to = Number(value);
      if (!Number.isInteger(to)) {
        console.error(`migrate: --to takes an integer format version (got ${value})\n${USAGE}`);
        return 2;
      }
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if (arg === "--reverse") reverse = true;
    else {
      console.error(`migrate: unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  // --to 3 is the v3 event-store migration; --to 2 is today's files→sqlite run
  // (the historical default). Anything else is refused rather than guessed —
  // silently reinterpreting a version number is how a store gets the wrong
  // format stamped on it.
  if (to !== null && to !== 2 && to !== 3) {
    console.error(`migrate: unsupported target format ${to} (expected 2 or 3)\n${USAGE}`);
    return 2;
  }
  // `--reverse` goes to format 1, so `--to 2 --reverse` names two different
  // targets in one invocation. Before this lane `--to` was an unknown
  // argument (exit 2), so the combination was impossible; letting `reverse`
  // quietly win would be exactly the silent reinterpretation the note above
  // refuses.
  if (to === 2 && reverse) {
    console.error(`migrate: --reverse targets format 1, not 2 — drop --to, or drop --reverse\n${USAGE}`);
    return 2;
  }
  if (to === 3) {
    if (check) {
      console.error(`migrate: --check is not supported with --to 3 (use \`twining-mcp migrate-status\`)\n${USAGE}`);
      return 2;
    }
    if (reverse) {
      console.error(`migrate: --reverse is not supported with --to 3 (use \`twining-mcp rollback --to 2\`)\n${USAGE}`);
      return 2;
    }
    return await runMigrateV3(projectRoot, dryRun);
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


// ------------------------------------------------------------------- v3 verbs

async function runMigrateV3(projectRoot: string, dryRun: boolean): Promise<number> {
  try {
    const report = await migrateToV3({ projectRoot, dryRun });
    const c = report.counts;
    console.log(`twining migrate --to 3 — ${dryRun ? "dry run" : "forward migration"}`);
    console.log(
      `  legacy files: ${c.legacy_files}  records: ${c.legacy_records}  ` +
        `created: ${c.created_events}  derived: ${c.derived_events}  ` +
        `rivals: ${c.rivals}  damaged: ${c.damaged}  conflicts: ${c.conflicts}`,
    );
    if (c.post_rollback_writes > 0) console.log(`  post-rollback writes preserved: ${c.post_rollback_writes}`);
    if (c.duplicate_suppressed > 0) console.log(`  already present (id+digest match, no new effect): ${c.duplicate_suppressed}`);
    console.log(`  manifest: ${report.manifest_path}`);
    for (const f of report.findings) console.log(`  finding: ${f.kind} ${f.subject} — ${f.detail}`);
    for (const n of report.notes) console.log(`  note: ${n}`);
    if (report.verification && !report.verification.ok) {
      console.log("  VERIFICATION FAILED — config.version was NOT changed.");
      for (const m of report.verification.missing.slice(0, 20)) console.log(`    missing: ${m}`);
      for (const m of report.verification.status_mismatched.slice(0, 20)) console.log(`    status: ${m.id} expected ${m.expected}, got ${m.actual}`);
      for (const m of report.verification.relationships_missing.slice(0, 20)) console.log(`    relationship: ${m.id} ${m.field}=${m.value}`);
      for (const m of report.verification.attachment_mismatched.slice(0, 20)) console.log(`    attachment: ${m}`);
      return 1;
    }
    if (!dryRun) {
      console.log("\n  Next steps (nothing has been committed for you):");
      console.log("    git add .twining/events .twining/attachments .twining/legacy .twining/store.json .twining/config.yml .twining/records/RECORDS-FROZEN.md");
      console.log('    git commit -m "chore: migrate .twining to the v3 event store"');
      console.log("  Teammates on 2.x go READ-ONLY on this store until they update.");
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

/** `twining-mcp rollback --to 2` — regenerate a restricted 2.x view (ADR §10.7). */
export async function runRollbackCli(argv: string[]): Promise<number> {
  let projectRoot = resolveProjectRoot([], process.env, process.cwd());
  let dryRun = false;
  let to: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project") {
      if (!argv[i + 1]) {
        console.error(`rollback: missing value for --project\n${USAGE}`);
        return 2;
      }
      projectRoot = argv[++i]!;
    } else if (arg === "--to") {
      const value = argv[i + 1];
      if (!value) {
        console.error(`rollback: missing value for --to\n${USAGE}`);
        return 2;
      }
      i += 1;
      to = Number(value);
    } else if (arg === "--dry-run") dryRun = true;
    else {
      console.error(`rollback: unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (to !== 2) {
    console.error(`rollback: --to 2 is required (got ${to === null ? "nothing" : String(to)})\n${USAGE}`);
    return 2;
  }
  try {
    const report = await rollbackToV2({ projectRoot, dryRun });
    console.log(renderRollbackReport(report));
    if (dryRun) console.log("(dry run: nothing was written)");
    return report.ok ? 0 : 1;
  } catch (err) {
    console.error(`rollback: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

/** `twining-mcp migrate-status` — the CLI face of twining_migrate_status. */
export function runMigrateStatusCli(argv: string[]): number {
  const projectRoot = projectRootFrom(argv, "migrate-status");
  if (projectRoot === null) return 2;
  try {
    const status = migrateStatus(path.join(projectRoot, ".twining"));
    console.log(JSON.stringify(status, null, 2));
    return 0;
  } catch (err) {
    console.error(`migrate-status: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function projectRootFrom(argv: string[], verb: string): string | null {
  let projectRoot = resolveProjectRoot([], process.env, process.cwd());
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") {
      if (!argv[i + 1]) {
        console.error(`${verb}: missing value for --project\n${USAGE}`);
        return null;
      }
      projectRoot = argv[++i]!;
    }
  }
  return projectRoot;
}

/**
 * `twining-mcp events ls|show` — a MINIMAL reader over events/, so a rolled-back
 * store is still inspectable (ADR §10.7 requires the retained archive to be
 * listable and readable WHILE rolled back). It reads the event files directly
 * and never opens the projection database, so it works with no database at all.
 */
export function runEventsCli(argv: string[]): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  const projectRoot = projectRootFrom(rest, "events");
  if (projectRoot === null) return 2;
  const eventsDir = path.join(projectRoot, ".twining", "events");
  if (!fs.existsSync(eventsDir)) {
    console.error("events: no .twining/events/ directory — this store is not on v3");
    return 2;
  }
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".json")) files.push(rel);
    }
  };
  walk(eventsDir, "");

  if (sub === "ls") {
    let limit = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== "--limit") continue;
      // Number("abc") is NaN and `shown >= NaN` is always false, so an
      // unvalidated limit silently prints the WHOLE archive — the opposite of
      // what the operator asked for, on a store that may hold 10k events.
      const value = Number(rest[++i]);
      if (!Number.isInteger(value) || value < 1) {
        console.error(`events: --limit takes a positive integer (got ${String(rest[i])})\n${USAGE}`);
        return 2;
      }
      limit = value;
    }
    const idMap = readIdMap(path.join(projectRoot, ".twining"));
    let shown = 0;
    for (const rel of files) {
      if (shown >= limit) break;
      try {
        const ev = JSON.parse(fs.readFileSync(path.join(eventsDir, rel), "utf8")) as Record<string, unknown>;
        const record = ev.record as { type?: string; id?: string } | undefined;
        const legacy = ev.legacy as { derived_from_legacy_snapshot?: boolean } | undefined;
        console.log(
          [
            String(ev.id),
            String(ev.kind).padEnd(12),
            (record?.type ?? "-").padEnd(10),
            record?.id ?? "-",
            String(ev.evidence_class),
            legacy?.derived_from_legacy_snapshot ? "legacy" : "",
            idMap[String(ev.id)] ? "id-mapped" : "",
          ].join("  ").trimEnd(),
        );
        shown += 1;
      } catch {
        console.log(`${rel}  (unreadable)`);
      }
    }
    console.log(`# ${files.length} event file(s) under .twining/events/`);
    return 0;
  }

  if (sub === "show") {
    const id = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--project");
    if (!id) {
      console.error(`events show: an event id is required\n${USAGE}`);
      return 2;
    }
    const match = files.find((f) => path.posix.basename(f) === `${id}.json`);
    if (!match) {
      console.error(`events show: no event ${id} under .twining/events/`);
      return 1;
    }
    console.log(fs.readFileSync(path.join(eventsDir, match), "utf8").trimEnd());
    return 0;
  }

  console.error(`events: expected \`ls\` or \`show <id>\`\n${USAGE}`);
  return 2;
}
