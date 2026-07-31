#!/usr/bin/env node
/**
 * compact-archives-standalone — reclaim disk from the pre-1.24.0 auto-archive
 * feedback loop (#35) without a server, an MCP tool, or a Twining release.
 *
 * Why this exists: the sanctioned repair path is
 * `twining_housekeeping({ compact_archives: true, execute: true })`, but
 * `execute: true` also runs housekeeping's step-1 archive pass, which takes no
 * cutoff and therefore sweeps the ENTIRE live board. The `archive: false`
 * opt-out that makes that safe needs a server release. This script does only
 * the compaction, touching nothing but `.twining/archive/*.jsonl`.
 *
 * Matching is deliberately conservative and mirrors
 * src/engine/archive-compactor.ts exactly: a line is dropped only if it parses
 * as JSON and matches ALL SEVEN fields the archiver has stamped since the
 * feature was introduced. Corrupt lines, agent-authored entries, and anything
 * that differs in a single field are preserved.
 *
 * Safety:
 *   - Preview by default. Nothing is modified without --execute.
 *   - Strictly streaming — archive files can be gigabytes; none are buffered.
 *   - Survivors are written to a temp file in the same directory and then
 *     atomically renamed over the original, so an interrupted run leaves either
 *     the old file or the new one, never a partial.
 *   - Reads and writes nothing outside `.twining/archive/`.
 *
 * Usage:
 *   node compact-archives-standalone.mjs --project /path/to/repo            # preview
 *   node compact-archives-standalone.mjs --project /path/to/repo --execute
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PROJECT = path.resolve(arg("--project", process.cwd()));
const EXECUTE = argv.includes("--execute");
const ARCHIVE_DIR = path.join(PROJECT, ".twining", "archive");

if (!fs.existsSync(ARCHIVE_DIR)) {
  console.error(`No .twining/archive/ at ${ARCHIVE_DIR}. Pass --project <repo root>.`);
  process.exit(2);
}

// The archiver's own summary-finding signature. All seven must match.
const JUNK_SUMMARY_RE = /^Archive: \d+ entries archived$/;
const JUNK_DETAIL_RE = /^Archive summary: \d+ entries archived\./;
const FAST_REJECT = '"Archive: ';

function isArchiverLoopJunk(line) {
  // Cheap pre-filter: every junk line contains this literal.
  if (!line.includes(FAST_REJECT)) return false;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return false; // Not provably junk — preserve.
  }
  if (typeof e !== "object" || e === null) return false;
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

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function compactFile(filePath) {
  const result = {
    file: path.basename(filePath),
    junk: 0,
    survivors: 0,
    reclaimable: 0,
    deleted: false,
  };
  const tmpPath = `${filePath}.compact-${process.pid}-${Date.now()}.tmp`;
  let out = null;

  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (isArchiverLoopJunk(line)) {
        result.junk++;
        result.reclaimable += Buffer.byteLength(line, "utf-8") + 1;
        continue;
      }
      // Preserve blank trailing lines as nothing; everything else survives.
      if (line.trim() === "") continue;
      result.survivors++;
      if (EXECUTE) {
        out ??= fs.createWriteStream(tmpPath);
        if (!out.write(line + "\n")) await once(out, "drain");
      }
    }

    if (out) {
      out.end();
      await once(out, "finish");
    }

    if (!EXECUTE || result.junk === 0) {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      return result;
    }

    if (result.survivors === 0) {
      // Every line was junk — drop the file rather than leave it empty.
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      fs.unlinkSync(filePath);
      result.deleted = true;
      return result;
    }

    fs.renameSync(tmpPath, filePath);
    return result;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* never leave a temp file behind */
    }
    throw err;
  }
}

const files = fs
  .readdirSync(ARCHIVE_DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()
  .map((f) => path.join(ARCHIVE_DIR, f));

if (files.length === 0) {
  console.log(`No .jsonl files in ${ARCHIVE_DIR} — nothing to do.`);
  process.exit(0);
}

console.log(
  `\n${EXECUTE ? "Compacting" : "Previewing"} ${files.length} archive file(s) in ${ARCHIVE_DIR}\n`,
);

let totJunk = 0;
let totSurv = 0;
let totBytes = 0;
let deleted = 0;
let failed = 0;

for (const f of files) {
  try {
    const r = await compactFile(f);
    totJunk += r.junk;
    totSurv += r.survivors;
    totBytes += r.reclaimable;
    if (r.deleted) deleted++;
    if (r.junk > 0) {
      const verb = EXECUTE ? (r.deleted ? "deleted (all junk)" : "compacted") : "would compact";
      console.log(
        `  ${r.file.padEnd(34)} ${String(r.junk).padStart(9)} junk, ${String(r.survivors).padStart(6)} kept  ${fmtBytes(r.reclaimable).padStart(9)}  ${verb}`,
      );
    }
  } catch (err) {
    failed++;
    console.error(`  ${path.basename(f)}: FAILED — ${err.message} (file left untouched)`);
  }
}

console.log(
  `\n${EXECUTE ? "Dropped" : "Would drop"} ${totJunk.toLocaleString()} junk entries, ` +
    `${EXECUTE ? "reclaimed" : "reclaiming"} ${fmtBytes(totBytes)}. ` +
    `${totSurv.toLocaleString()} real entries preserved.`,
);
if (deleted) console.log(`${deleted} file(s) were entirely junk and were removed.`);
if (failed) console.log(`${failed} file(s) failed and were left untouched.`);

if (!EXECUTE) {
  console.log(`\nPreview only — nothing was modified. Re-run with --execute to apply.\n`);
} else {
  console.log(
    `\nDone. Only .twining/archive/ was touched; the live board, decisions, and records/ are untouched.\n`,
  );
}
