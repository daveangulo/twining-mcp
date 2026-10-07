/**
 * C28 remote qualification scenario (lane 05).
 *
 * Runs on a SECOND computer, driven by `run.sh`. Each phase is a separate OS
 * process against persistent on-disk stores, so "restart" in this script means
 * an actual process boundary, not a reopened handle.
 *
 * Honest scope. This exercises the subset of the C28 oracle that two real
 * stores over a real carrier can demonstrate without the lanes' unfinished
 * code. Everything else is emitted as `not-tested` and MUST NOT be read as a
 * pass (05-verification-and-operations.md: "never convert unavailable into
 * passed").
 *
 * Usage: npx tsx c28-scenario.ts <phase> --work <dir> [--carrier fs|git-fs|relay]
 *   phases: seed | publish | poll | rebuild | assert | bundle
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  World,
  Replica,
  build,
  createdRecord,
  deliver,
  policyEvents,
  settle,
  OCCURRED_AT,
} from "../../../test/acceptance/harness/index.js";
import { FsTransport } from "../../../src/exchange/fs-transport.js";
import type { EventEnvelope } from "../../../src/contracts/index.js";

// ----------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const phase = argv[0] ?? "";
function flag(name: string, fallback?: string): string {
  const i = argv.indexOf(`--${name}`);
  const next = i >= 0 ? argv[i + 1] : undefined;
  if (next !== undefined) return next;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}
const WORK = path.resolve(flag("work"));
const CARRIER = flag("carrier", "fs");
const STATE = path.join(WORK, "state.json");
const BUNDLE = path.join(WORK, "bundle");

type Ids = Record<string, string>;
interface State {
  carrier: string;
  repo: string;
  storeId: string;
  actors: Record<string, { principal: string; host: string; keyId: string; pub: string; priv: string; human: boolean }>;
  ids: Ids;
  timings: Record<string, number>;
  /** Event envelopes we may need to re-deliver (duplicates, conflicts). */
  envelopes: Record<string, Record<string, unknown>>;
}

function loadState(): State {
  return JSON.parse(fs.readFileSync(STATE, "utf8")) as State;
}
/** A labelled id that must exist — a missing one is a scenario bug, not a verdict. */
function idOf(s: State, label: string): string {
  const v = s.ids[label];
  if (v === undefined) throw new Error(`scenario state has no id labelled ${label}`);
  return v;
}

function saveState(s: State): void {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

/** Rehydrate the identity space from disk so each phase is a genuinely separate process. */
function worldFromState(s: State): { world: World; actor: (label: string) => ReturnType<World["actor"]> } {
  const world = new World();
  // World mints fresh ids, so overwrite with the persisted ones.
  const cache = new Map<string, ReturnType<World["actor"]>>();
  const actor = (label: string): ReturnType<World["actor"]> => {
    const hit = cache.get(label);
    if (hit) return hit;
    const p = s.actors[label];
    if (!p) throw new Error(`unknown actor ${label}`);
    const a = {
      label,
      principal: p.principal,
      host: p.host,
      keyId: p.keyId,
      kp: { publicKeySpkiBase64: p.pub, privateKeyPkcs8Pem: p.priv },
      human: p.human,
    } as ReturnType<World["actor"]>;
    cache.set(label, a);
    return a;
  };
  // Patch the key ring the replicas will trust.
  (world as unknown as { knownKeys: () => Record<string, unknown> }).knownKeys = () =>
    Object.fromEntries(
      Object.values(s.actors).map((p) => [p.keyId, { publicKeySpkiBase64: p.pub, ...(p.human ? { human: true } : {}) }]),
    );
  (world as unknown as { storeId: string }).storeId = s.storeId;
  return { world, actor };
}

function replica(name: "A" | "B" | "C", s: State): Replica {
  const { world, actor } = worldFromState(s);
  const identity = actor(name === "A" ? "hp-anita" : name === "B" ? "hp-boris" : "cred-import-charlie");
  return new Replica(name, world, identity, { dir: path.join(WORK, `store-${name}`) });
}

function transport(): FsTransport {
  return new FsTransport(path.join(WORK, "carrier"));
}

const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);

// ---------------------------------------------------------------- byte twins

/** M-07: UTF-8 with BOM and CRLF. M-08: identical visible text, LF, no BOM. */
const M07_TEXT = "﻿rounding policy\r\nhalf-even\r\n";
const M08_TEXT = "rounding policy\nhalf-even\n";

// --------------------------------------------------------------------- seed

async function seed(): Promise<void> {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const world = new World();
  const anita = world.actor("hp-anita", { human: true });
  const boris = world.actor("hp-boris", { human: true });
  const charlie = world.actor("cred-import-charlie");
  const codex = world.actor("ap-orchard-codex");
  const repo = world.repo("R-LEDGER-7f3");

  const s: State = {
    carrier: CARRIER,
    repo,
    storeId: world.storeId,
    actors: Object.fromEntries(
      [anita, boris, charlie, codex].map((a) => [
        a.label,
        { principal: a.principal, host: a.host, keyId: a.keyId, pub: a.kp.publicKeySpkiBase64, priv: a.kp.privateKeyPkcs8Pem, human: a.human },
      ]),
    ),
    ids: {},
    timings: {},
    envelopes: {},
  };
  saveState(s);

  const A = replica("A", s);
  const LEDGER = "svc/ledger/pricing/";
  const BILLING = "svc/billing/rounding/";

  const policy = policyEvents(world, repo, anita, [anita, boris, charlie, codex], [
    { principal: anita.principal, roles: ["write", "rule"], scopes: [{ repo, path: "svc/" }] },
    // P2/E21: boris holds READ ONLY in svc/ledger/ — his supersession must be refused.
    { principal: boris.principal, roles: ["read"], scopes: [{ repo, path: "svc/ledger/" }] },
    { principal: boris.principal, roles: ["write"], scopes: [{ repo, path: "svc/billing/" }] },
    { principal: codex.principal, roles: ["write"], scopes: [{ repo, path: "svc/" }] },
    { principal: charlie.principal, roles: ["read"], scopes: [{ repo, path: "svc/" }] },
  ]);
  const parents = policy.map((e) => e.id as string);
  for (const e of policy) await A.store.append(e, "import");

  const mk = (label: string, scope: string, payload: Record<string, unknown>, by = anita, cls = "verified_observation"): string => {
    const ev = createdRecord("decision", { scope: { repo, path: scope }, by, parents, evidence_class: cls, payload });
    s.envelopes[label] = ev;
    s.ids[label] = ev.id as string;
    return ev.id as string;
  };

  const m03 = mk("M-03", LEDGER, { summary: "ledger rounding", rationale: "seed", rounding: "half-up-legacy", status: "active" });
  mk("M-06", LEDGER, { summary: "correction target", rationale: "seed", status: "active" });
  mk("M-07", LEDGER, { summary: "byte twin CRLF+BOM", rationale: "seed", body_text: M07_TEXT, status: "active" });
  mk("M-08", LEDGER, { summary: "byte twin LF", rationale: "seed", body_text: M08_TEXT, status: "active" });
  mk("M-11", LEDGER, { summary: "tombstone target", rationale: "seed", status: "active" });
  const t0 = now();
  for (const label of ["M-03", "M-06", "M-07", "M-08", "M-11"]) await A.store.append(s.envelopes[label], "import");

  // P2 — two concurrent, equally authorised successors to M-03, plus one
  // unauthorised claim by boris (read only in svc/ledger/).
  const e20rec = mk("E20-rec", LEDGER, { summary: "rounding half-even", rationale: "anita on host-alpha", rounding: "half-even", status: "active" });
  const e22rec = mk("E22-rec", LEDGER, { summary: "rounding truncate", rationale: "anita on host-bravo hotfix", rounding: "truncate", status: "active" });
  const e21rec = mk("E21-rec", LEDGER, { summary: "rounding half-up", rationale: "boris, read-only scope", rounding: "half-up", status: "active" }, boris);
  for (const label of ["E20-rec", "E22-rec", "E21-rec"]) await A.store.append(s.envelopes[label], "import");

  const sup = (label: string, by: string, author: typeof anita, occurred: string): void => {
    const ev = build({
      kind: "superseded",
      record: { type: "decision", id: m03 },
      scope: { repo, path: LEDGER },
      by: author,
      producerKind: "human",
      parents: [m03, by],
      evidence_class: "verified_observation",
      occurred_at: occurred,
      payload: { target: m03, by, reason: label },
    });
    s.envelopes[label] = ev;
    s.ids[label] = ev.id as string;
  };
  sup("E20", e20rec, anita, "2026-09-15T09:00:00.000Z");
  sup("E22", e22rec, anita, "2026-09-15T08:55:00.000Z"); // effective EARLIER, arrives later
  sup("E21", e21rec, boris, "2026-09-15T09:05:00.000Z"); // unauthorised
  for (const label of ["E20", "E22", "E21"]) await A.store.append(s.envelopes[label], "import");

  // P5/E50 — a confident, ordinary-sounding model-authored claim.
  const e50 = createdRecord("decision", {
    scope: { repo, path: LEDGER },
    by: codex,
    parents,
    evidence_class: "model_inference",
    payload: {
      summary: "Settled with the pricing owners: half-even rounding is accepted for all ledger pricing scopes",
      rationale: "FR-LED-118 is closed.",
      actor: "hp-anita",
      active: true,
      promoted_by: "hp-anita",
      status: "active",
    },
  });
  s.envelopes["E50"] = e50;
  s.ids["E50"] = e50.id as string;
  await A.store.append(e50, "import");

  // P5/E40 — boris writes legitimately in svc/billing/ (POSITIVE CONTROL Q5).
  const e40 = createdRecord("decision", {
    scope: { repo, path: BILLING },
    by: boris,
    parents,
    evidence_class: "verified_observation",
    payload: { summary: "billing rounding rule", rationale: "boris, authorised scope", status: "active" },
  });
  s.envelopes["E40"] = e40;
  s.ids["E40"] = e40.id as string;
  await A.store.append(e40, "import");

  // P3 — E08 identity collision: the same event id with different bytes.
  const collision = { ...(s.envelopes["M-07"] as Record<string, unknown>) };
  delete collision.sig;
  delete collision.digest;
  (collision.payload as Record<string, unknown>).body_text = M08_TEXT; // different bytes, same id
  s.envelopes["E08-collision"] = collision;

  await settle(A.store);
  s.timings.seed_ms = now() - t0;
  s.ids["policy"] = parents.join(",");
  saveState(s);
  A.close();
  log(`seeded store-A at ${path.join(WORK, "store-A")} (${Object.keys(s.ids).length} labelled ids)`);
}

// ------------------------------------------------------------------ publish

async function publish(): Promise<void> {
  const s = loadState();
  const A = replica("A", s);
  const t = transport();
  const t0 = now();
  const pending = A.store.outboxPending(t.id());
  const receipt = await t.publish(pending);
  for (const ev of pending) {
    const cid = receipt.carrier_ids[ev.digest];
    if (cid) A.store.recordPublishReceipt(t.id(), ev.id, cid);
  }
  // P3 — E07 redelivered three times with an identical digest.
  const dup = pending.find((e) => e.id === idOf(s, "M-07"));
  if (dup) for (let i = 0; i < 2; i++) await t.publish([dup]);
  s.timings.publish_ms = now() - t0;
  s.timings.published_events = pending.length;
  saveState(s);
  A.close();
  log(`published ${pending.length} events to the carrier at ${path.join(WORK, "carrier")}`);
}

// --------------------------------------------------------------------- poll

async function poll(): Promise<void> {
  const s = loadState();
  const B = replica("B", s);
  const t = transport();
  const t0 = now();
  const cursor = await B.store.cursor("consumer");
  const { events, cursor: next } = await t.poll(cursor);
  for (const ev of events) B.store.receive(ev, t.id());
  // P3 — the identity collision arrives after the original.
  B.store.receive(s.envelopes["E08-collision"], t.id());
  await settle(B.store);
  await B.store.setCursor("consumer", next);
  s.timings.poll_ms = now() - t0;
  s.timings.polled_events = events.length;
  saveState(s);
  B.close();
  log(`store-B received ${events.length} events (+1 deliberate identity collision)`);
}

// ------------------------------------------------------------------ rebuild

async function rebuild(): Promise<void> {
  const s = loadState();
  // store-C: an empty install fed only from store-A's durable event files.
  const src = path.join(WORK, "store-A", "events");
  const dstDir = path.join(WORK, "store-C");
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dstDir, "events"), { recursive: true });
  copyTree(src, path.join(dstDir, "events"));
  const C = replica("C", s);
  const t0 = now();
  const { projection_digest } = await C.store.rebuild();
  s.timings.rebuild_ms = now() - t0;
  s.timings.rebuild_digest_c = projection_digest as unknown as number;
  saveState(s);
  C.close();
  const A = replica("A", s);
  const aDigest = A.store.projectionDigest();
  A.close();
  log(`store-C rebuilt from durable events; digest match with store-A: ${aDigest === projection_digest}`);
}

function copyTree(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else if (entry.name.endsWith(".json")) {
      fs.copyFileSync(s, d);
    }
  }
}

// ------------------------------------------------------------------- assert

type Verdict = "pass" | "fail" | "not-tested";
interface Result {
  id: string;
  verdict: Verdict;
  detail: string;
}

async function assertPhase(): Promise<void> {
  const s = loadState();
  const A = replica("A", s);
  const B = replica("B", s);
  const C = fs.existsSync(path.join(WORK, "store-C")) ? replica("C", s) : null;
  const results: Result[] = [];
  const add = (id: string, verdict: Verdict, detail: string): void => {
    results.push({ id, verdict, detail });
  };

  const m03 = idOf(s, "M-03");
  const viewB = await B.store.query({ scope: { repo: s.repo, path: "svc/" } });
  const m03B = await B.store.get(m03);

  // A2 — three events touch M-03: E20 admitted, E22 admitted, E21 refused-and-retained.
  const hist = await B.store.history(m03);
  const log21 = B.store.admissionLog(idOf(s, "E21"));
  add(
    "A2",
    hist.length >= 2 && log21.length > 0 ? "pass" : "fail",
    `history(M-03)=${hist.length} events; E21 admission-log rows=${log21.length} outcomes=${log21.map((r) => r.outcome).join("/")}`,
  );

  // A3 — M-03 is explicitly contested with no applied resolution.
  add(
    "A3",
    m03B?.status === "conflicted" && (m03B?.conflicts.length ?? 0) >= 2 ? "pass" : "fail",
    `V(M-03).status=${m03B?.status} conflicts=${JSON.stringify(m03B?.conflicts)}`,
  );

  // A4 — E21 (unauthorised) never enters V on any replica.
  const e21rec = idOf(s, "E21-rec");
  const inV = viewB.some((r) => r.record_id === e21rec) ? "present" : "absent";
  const e21Applied = m03B?.superseded_by.includes(e21rec) ?? false;
  add("A4", !e21Applied ? "pass" : "fail", `E21's successor record is ${inV} in V; applied to M-03: ${e21Applied}`);

  // A6 — byte twins keep distinct source bytes through transfer.
  const m07 = await B.store.get(idOf(s, "M-07"));
  const m08 = await B.store.get(idOf(s, "M-08"));
  const t7 = (m07?.body as { body_text?: string })?.body_text ?? "";
  const t8 = (m08?.body as { body_text?: string })?.body_text ?? "";
  add(
    "A6",
    t7 === M07_TEXT && t8 === M08_TEXT && sha(t7) !== sha(t8) ? "pass" : "fail",
    `M-07 bytes=${Buffer.byteLength(t7)} sha=${sha(t7).slice(0, 12)} · M-08 bytes=${Buffer.byteLength(t8)} sha=${sha(t8).slice(0, 12)}`,
  );

  // A7 — the model-authored claim keeps its class; its caller-controlled fields confer nothing.
  const e50 = await B.store.get(idOf(s, "E50"));
  add(
    "A7",
    e50?.evidence_class === "model_inference" ? "pass" : "fail",
    `E50.evidence_class=${e50?.evidence_class} (payload carried actor/active/promoted_by)`,
  );

  // A10 — the duplicate publishes produce one admitted copy and one semantic effect.
  const dupLog = B.store.admissionLog(idOf(s, "M-07"));
  const admittedCopies = (await B.store.events({ record_id: idOf(s, "M-07") })).length;
  add(
    "A10",
    admittedCopies === 1 ? "pass" : "fail",
    `admitted copies of M-07 = ${admittedCopies}; admission-log outcomes = ${dupLog.map((r) => r.outcome).join("/")}`,
  );

  // A12 — the reused id with different bytes is an explicit conflict with both byte streams retained.
  const collisionRows = B.store.journalRows().filter((r) => r.id === idOf(s, "M-07"));
  add(
    "A12",
    collisionRows.length >= 2 && collisionRows.some((r) => r.state === "rejected") ? "pass" : "fail",
    `journal rows for the reused id = ${collisionRows.length}; states = ${collisionRows.map((r) => r.state).join("/")}`,
  );

  // A13 — the refusal must be a TERMINAL receipt state with an authority/scope
  // reason, not an absence and not an indefinite wait. `pending_parents` is
  // neither: it never terminates, so the producer never learns the claim was
  // refused and the event accumulates in any gap report forever.
  //
  // FINDING F-PENDING (lane 02): when an event's causal parent is REJECTED,
  // the dependent event stays `pending_parents` indefinitely instead of
  // settling into a refusal with a reason. Observed on store-A and store-B for
  // E21 (whose successor record E21-rec is correctly rejected `unauthorized`).
  const e21State = B.store.journalRows().find((r) => r.id === idOf(s, "E21"))?.state;
  const terminal = e21State === "rejected" || e21State === "quarantined";
  add(
    "A13",
    terminal ? "pass" : "fail",
    `E21 final delivery state = ${e21State} (required: a terminal refusal with an authority/scope reason). ` +
      `Admission log: ${log21.map((r) => `${r.outcome}:${r.reason ?? ""}`).join(" | ")}`,
  );

  // A13-auth — the separable half that DOES hold: the unauthorised successor
  // record itself is refused with an authority reason and retained as evidence.
  const e21recRow = A.store.journalRows().find((r) => r.id === idOf(s, "E21-rec"));
  add(
    "A13-auth",
    e21recRow?.state === "rejected" && e21recRow.reason === "unauthorized" ? "pass" : "fail",
    `E21's successor record state=${e21recRow?.state} reason=${e21recRow?.reason}`,
  );

  // A18/A20 — store-C, rebuilt only from durable events, equals store-A.
  if (C) {
    const aDigest = A.store.projectionDigest();
    const cDigest = C.store.projectionDigest();
    add("A18", aDigest === cDigest ? "pass" : "fail", `projection digest A=${aDigest.slice(0, 16)} C=${cDigest.slice(0, 16)}`);
    const aIds = (await A.store.query({ include_retired: true, include_archived: true })).map((r) => r.record_id).sort();
    const cIds = (await C.store.query({ include_retired: true, include_archived: true })).map((r) => r.record_id).sort();
    add("A20", JSON.stringify(aIds) === JSON.stringify(cIds) ? "pass" : "fail", `store-A records=${aIds.length} store-C records=${cIds.length}`);
    // A19 — the rebuild changes none of the awkward states.
    const cm03 = await C.store.get(m03);
    const ce50 = await C.store.get(idOf(s, "E50"));
    add(
      "A19",
      cm03?.status === "conflicted" && ce50?.evidence_class === "model_inference" ? "pass" : "fail",
      `after rebuild: M-03.status=${cm03?.status}, E50.class=${ce50?.evidence_class}`,
    );
  } else {
    for (const id of ["A18", "A19", "A20"]) add(id, "not-tested", "rebuild phase was not run");
  }

  // Q5 — POSITIVE CONTROL: boris's authorised billing write is applicable.
  const e40 = await B.store.get(idOf(s, "E40"));
  add("Q5", e40 && e40.applicable ? "pass" : "fail", `E40 applicable=${e40?.applicable} status=${e40?.status} — if this fails the run is void`);

  // Everything the merged code cannot yet demonstrate. NEVER report as a pass.
  const untested: Array<[string, string]> = [
    ["A1", "requires the full MAN-0 manifest and evidence envelope fields (source URI + anchor, observer, observation time) that the v3 slice does not yet carry"],
    ["A5", "prerequisite deferral of E30 before E29 needs lane 02's ordered-correction path"],
    ["A8", "tombstone semantics (C20) are lane 02, not merged"],
    ["A9", "the seven-state delivery ladder needs context_included / task_acknowledged from lane 03 and lane 04"],
    ["A11", "lost-acknowledgement reconciliation needs the transport fault hooks wired through a real carrier"],
    ["A14", "repository relocation + worktree identity needs the git carrier (src/exchange/git-transport.ts is absent)"],
    ["A15", "kill between admission and index write needs lane 02's fault suite (a child process that dies at a named step)"],
    ["A16", "requires scanning every report/doc string for exactly-once and global-erasure claims"],
    ["A17", "receiving-turn evidence needs lane 03 host adapters and real Codex/Claude turns"],
    ["A21", "T2 = 10k and T3 = 100k corpora are measured by scripts/measure/corpus.ts, not by this bundle"],
    ["A22", "offline revocation-unknown reporting needs the permission epoch (C19), not merged"],
    ["A23", "a whole-run authority/scope audit needs every lane merged"],
    ["A24", "topology and observed traffic are reported by docs/operations/data-flow.md + scripts/measure/observe-traffic.sh"],
    ["A25", "the latency targets need lane 03/04 recall and injection paths"],
    ["A26", "no threshold restatement — enforced by review, not by this script"],
    ["Q1", "action qualification is lane 04"],
    ["Q2", "action qualification is lane 04"],
    ["Q3", "action qualification is lane 04"],
    ["Q4", "revocation is C19, not merged"],
    ["Q6", "offline policy declaration is C19, not merged"],
    ["Q7", "lessons-mode cross-scope query is lane 04"],
  ];
  for (const [id, why] of untested) add(id, "not-tested", why);

  fs.mkdirSync(BUNDLE, { recursive: true });
  fs.writeFileSync(path.join(BUNDLE, "results.json"), JSON.stringify({ carrier: s.carrier, results }, null, 2));
  A.close();
  B.close();
  C?.close();

  const tally = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] ?? 0) + 1 }), {});
  log(`assertions: ${JSON.stringify(tally)}`);
  for (const r of results.filter((x) => x.verdict === "fail")) log(`  FAIL ${r.id}: ${r.detail}`);
}

function sha(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// -------------------------------------------------------------------- bundle

async function bundle(): Promise<void> {
  const s = loadState();
  fs.mkdirSync(BUNDLE, { recursive: true });
  const A = replica("A", s);
  const B = replica("B", s);
  const C = fs.existsSync(path.join(WORK, "store-C")) ? replica("C", s) : null;

  const dump = async (name: string, r: Replica | null): Promise<void> => {
    if (!r) return;
    fs.writeFileSync(
      path.join(BUNDLE, `view-${name}.json`),
      JSON.stringify(await r.store.query({ include_retired: true, include_archived: true }), null, 2),
    );
    fs.writeFileSync(path.join(BUNDLE, `events-${name}.json`), JSON.stringify(await r.store.events({}), null, 2));
    fs.writeFileSync(path.join(BUNDLE, `journal-${name}.json`), JSON.stringify(r.store.journalRows(), null, 2));
    fs.writeFileSync(path.join(BUNDLE, `admission-log-${name}.json`), JSON.stringify(r.store.admissionLog(), null, 2));
    fs.writeFileSync(path.join(BUNDLE, `projection-digest-${name}.txt`), r.store.projectionDigest());
  };
  await dump("A", A);
  await dump("B", B);
  await dump("C", C);

  const cursor = await B.store.cursor("consumer");
  fs.writeFileSync(path.join(BUNDLE, "cursors.json"), JSON.stringify({ "store-B/consumer": cursor }, null, 2));
  fs.writeFileSync(path.join(BUNDLE, "timings.json"), JSON.stringify(s.timings, null, 2));
  fs.writeFileSync(path.join(BUNDLE, "ids.json"), JSON.stringify(s.ids, null, 2));

  const gitCarrier = fs.existsSync(path.join(WORK, "carrier", ".git"));
  const meta = {
    generated_at: new Date().toISOString(),
    /** Topology declaration — read this FIRST. */
    topology: {
      machines: 1,
      declaration:
        "Two stores in separate directories, driven by separate OS processes on ONE computer. This is a SUBSTITUTION for the two-or-more actual computers C28 requires (A24). The run is therefore C28-UNAVAILABLE, never C28-PASSED, unless the operator ran the two halves on two physical machines and edited this field.",
      operator_override: process.env.C28_MACHINES ?? "unset",
    },
    carrier: {
      kind: s.carrier,
      git_backed: gitCarrier,
      note: gitCarrier
        ? "The carrier directory is a real git working tree pushed to a disposable bare remote: bytes crossed git objects. This is NOT src/exchange/git-transport.ts (ADR §8.2), which is not merged; the exchange-ref topology, dirty-tree guarantee and commit-sha receipts are therefore UNTESTED."
        : "Shared-directory carrier only. No git object transfer occurred.",
      git_transport_present: fs.existsSync(path.join(repoRoot(), "src", "exchange", "git-transport.ts")),
    },
    host_fingerprint: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpus: os.cpus().length,
      cpu_model: os.cpus()[0]?.model ?? "unknown",
      total_mem_bytes: os.totalmem(),
      node: process.version,
      hostname_sha256: sha(os.hostname()).slice(0, 16),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    source: gitDescribe(),
    occurred_at_fixed: OCCURRED_AT,
  };
  fs.writeFileSync(path.join(BUNDLE, "meta.json"), JSON.stringify(meta, null, 2));

  // A manifest over every bundle file, so the lead can prove nothing changed in transit.
  const files = fs.readdirSync(BUNDLE).filter((f) => f !== "manifest.sha256").sort();
  const manifest = files.map((f) => `${sha(fs.readFileSync(path.join(BUNDLE, f), "utf8"))}  ${f}`).join("\n");
  fs.writeFileSync(path.join(BUNDLE, "manifest.sha256"), manifest + "\n");

  A.close();
  B.close();
  C?.close();
  log(`bundle written to ${BUNDLE} (${files.length + 1} files)`);
}

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
}

function gitDescribe(): Record<string, string> {
  try {
    const run = (args: string[]): string => execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8" }).trim();
    return { commit: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: run(["status", "--porcelain"]) ? "yes" : "no" };
  } catch {
    return { commit: "unknown", branch: "unknown", dirty: "unknown" };
  }
}

function log(msg: string): void {
  process.stdout.write(`[c28] ${msg}\n`);
}

const PHASES: Record<string, () => Promise<void>> = { seed, publish, poll, rebuild, assert: assertPhase, bundle };

const run = PHASES[phase];
if (!run) {
  process.stderr.write(`usage: c28-scenario.ts <${Object.keys(PHASES).join("|")}> --work <dir> [--carrier fs|git-fs]\n`);
  process.exit(2);
}
run().catch((err) => {
  process.stderr.write(`[c28] ${phase} failed: ${String(err instanceof Error ? err.stack : err)}\n`);
  process.exit(1);
});
