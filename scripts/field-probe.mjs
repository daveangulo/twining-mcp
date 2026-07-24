#!/usr/bin/env node
/**
 * field-probe — READ-ONLY measurement of a real .twining/ store.
 *
 * Written to test the conclusions of the 2026-07 deep review against
 * accumulated field data rather than code reading. Every hypothesis below was
 * registered BEFORE this script was run against any field store; each carries
 * an explicit falsification threshold, so a run can disprove the review as
 * easily as confirm it.
 *
 * Guarantees:
 *   - Opens nothing for writing. Never imports the twining server or engines.
 *   - Reads only .twining/ and (optionally) `git log` metadata.
 *   - No dependencies beyond Node built-ins. Node >= 18.
 *
 * Usage:
 *   node field-probe.mjs [--project <path>] [--json out.json] [--quiet]
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PROJECT = path.resolve(arg("--project", process.cwd()));
const JSON_OUT = arg("--json", null);
const QUIET = argv.includes("--quiet");
const TW = path.join(PROJECT, ".twining");

if (!fs.existsSync(TW)) {
  console.error(`No .twining/ found at ${TW}. Pass --project <repo root>.`);
  process.exit(2);
}

// ---------------------------------------------------------------- io helpers

function readJSON(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function readJSONL(f) {
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip unparseable */
    }
  }
  return out;
}
function walkJSON(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJSON(p));
    else if (e.name.endsWith(".json")) {
      const v = readJSON(p);
      if (v) out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- load store

// Prefer the committed records/ tree (sqlite backend with export on); fall back
// to the file backend. Both are plain JSON on disk, so neither needs the server.
const recDir = path.join(TW, "records");
let decisions = [];
let posts = [];
let source = "";

if (fs.existsSync(recDir)) {
  decisions = walkJSON(path.join(recDir, "decisions"));
  posts = walkJSON(path.join(recDir, "posts"));
  source = "records/ tree";
}
if (decisions.length === 0) {
  const idx = readJSON(path.join(TW, "decisions", "index.json"));
  if (Array.isArray(idx)) {
    decisions = walkJSON(path.join(TW, "decisions")).filter((d) => d && d.id && d.summary);
    source = source ? source + " + decisions/" : "decisions/";
  }
}
if (posts.length === 0) {
  const bb = readJSONL(path.join(TW, "blackboard.jsonl"));
  if (bb.length) {
    posts = bb;
    source = source ? source + " + blackboard.jsonl" : "blackboard.jsonl";
  }
}
// The live board — what an agent actually sees now.
//
// Precedence matters and was wrong in v1/v2: on a sqlite backend,
// .twining/blackboard.jsonl is a PRE-MIGRATION LEFTOVER and does not track the
// database. Preferring it reported a live board that had not existed for
// months (verified on the dogfood repo: stale file said 3 warnings / 162
// statuses, the database said 15 warnings / 0 statuses). Read the database
// first, then the records/ mirror, and fall back to the JSONL only for a
// genuine file backend.
let boardForLive = [];
let liveSource = "";
const dbPath = path.join(TW, "twining.db");
if (fs.existsSync(dbPath)) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    boardForLive = db
      .prepare("SELECT data FROM blackboard")
      .all()
      .map((r) => {
        try {
          return JSON.parse(r.data);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    db.close();
    liveSource = "twining.db";
  } catch {
    /* node:sqlite unavailable (Node < 22.13) or db locked — fall through */
  }
}
if (!boardForLive.length && posts.length) {
  // records/posts mirrors live rows one-file-per-entry; archived rows are
  // unlinked, so this tracks the database on any export_records:true repo.
  boardForLive = posts;
  liveSource = "records/posts";
}
if (!boardForLive.length) {
  boardForLive = readJSONL(path.join(TW, "blackboard.jsonl"));
  liveSource = "blackboard.jsonl";
}

// archive sweeps
const archDir = path.join(TW, "archive");
const archiveFiles = fs.existsSync(archDir)
  ? fs.readdirSync(archDir).filter((f) => f.endsWith(".jsonl")).sort()
  : [];

// ---------------------------------------------------------------- utils

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function pct(n, d) {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}
function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}
const results = [];
/**
 * `n` / `minN` are a validity guard, NOT a threshold. A hypothesis measured
 * over too small a denominator reports LOW N rather than REFUTES, because
 * "0 of 3" is not evidence of absence. Thresholds inside the verdict functions
 * are pre-registered and must not be edited to change an outcome.
 */
function hypothesis(id, claim, predicted, measured, verdictFn, detail, n = Infinity, minN = 0) {
  const verdict = n < minN ? "LOW N" : verdictFn();
  results.push({ id, claim, predicted, measured, verdict, detail, sample_size: n === Infinity ? null : n, min_sample: minN || null });
}

// ---------------------------------------------------------------- H1 rationale laundering

const withRat = decisions.filter((d) => d && d.summary);
const ratEqual = withRat.filter((d) => norm(d.rationale) === norm(d.summary));
const ratContained =
  withRat.filter((d) => {
    const r = norm(d.rationale), s = norm(d.summary);
    return r && s && r !== s && (s.includes(r) || r.includes(s));
  });
const laundered = ratEqual.length + ratContained.length;
const laundPct = pct(laundered, withRat.length);

hypothesis(
  "H1",
  "Decision rationale is frequently a copy of the summary (WHAT stored as WHY), because three code paths default it silently.",
  ">=15% of decisions have rationale identical to or contained in summary",
  `${laundPct}% (${laundered}/${withRat.length}) — ${ratEqual.length} exact, ${ratContained.length} contained`,
  () => (laundPct === null ? "NO DATA" : laundPct >= 15 ? "SUPPORTS" : "REFUTES"),
  ratEqual.slice(0, 3).map((d) => ({ id: d.id, summary: d.summary })),
  withRat.length,
  30,
);

// H1b: parser-minted alternatives
const withAlts = decisions.filter((d) => Array.isArray(d.alternatives) && d.alternatives.length);
const notChosen = withAlts.filter((d) =>
  d.alternatives.some((a) => norm(a.reason_rejected) === "not chosen"),
);
// A real rejected-alternative label is short. Fragments the NL parser split out
// of a sentence tend to be long or to contain clause punctuation.
const malformed = withAlts.filter((d) =>
  d.alternatives.some((a) => {
    const o = String(a.option || "");
    return o.length > 80 || /,\s+(and|which|so|because)\s/i.test(o);
  }),
);
hypothesis(
  "H1b",
  "The natural-language decision parser manufactures bogus rejected alternatives instead of failing loudly.",
  ">=20% of decisions that have alternatives contain a 'Not chosen' placeholder or a sentence-fragment option",
  `${pct(new Set([...notChosen, ...malformed]).size, withAlts.length)}% (placeholder ${notChosen.length}, fragment ${malformed.length}, of ${withAlts.length} with alternatives)`,
  () => {
    const p = pct(new Set([...notChosen, ...malformed]).size, withAlts.length);
    return p === null ? "NO DATA" : p >= 20 ? "SUPPORTS" : "REFUTES";
  },
  malformed.slice(0, 2).map((d) => ({
    id: d.id,
    bad_option: d.alternatives.find((a) => String(a.option || "").length > 80)?.option?.slice(0, 140),
  })),
  withAlts.length,
  20,
);

// ---------------------------------------------------------------- H2 archive freshness

/**
 * The pre-1.24.0 auto-archive feedback loop (#35) posted an "Archive: N entries
 * archived" finding after every pass, which re-armed the trigger — field repos
 * accumulated millions. Those are machine exhaust, not captured knowledge, so
 * counting them as "findings destroyed by archiving" would wildly overstate
 * H2b. Signature matched conservatively against src/engine/archive-compactor.ts.
 */
const JUNK_SUMMARY_RE = /^Archive: \d+ entries archived$/;
function isLoopJunk(e) {
  return (
    e &&
    e.entry_type === "finding" &&
    typeof e.summary === "string" &&
    JUNK_SUMMARY_RE.test(e.summary) &&
    e.scope === "project" &&
    e.agent_id === "main" &&
    Array.isArray(e.tags) &&
    e.tags.includes("archive")
  );
}

let sweeps = [];
let junkTotal = 0;
let archiveBytes = 0;
for (const f of archiveFiles) {
  try {
    archiveBytes += fs.statSync(path.join(archDir, f)).size;
  } catch {
    /* ignore */
  }
  const all = readJSONL(path.join(archDir, f));
  const entries = all.filter((e) => {
    if (isLoopJunk(e)) {
      junkTotal++;
      return false;
    }
    return true;
  });
  if (!entries.length) continue;
  const ts = entries.map((e) => e.timestamp).filter(Boolean).sort();
  const sweepDate = f.slice(0, 10); // YYYY-MM-DD prefix
  const newest = ts[ts.length - 1];
  const oldest = ts[0];
  sweeps.push({
    file: f,
    count: entries.length,
    oldest,
    newest,
    // How old was the FRESHEST entry when the sweep ran? cutoff=now predicts ~0.
    freshest_age_days: newest ? Math.round(daysBetween(newest, sweepDate + "T23:59:59Z") * 10) / 10 : null,
    span_days: oldest && newest ? Math.round(daysBetween(oldest, newest) * 10) / 10 : null,
    types: entries.reduce((m, e) => ((m[e.entry_type] = (m[e.entry_type] || 0) + 1), m), {}),
  });
}
const freshSweeps = sweeps.filter((s) => s.freshest_age_days !== null && s.freshest_age_days <= 1);
hypothesis(
  "H2",
  "Archiving uses cutoff=now, so sweeps destroy entries created the same day rather than only old ones.",
  "In >=50% of archive sweeps, the freshest archived entry is <=1 day old at sweep time",
  sweeps.length
    ? `${pct(freshSweeps.length, sweeps.length)}% (${freshSweeps.length}/${sweeps.length} sweeps swept same-day entries)`
    : "no archive sweeps found",
  () =>
    !sweeps.length ? "NO DATA" : pct(freshSweeps.length, sweeps.length) >= 50 ? "SUPPORTS" : "REFUTES",
  sweeps.slice(-4),
  sweeps.length,
  3,
);

const archivedTotal = sweeps.reduce((n, s) => n + s.count, 0);
const archivedQuestions = sweeps.reduce((n, s) => n + (s.types.question || 0), 0);
const archivedFindings = sweeps.reduce((n, s) => n + (s.types.finding || 0), 0);
hypothesis(
  "H2b",
  "Findings and open questions — the tacit 'we tried X and it broke' layer — are destroyed wholesale by archiving.",
  "archived findings + questions exceed the number of findings currently live",
  `archived: ${archivedFindings} findings, ${archivedQuestions} questions (total ${archivedTotal}); live findings: ${boardForLive.filter((e) => e.entry_type === "finding").length}`,
  () => {
    const live = boardForLive.filter((e) => e.entry_type === "finding").length;
    if (!archivedTotal) return "NO DATA";
    return archivedFindings + archivedQuestions > live ? "SUPPORTS" : "REFUTES";
  },
  null,
);

// H2c: archive-loop damage (a known, already-fixed bug — measured so the
// repair pass can be prioritised, and so H2b is not read off contaminated data)
const gb = (n) => Math.round((n / 1024 ** 3) * 100) / 100;
hypothesis(
  "H2c",
  "Repo carries damage from the pre-1.24.0 auto-archive feedback loop (#35) and has not had the repair pass run.",
  "0 archiver-loop junk findings present (a non-zero count means the repair pass is owed)",
  junkTotal
    ? `${junkTotal.toLocaleString()} junk findings in archive/ (${gb(archiveBytes)} GB of archive files total)`
    : `none (${gb(archiveBytes)} GB of archive files)`,
  () => (junkTotal > 0 ? "SUPPORTS" : "REFUTES"),
  junkTotal
    ? { remedy: "twining_housekeeping({ compact_archives: true }) — preview first, then execute: true" }
    : null,
);

// Live board composition — what an agent actually has available right now.
const liveTypes = boardForLive.reduce(
  (m, e) => ((m[e.entry_type] = (m[e.entry_type] || 0) + 1), m),
  {},
);
const tacitLive = (liveTypes.finding || 0) + (liveTypes.warning || 0) + (liveTypes.need || 0) + (liveTypes.question || 0);
hypothesis(
  "H2d",
  "After sweeping, the live board retains bookkeeping (statuses/decisions) while the tacit layer — findings, warnings, needs, questions — is gone.",
  "<10% of live entries are findings/warnings/needs/questions",
  `${pct(tacitLive, boardForLive.length)}% tacit (${tacitLive}/${boardForLive.length}); composition: ${JSON.stringify(liveTypes)}`,
  () => {
    const p = pct(tacitLive, boardForLive.length);
    return p === null ? "NO DATA" : p < 10 ? "SUPPORTS" : "REFUTES";
  },
  liveTypes,
  boardForLive.length,
  30,
);

// ---------------------------------------------------------------- H3 resolution / warning ratchet

// Mirror engine semantics: an entry is resolved when a LATER live entry lists
// its id in relates_to. (resolution.ts also treats self-reference specially;
// this approximation is stated as a limitation in the handoff doc.)
const resolvedIds = new Set();
for (const e of boardForLive) {
  for (const r of e.relates_to || []) if (r !== e.id) resolvedIds.add(r);
}
const liveWarnings = boardForLive.filter((e) => e.entry_type === "warning");
const liveNeeds = boardForLive.filter((e) => e.entry_type === "need");
const staleResolved = [...liveWarnings, ...liveNeeds].filter((e) => resolvedIds.has(e.id));
hypothesis(
  "H3",
  "Resolved needs/warnings keep resurfacing in assemble because it ignores the resolution predicate.",
  ">=1 live warning/need is already resolved by another entry yet still on the board",
  `${staleResolved.length} resolved-but-live obligations (of ${liveWarnings.length} warnings + ${liveNeeds.length} needs)`,
  () => (staleResolved.length >= 1 ? "SUPPORTS" : "REFUTES"),
  staleResolved.slice(0, 3).map((e) => ({ id: e.id, type: e.entry_type, summary: e.summary })),
  liveWarnings.length + liveNeeds.length,
  20,
);

const now = Date.now();
const oldWarnings = liveWarnings.filter((w) => (now - new Date(w.timestamp)) / 86400000 > 30);
hypothesis(
  "H3b",
  "Warnings accumulate monotonically: they are archive-exempt and get priority budget, with no drain.",
  ">=25% of live warnings are older than 30 days",
  `${pct(oldWarnings.length, liveWarnings.length)}% (${oldWarnings.length}/${liveWarnings.length} warnings older than 30d)`,
  () => {
    const p = pct(oldWarnings.length, liveWarnings.length);
    return p === null ? "NO DATA" : p >= 25 ? "SUPPORTS" : "REFUTES";
  },
  null,
  liveWarnings.length,
  20,
);

// ---------------------------------------------------------------- H4 scope degradation

const scopeCount = {};
for (const d of decisions) scopeCount[d.scope || "(none)"] = (scopeCount[d.scope || "(none)"] || 0) + 1;
const projectScoped = scopeCount["project"] || 0;
hypothesis(
  "H4",
  "Scope silently degrades to 'project', parking records in the least retrievable bucket.",
  ">=20% of decisions are scoped 'project'",
  `${pct(projectScoped, decisions.length)}% (${projectScoped}/${decisions.length})`,
  () => {
    const p = pct(projectScoped, decisions.length);
    return p === null ? "NO DATA" : p >= 20 ? "SUPPORTS" : "REFUTES";
  },
  Object.entries(scopeCount).sort((a, b) => b[1] - a[1]).slice(0, 8),
  decisions.length,
  30,
);

// ---------------------------------------------------------------- H5 retrieval pressure

// why()/assemble run on a ~4000 token budget. Estimate how much of a hot scope
// can actually surface. ~4 chars/token, and a full decision render is roughly
// summary+rationale+alternatives.
const topScopes = Object.entries(scopeCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
const scopePressure = topScopes.map(([scope, count]) => {
  const ds = decisions.filter((d) => (d.scope || "(none)") === scope);
  const avgTokens =
    ds.reduce((n, d) => {
      const text = `${d.summary || ""} ${d.rationale || ""} ${(d.alternatives || [])
        .map((a) => a.option + a.reason_rejected)
        .join(" ")}`;
      return n + Math.ceil(text.length / 4);
    }, 0) / (ds.length || 1);
  const fits = Math.floor(4000 / Math.max(avgTokens, 1));
  return { scope, decisions: count, avg_tokens: Math.round(avgTokens), fits_in_4k_budget: fits, surfaced_pct: pct(Math.min(fits, count), count) };
});
const pressured = scopePressure.filter((s) => s.decisions > s.fits_in_4k_budget);
hypothesis(
  "H5",
  "The decision corpus outgrows the assemble token budget, so month-6 sessions see a smaller fraction of relevant priors than week-1 sessions.",
  ">=1 active scope holds more decisions than a 4000-token budget can render",
  pressured.length
    ? `${pressured.length} scope(s) over budget; worst: ${pressured[0].scope} ${pressured[0].decisions} decisions, ~${pressured[0].fits_in_4k_budget} fit (${pressured[0].surfaced_pct}%)`
    : "no scope exceeds the budget",
  () => (pressured.length >= 1 ? "SUPPORTS" : "REFUTES"),
  scopePressure,
  decisions.length,
  30,
);

// ---------------------------------------------------------------- H6 subagent capture

const subagentPosts = boardForLive.filter((e) => /^Subagent completed/i.test(e.summary || ""));
const emptyDetail = subagentPosts.filter((e) => !String(e.detail || "").trim());
hypothesis(
  "H6",
  "Subagent knowledge is discarded: SubagentStop writes a contentless label and ignores the transcript.",
  ">=80% of 'Subagent completed' entries have an empty detail field",
  subagentPosts.length
    ? `${pct(emptyDetail.length, subagentPosts.length)}% (${emptyDetail.length}/${subagentPosts.length}) contentless`
    : "no subagent entries found",
  () => {
    const p = pct(emptyDetail.length, subagentPosts.length);
    return p === null ? "NO DATA" : p >= 80 ? "SUPPORTS" : "REFUTES";
  },
  null,
  subagentPosts.length,
  10,
);

// ---------------------------------------------------------------- H7 blind decisions / identity

const blind = decisions.filter((d) => d.assembled_before === false);
hypothesis(
  "H7",
  "Gate 1 is unenforced and its audit signal is unreliable, so decisions are recorded without assembling first.",
  ">=30% of decisions carry assembled_before:false",
  `${pct(blind.length, decisions.length)}% (${blind.length}/${decisions.length})`,
  () => {
    const p = pct(blind.length, decisions.length);
    return p === null ? "NO DATA" : p >= 30 ? "SUPPORTS" : "REFUTES";
  },
  null,
  decisions.length,
  30,
);

const agentIds = {};
for (const d of decisions) agentIds[d.agent_id || "(none)"] = (agentIds[d.agent_id || "(none)"] || 0) + 1;
const mainShare = pct(agentIds["main"] || 0, decisions.length);
hypothesis(
  "H7b",
  "Agent identity collapses to the default 'main', making per-agent coordination features meaningless.",
  ">=70% of decisions are attributed to agent_id 'main'",
  `${mainShare}% (${agentIds["main"] || 0}/${decisions.length}); distinct ids: ${Object.keys(agentIds).length}`,
  () => (mainShare === null ? "NO DATA" : mainShare >= 70 ? "SUPPORTS" : "REFUTES"),
  Object.entries(agentIds).sort((a, b) => b[1] - a[1]).slice(0, 6),
  decisions.length,
  30,
);

// ---------------------------------------------------------------- H8 commit coverage

let commitCoverage = null;
try {
  const since = decisions.length
    ? decisions.map((d) => d.timestamp).filter(Boolean).sort()[0].slice(0, 10)
    : null;
  if (since) {
    const log = execFileSync("git", ["log", `--since=${since}`, "--format=%H"], {
      cwd: PROJECT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
    const linked = new Set();
    for (const d of decisions) for (const h of d.commit_hashes || []) linked.add(h.slice(0, 40));
    const hit = log.filter((h) => [...linked].some((l) => h.startsWith(l) || l.startsWith(h)));
    commitCoverage = { commits: log.length, decisions_with_commit: linked.size, matched: hit.length };
  }
} catch {
  /* not a git repo, or git unavailable */
}
hypothesis(
  "H8",
  "Commit-to-decision traceability is largely absent, because link_commit is full-surface-only and the gate only checks a timestamp.",
  "<20% of commits since the first decision are linked to any decision",
  commitCoverage
    ? `${pct(commitCoverage.matched, commitCoverage.commits)}% of ${commitCoverage.commits} commits linked (${commitCoverage.decisions_with_commit} decisions carry a hash)`
    : "git history unavailable",
  () => {
    if (!commitCoverage || !commitCoverage.commits) return "NO DATA";
    return pct(commitCoverage.matched, commitCoverage.commits) < 20 ? "SUPPORTS" : "REFUTES";
  },
  commitCoverage,
  commitCoverage ? commitCoverage.commits : 0,
  20,
);

// ---------------------------------------------------------------- output

const summary = {
  probe_version: 1,
  generated_at: new Date().toISOString(),
  project: PROJECT,
  source,
  live_source: liveSource,
  totals: {
    decisions: decisions.length,
    live_board_entries: boardForLive.length,
    archived_entries: archivedTotal,
    archive_sweeps: sweeps.length,
    archive_loop_junk: junkTotal,
    archive_bytes: archiveBytes,
  },
  results,
};

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
}

if (!QUIET) {
  const tally = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
  console.log(`\n# Twining field probe\n`);
  console.log(`Project:  ${PROJECT}`);
  console.log(`Source:   ${source || "(none found)"} | live board from: ${liveSource || "(none)"}`);
  console.log(
    `Corpus:   ${decisions.length} decisions, ${boardForLive.length} live entries, ${archivedTotal.toLocaleString()} archived across ${sweeps.length} sweeps` +
      (junkTotal ? `\n          (excluded ${junkTotal.toLocaleString()} archiver-loop junk findings — see H2c)` : "") +
      "\n",
  );
  for (const r of results) {
    const mark = r.verdict.padEnd(8);
    console.log(`[${mark}] ${r.id}  ${r.claim}`);
    console.log(`           predicted: ${r.predicted}`);
    console.log(`           measured:  ${r.measured}`);
    if (r.verdict === "LOW N")
      console.log(`           (sample ${r.sample_size} < ${r.min_sample} required — inconclusive, not evidence of absence)`);
    console.log("");
  }
  console.log(
    `Tally: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}`,
  );
  if (JSON_OUT) console.log(`\nFull detail written to ${JSON_OUT}`);
  console.log(
    `\nNothing was written to ${TW}. Falsification thresholds are in docs/FIELD-VALIDATION.md.\n`,
  );
}
