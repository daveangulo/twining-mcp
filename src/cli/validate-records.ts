/**
 * `twining-mcp validate-records` — read-only preflight for the committed
 * records mirror (2.16.1; plan docs/plans/2026-09-05-cross-host-sync-plan.md §4.1).
 *
 *   twining-mcp validate-records [--project <dir>] [--json]
 *
 * Checks every *.json under .twining/records/: non-empty, no conflict
 * markers, parses, `id` is a string equal to the filename stem. In a git
 * repository also reports tracked hygiene: *.tmp under .twining/, twining.db*
 * tracked (both fail), and — on a sqlite-era store — which frozen v1
 * aggregates are still tracked (informational; untrack only once every host
 * runs Node >= 22.13). Exit 0 clean · 1 findings or tracked tmp/db · 2 usage
 * or environment error. Never writes. Runs under TWINING_DISABLED.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveProjectRoot } from "../utils/project-root.js";
import { hasRecordsContent } from "../storage/backend-resolve.js";

export type RecordFindingKind =
  | "empty"
  | "conflict_markers"
  | "unparseable"
  | "non_string_id"
  | "id_mismatch";
export interface RecordFinding {
  path: string;
  kind: RecordFindingKind;
  detail?: string;
}
export interface TrackedHygiene {
  tmp_files: string[];
  db_files: string[];
  frozen_aggregates_tracked: string[];
}
export interface ValidationReport {
  project_root: string;
  records_dir_present: boolean;
  sqlite_era: boolean;
  files_checked: number;
  findings: RecordFinding[];
  /** null when the project is not a git repository or git is unavailable */
  tracked: TrackedHygiene | null;
  ok: boolean;
}

export const FROZEN_AGGREGATES = [
  ".twining/decisions/index.json",
  ".twining/graph/entities.json",
  ".twining/graph/relations.json",
  ".twining/agents/registry.json",
  ".twining/blackboard.jsonl",
  ".twining/handoffs/index.jsonl",
] as const;

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;
const USAGE = "usage: twining-mcp validate-records [--project <dir>] [--json]";

function* jsonFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, dirent.name);
    if (dirent.isDirectory()) yield* jsonFiles(p);
    else if (dirent.name.endsWith(".json")) yield p;
  }
}

export function validateRecordsTree(projectRoot: string): ValidationReport {
  const twiningDir = path.join(projectRoot, ".twining");
  const recordsDir = path.join(twiningDir, "records");
  const findings: RecordFinding[] = [];
  let filesChecked = 0;
  const present = fs.existsSync(recordsDir);
  if (present) {
    for (const filePath of jsonFiles(recordsDir)) {
      filesChecked++;
      const rel = path.relative(projectRoot, filePath);
      const stem = path.basename(filePath, ".json");
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        findings.push({
          path: rel,
          kind: "unparseable",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (text.length === 0) {
        findings.push({ path: rel, kind: "empty" });
        continue;
      }
      if (CONFLICT_MARKER.test(text)) {
        findings.push({ path: rel, kind: "conflict_markers" });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        findings.push({
          path: rel,
          kind: "unparseable",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const id =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { id?: unknown }).id
          : undefined;
      if (typeof id !== "string") {
        findings.push({ path: rel, kind: "non_string_id" });
        continue;
      }
      if (id !== stem) {
        findings.push({
          path: rel,
          kind: "id_mismatch",
          detail: `id "${id}" != filename "${stem}"`,
        });
      }
    }
  }
  const sqliteEra = present && hasRecordsContent(twiningDir);
  const tracked = trackedHygiene(projectRoot, sqliteEra);
  const ok =
    findings.length === 0 &&
    (tracked === null ||
      (tracked.tmp_files.length === 0 && tracked.db_files.length === 0));
  return {
    project_root: projectRoot,
    records_dir_present: present,
    sqlite_era: sqliteEra,
    files_checked: filesChecked,
    findings,
    tracked,
    ok,
  };
}

function trackedHygiene(
  projectRoot: string,
  sqliteEra: boolean,
): TrackedHygiene | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["-C", projectRoot, "ls-files", "-z", "--", ".twining"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
  } catch {
    return null;
  }
  const files = out.split("\0").filter(Boolean);
  return {
    tmp_files: files.filter((f) => f.endsWith(".tmp")),
    db_files: files.filter((f) => /(^|\/)twining\.db(-wal|-shm)?$/.test(f)),
    frozen_aggregates_tracked: sqliteEra
      ? files.filter((f) => (FROZEN_AGGREGATES as readonly string[]).includes(f))
      : [],
  };
}

export async function runValidateRecordsCli(argv: string[]): Promise<number> {
  let projectRoot = resolveProjectRoot([], process.env, process.cwd());
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project") {
      if (!argv[i + 1]) {
        console.error(`validate-records: missing value for --project\n${USAGE}`);
        return 2;
      }
      projectRoot = argv[++i]!;
    } else if (arg === "--json") json = true;
    else {
      console.error(`validate-records: unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (!fs.existsSync(path.join(projectRoot, ".twining"))) {
    console.error(`validate-records: no .twining/ under ${projectRoot}`);
    return 2;
  }
  const report = validateRecordsTree(projectRoot);
  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.ok ? 0 : 1;
}

function printReport(r: ValidationReport): void {
  console.log(`twining-mcp validate-records — ${r.project_root}`);
  console.log(
    `  records dir: ${r.records_dir_present ? "present" : "absent"}  files checked: ${r.files_checked}  store: ${r.sqlite_era ? "sqlite-era" : "files-era or empty"}`,
  );
  for (const f of r.findings) {
    console.log(`  ${f.kind}: ${f.path}${f.detail ? ` (${f.detail})` : ""}`);
  }
  if (r.tracked === null) {
    console.log("  git: not a repository (tracked-file checks skipped)");
  } else {
    for (const f of r.tracked.tmp_files) {
      console.log(`  tracked temp file (must be untracked): ${f}`);
    }
    for (const f of r.tracked.db_files) {
      console.log(`  tracked database file (must be untracked): ${f}`);
    }
    if (r.tracked.frozen_aggregates_tracked.length > 0) {
      console.log(
        `  note: frozen v1 aggregates still tracked on a sqlite-era store: ${r.tracked.frozen_aggregates_tracked.join(", ")}`,
      );
      console.log(
        "        untrack them (git rm --cached) only once EVERY host serving this store runs Node >= 22.13 — a host that falls back to the file backend needs decisions/index.json.",
      );
    }
  }
  const trackedProblems =
    r.tracked !== null &&
    (r.tracked.tmp_files.length > 0 || r.tracked.db_files.length > 0);
  console.log(
    r.ok
      ? "  ok"
      : `  ${r.findings.length} record problem(s)${trackedProblems ? " + tracked-file problem(s)" : ""} — repair before committing this tree`,
  );
}
