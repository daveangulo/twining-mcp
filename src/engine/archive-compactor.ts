/**
 * Archive compactor — repair pass for repos damaged by the pre-1.24.0
 * auto-archive feedback loop (#35).
 *
 * The loop posted an "Archive: N entries archived" summary finding after
 * every archive pass, which re-armed the auto-archive trigger; field repos
 * accumulated millions of these in .twining/archive/ (one repo: 7,595,308
 * junk findings of 7,596,560 total, 3.0 GB). 1.24.0 stopped the loop at
 * the source but shipped no cleanup, and `twining-mcp migrate` leaves
 * archive/ untouched — this pass is the repair path.
 *
 * The junk signature is matched conservatively against the exact shape the
 * archiver has stamped since its introduction (verified stable across the
 * full git history of src/engine/archiver.ts):
 *   - entry_type "finding"
 *   - summary `Archive: ${n} entries archived`      (archiver.ts post)
 *   - tags including "archive"
 *   - scope "project"
 *   - agent_id "main" (BlackboardEngine.post default; archiver passes none)
 *   - detail starting `Archive summary: ${n} entries archived.` (buildSummary)
 * Anything else — including corrupt/unparseable lines — is preserved as-is.
 *
 * Archive files can be hundreds of MB, so processing is strictly streaming:
 * line-by-line over a read stream, survivors written to a temp file that is
 * atomically renamed over the original. Whole files are never buffered.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

const JUNK_SUMMARY_RE = /^Archive: \d+ entries archived$/;
const JUNK_DETAIL_RE = /^Archive summary: \d+ entries archived\./;

/** Cheap pre-filter — every junk line contains this literal in its summary. */
const FAST_REJECT = '"Archive: ';

/**
 * True only for lines that are provably the archive loop's own summary
 * findings. Corrupt lines and anything not matching the full archiver
 * signature return false (when in doubt, exclude).
 */
export function isArchiverLoopJunk(line: string): boolean {
  if (!line.includes(FAST_REJECT)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false; // Not provably junk — preserve
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const e = parsed as Record<string, unknown>;
  return (
    e.entry_type === "finding" &&
    typeof e.summary === "string" &&
    JUNK_SUMMARY_RE.test(e.summary) &&
    e.scope === "project" &&
    e.agent_id === "main" &&
    Array.isArray(e.tags) &&
    e.tags.includes("archive") &&
    typeof e.detail === "string" &&
    JUNK_DETAIL_RE.test(e.detail)
  );
}

export interface ArchiveCompactionFileReport {
  /** Absolute path of the archive file. */
  file: string;
  /** Loop-junk entries found (preview) or dropped (execute). */
  junk_count: number;
  /** Lines preserved, including corrupt/unparseable ones. */
  survivor_count: number;
  /** Approximate bytes freed by dropping the junk lines. */
  bytes_reclaimable: number;
  /** Execute-mode only: file removed because no survivors remained. */
  deleted: boolean;
}

export interface ArchiveCompactionReport {
  files: ArchiveCompactionFileReport[];
  total_junk: number;
  total_survivors: number;
  total_bytes_reclaimable: number;
  files_deleted: number;
}

/** Human-readable byte count for summaries and audit posts. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Scan (and optionally compact) every .jsonl file under {twiningDir}/archive.
 * Preview by default — pass execute: true to rewrite files. Execute mode
 * streams survivors to a temp file in the same directory and atomically
 * renames it over the original; files left with zero survivors are deleted.
 * Files containing no junk are never rewritten.
 */
export async function compactArchives(
  twiningDir: string,
  options?: { execute?: boolean },
): Promise<ArchiveCompactionReport> {
  const execute = options?.execute ?? false;
  const report: ArchiveCompactionReport = {
    files: [],
    total_junk: 0,
    total_survivors: 0,
    total_bytes_reclaimable: 0,
    files_deleted: 0,
  };

  const archiveDir = path.join(twiningDir, "archive");
  if (!fs.existsSync(archiveDir)) return report;

  const files = fs
    .readdirSync(archiveDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => path.join(archiveDir, d.name))
    .sort();

  for (const file of files) {
    const fileReport = await compactFile(file, execute);
    report.files.push(fileReport);
    report.total_junk += fileReport.junk_count;
    report.total_survivors += fileReport.survivor_count;
    report.total_bytes_reclaimable += fileReport.bytes_reclaimable;
    if (fileReport.deleted) report.files_deleted++;
  }

  return report;
}

async function compactFile(
  filePath: string,
  execute: boolean,
): Promise<ArchiveCompactionFileReport> {
  const result: ArchiveCompactionFileReport = {
    file: filePath,
    junk_count: 0,
    survivor_count: 0,
    bytes_reclaimable: 0,
    deleted: false,
  };

  // Temp file in the same directory so the final rename is atomic.
  const tmpPath = `${filePath}.compact-${process.pid}-${Date.now()}.tmp`;
  let out: fs.WriteStream | null = null;

  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (isArchiverLoopJunk(line)) {
        result.junk_count++;
        result.bytes_reclaimable += Buffer.byteLength(line, "utf-8") + 1;
        continue;
      }
      result.survivor_count++;
      if (execute) {
        out ??= fs.createWriteStream(tmpPath);
        if (!out.write(line + "\n")) await once(out, "drain");
      }
    }

    if (out) {
      out.end();
      await once(out, "finish");
    }

    if (!execute || result.junk_count === 0) {
      // Preview, or nothing to drop — leave the original untouched.
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      return result;
    }

    if (result.survivor_count === 0) {
      // Everything was junk — remove the file entirely.
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      fs.unlinkSync(filePath);
      result.deleted = true;
      return result;
    }

    fs.renameSync(tmpPath, filePath);
    return result;
  } catch (err) {
    // Best-effort cleanup — never leave a temp file behind.
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
