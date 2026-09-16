/**
 * Verify a C28 artifact bundle returned from another computer (lane 05).
 *
 * The bundle carries its own `results.json`, but this verifier NEVER trusts
 * it: it recomputes every verdict it can from the raw histories, views,
 * journals and admission logs in the bundle, and reports any disagreement with
 * the run's self-report as a finding. A bundle whose self-report says `pass`
 * where the raw data says otherwise is the failure mode this exists to catch.
 *
 * Usage: npx tsx verify-bundle.ts <bundle.tar.gz | bundle-dir>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const arg = process.argv[2];
if (!arg) {
  process.stderr.write("usage: verify-bundle.ts <bundle.tar.gz | bundle-dir>\n");
  process.exit(2);
}

function unpack(target: string): string {
  if (fs.statSync(target).isDirectory()) return target;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c28-verify-"));
  execFileSync("tar", ["-xzf", path.resolve(target), "-C", dir]);
  const inner = path.join(dir, "bundle");
  return fs.existsSync(inner) ? inner : dir;
}

const DIR = unpack(arg);
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as T;
/** A labelled id that must be in the bundle. A missing one is a bundle defect. */
function idOf(ids: Record<string, string>, label: string): string {
  const v = ids[label];
  if (v === undefined) throw new Error(`bundle ids.json has no entry for ${label}`);
  return v;
}
const exists = (f: string): boolean => fs.existsSync(path.join(DIR, f));
const sha = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const problems: string[] = [];
const notes: string[] = [];
const out = (s: string): void => {
  process.stdout.write(s + "\n");
};

// ----------------------------------------------------------- 1. integrity
if (!exists("manifest.sha256")) {
  problems.push("manifest.sha256 is missing — the bundle's integrity cannot be checked");
} else {
  for (const line of fs.readFileSync(path.join(DIR, "manifest.sha256"), "utf8").trim().split("\n")) {
    const [want, file] = line.split(/\s+/, 2);
    if (!file || !want) continue;
    if (!exists(file)) {
      problems.push(`manifest lists ${file}, which is not in the bundle`);
      continue;
    }
    const got = sha(fs.readFileSync(path.join(DIR, file), "utf8"));
    if (got !== want) problems.push(`${file}: sha256 mismatch (manifest ${want.slice(0, 12)}…, actual ${got.slice(0, 12)}…)`);
  }
}

// ------------------------------------------------------------ 2. topology
interface Meta {
  topology: { machines: number; declaration: string; operator_override: string };
  carrier: { kind: string; git_backed: boolean; note: string; git_transport_present: boolean };
  host_fingerprint: Record<string, unknown>;
  source: Record<string, string>;
}
const meta = exists("meta.json") ? read<Meta>("meta.json") : null;
if (!meta) {
  problems.push("meta.json is missing — topology and provenance are unknown");
} else {
  out("== topology ==");
  out(`  machines declared : ${meta.topology.machines}`);
  out(`  operator override : ${meta.topology.operator_override}`);
  out(`  carrier           : ${meta.carrier.kind} (git-backed: ${meta.carrier.git_backed})`);
  out(`  git transport in source: ${meta.carrier.git_transport_present}`);
  out(`  source commit     : ${meta.source.commit} (${meta.source.branch}, dirty=${meta.source.dirty})`);
  out(`  host              : ${String(meta.host_fingerprint.platform)}/${String(meta.host_fingerprint.arch)} node ${String(meta.host_fingerprint.node)}`);
  const twoMachines = meta.topology.machines >= 2 || /^[2-9]/.test(meta.topology.operator_override);
  if (!twoMachines) {
    notes.push(
      "TOPOLOGY SUBSTITUTION: fewer than two physical computers. Per C28 A24 the case is UNAVAILABLE, not PASSED, however many assertions are green.",
    );
  }
  if (!meta.carrier.git_transport_present) {
    notes.push(
      "CARRIER SUBSTITUTION: src/exchange/git-transport.ts was absent at this commit. The ADR 8.2 exchange-ref topology, the dirty-tree guarantee and commit-sha receipts are UNTESTED by this bundle.",
    );
  }
  if (meta.source.dirty === "yes") notes.push("The source checkout was DIRTY: the commit alone does not identify what ran.");
}

// --------------------------------- 3. independent recomputation of verdicts
interface Projected {
  record_id: string;
  status: string;
  evidence_class: string;
  conflicts: string[];
  superseded_by: string[];
  applicable: boolean;
  body: Record<string, unknown>;
}
interface JournalRow { id: string; digest: string; state: string; reason?: string }
interface LogRow { event_id: string; outcome: string; reason?: string }
interface Result { id: string; verdict: string; detail: string }

const recomputed = new Map<string, { verdict: string; detail: string }>();
function recompute(id: string, verdict: string, detail: string): void {
  recomputed.set(id, { verdict, detail });
}

if (exists("view-B.json") && exists("ids.json")) {
  const viewB = read<Projected[]>("view-B.json");
  const ids = read<Record<string, string>>("ids.json");
  const byId = new Map(viewB.map((r) => [r.record_id, r]));
  const journalB = exists("journal-B.json") ? read<JournalRow[]>("journal-B.json") : [];
  const logB = exists("admission-log-B.json") ? read<LogRow[]>("admission-log-B.json") : [];

  const m03 = byId.get(idOf(ids, "M-03"));
  recompute(
    "A3",
    m03?.status === "conflicted" && (m03?.conflicts.length ?? 0) >= 2 ? "pass" : "fail",
    `M-03.status=${m03?.status} conflicts=${m03?.conflicts.length ?? 0}`,
  );
  recompute(
    "A4",
    m03 && !m03.superseded_by.includes(idOf(ids, "E21-rec")) ? "pass" : "fail",
    `unauthorised successor applied to M-03: ${m03?.superseded_by.includes(idOf(ids, "E21-rec"))}`,
  );
  const m07 = byId.get(idOf(ids, "M-07"));
  const m08 = byId.get(idOf(ids, "M-08"));
  const t7 = String((m07?.body as { body_text?: string })?.body_text ?? "");
  const t8 = String((m08?.body as { body_text?: string })?.body_text ?? "");
  recompute(
    "A6",
    t7.startsWith("﻿") && t7.includes("\r\n") && !t8.startsWith("﻿") && !t8.includes("\r\n") && sha(t7) !== sha(t8) ? "pass" : "fail",
    `M-07 BOM=${t7.startsWith("﻿")} CRLF=${t7.includes("\r\n")} · M-08 BOM=${t8.startsWith("﻿")} CRLF=${t8.includes("\r\n")}`,
  );
  const e50 = byId.get(idOf(ids, "E50"));
  recompute("A7", e50?.evidence_class === "model_inference" ? "pass" : "fail", `E50.class=${e50?.evidence_class}`);
  const collision = journalB.filter((r) => r.id === idOf(ids, "M-07"));
  recompute(
    "A12",
    collision.length >= 2 && collision.some((r) => r.state === "rejected") ? "pass" : "fail",
    `rows for the reused id=${collision.length} states=${collision.map((r) => r.state).join("/")}`,
  );
  const e21log = logB.filter((r) => r.event_id === idOf(ids, "E21"));
  const e21State = journalB.find((r) => r.id === idOf(ids, "E21"))?.state;
  recompute(
    "A13",
    e21State === "rejected" || e21State === "quarantined" ? "pass" : "fail",
    `E21 final state=${e21State} (a terminal refusal is required; pending_parents never terminates) log=${e21log.map((r) => r.outcome).join("/")}`,
  );
  const journalA = exists("journal-A.json") ? read<JournalRow[]>("journal-A.json") : [];
  const e21rec = journalA.find((r) => r.id === idOf(ids, "E21-rec"));
  recompute("A13-auth", e21rec?.state === "rejected" && e21rec.reason === "unauthorized" ? "pass" : "fail", `E21-rec state=${e21rec?.state} reason=${e21rec?.reason}`);

  // A2 — three events touch M-03 and the refused one is retained.
  const eventsB = exists("events-B.json") ? read<Array<{ id: string; record?: { id: string }; payload?: { target?: string } }>>("events-B.json") : [];
  const touchingM03 = eventsB.filter((e) => e.record?.id === idOf(ids, "M-03") || e.payload?.target === idOf(ids, "M-03"));
  recompute(
    "A2",
    touchingM03.length >= 3 && journalB.some((r) => r.id === idOf(ids, "E21")) ? "pass" : "fail",
    `events touching M-03 on store-B = ${touchingM03.length}; E21 retained in the journal = ${journalB.some((r) => r.id === idOf(ids, "E21"))}`,
  );

  // A10 — the three deliveries of M-07 produce exactly one admitted copy.
  const m07Copies = eventsB.filter((e) => e.record?.id === idOf(ids, "M-07")).length;
  recompute("A10", m07Copies === 1 ? "pass" : "fail", `admitted copies of M-07 on store-B = ${m07Copies}`);
  const e40 = byId.get(idOf(ids, "E40"));
  recompute("Q5", e40?.applicable ? "pass" : "fail", `E40 applicable=${e40?.applicable} (POSITIVE CONTROL: a failure voids the run)`);
}

if (exists("view-A.json") && exists("view-C.json") && exists("ids.json")) {
  const viewA = read<Projected[]>("view-A.json");
  const viewC = read<Projected[]>("view-C.json");
  const ids = read<Record<string, string>>("ids.json");
  const aIds = viewA.map((r) => r.record_id).sort();
  const cIds = viewC.map((r) => r.record_id).sort();
  recompute("A20", JSON.stringify(aIds) === JSON.stringify(cIds) ? "pass" : "fail", `store-A records=${aIds.length} store-C records=${cIds.length}`);
  const cm03 = viewC.find((r) => r.record_id === idOf(ids, "M-03"));
  const ce50 = viewC.find((r) => r.record_id === idOf(ids, "E50"));
  recompute(
    "A19",
    cm03?.status === "conflicted" && ce50?.evidence_class === "model_inference" ? "pass" : "fail",
    `after rebuild: M-03.status=${cm03?.status} E50.class=${ce50?.evidence_class}`,
  );
}

if (exists("projection-digest-A.txt") && exists("projection-digest-C.txt")) {
  const a = fs.readFileSync(path.join(DIR, "projection-digest-A.txt"), "utf8").trim();
  const c = fs.readFileSync(path.join(DIR, "projection-digest-C.txt"), "utf8").trim();
  recompute("A18", a === c && a.length > 0 ? "pass" : "fail", `digest A=${a.slice(0, 16)} C=${c.slice(0, 16)}`);
}

// ----------------------------------------------- 4. compare with self-report
out("\n== verdicts ==");
const selfReport = exists("results.json") ? read<{ results: Result[] }>("results.json").results : [];
const selfById = new Map(selfReport.map((r) => [r.id, r]));
const seen = new Set<string>();
for (const [id, mine] of [...recomputed.entries()].sort()) {
  seen.add(id);
  const theirs = selfById.get(id);
  const agree = theirs?.verdict === mine.verdict;
  out(`  ${id.padEnd(6)} recomputed=${mine.verdict.padEnd(10)} self-report=${theirs?.verdict ?? "absent"}  ${agree ? "" : "<-- DISAGREEMENT"}`);
  out(`         ${mine.detail}`);
  if (!agree) problems.push(`${id}: the bundle reports ${theirs?.verdict ?? "nothing"} but the raw data recomputes to ${mine.verdict}`);
}
for (const r of selfReport) {
  if (seen.has(r.id)) continue;
  out(`  ${r.id.padEnd(6)} recomputed=n/a       self-report=${r.verdict}`);
  if (r.verdict === "pass") problems.push(`${r.id}: reported as a pass but this verifier cannot recompute it from the bundle`);
}

const tally = selfReport.reduce<Record<string, number>>((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] ?? 0) + 1 }), {});
out(`\n  self-reported tally: ${JSON.stringify(tally)}`);

// ------------------------------------------------------------ 5. conclusion
out("\n== notes (read before quoting any result) ==");
for (const n of notes) out(`  ! ${n}`);
if (notes.length === 0) out("  (none)");

out("\n== problems ==");
for (const p of problems) out(`  X ${p}`);
if (problems.length === 0) out("  (none)");

out(
  `\nVERDICT: ${
    problems.length > 0
      ? "BUNDLE REJECTED — see problems above"
      : notes.length > 0
        ? "BUNDLE ACCEPTED, C28 UNAVAILABLE — the substitutions above mean the case is not passed"
        : "BUNDLE ACCEPTED"
  }\n`,
);
process.exit(problems.length > 0 ? 1 : 0);
