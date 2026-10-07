/**
 * Append-cost measurement for lane 02 (R20, and lane 05's ~O(n^1.5) report).
 *
 * Lane 05's corpus.ts imports their acceptance harness, which does not exist in
 * this worktree; this is the same measurement over the slice harness that does.
 * It measures ONLY `EventStore.append` — signing, validation, the event-file
 * fsync and the journal insert — because that is the path whose cost lane 05
 * saw growing super-linearly.
 *
 * Usage: npx tsx scripts/measure/append-cost.ts [--tiers 8000,16000]
 * Every number is from one developer machine and is labelled as such.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventStore } from "../../src/events/event-store.js";
import { computeEventDigest, generateKeypair, mintEventId, mintHostId, mintKeyId, mintPrincipalId, mintRepoId, mintStoreId, signEvent, ENVELOPE_V } from "../../src/contracts/index.js";

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
}
const TIERS = flag("tiers", "8000,16000").split(",").map((s) => Number(s.trim())).filter(Boolean);

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function tier(n: number): Promise<{ n: number; p50: number; p95: number; max: number; totalMs: number; firstDecileP95: number; lastDecileP95: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-append-${n}-`));
  const host = { principal: mintPrincipalId(), host: mintHostId(), keyId: mintKeyId(), kp: generateKeypair() };
  const repo = mintRepoId();
  const storeId = mintStoreId();
  const store = new EventStore({
    twiningDir: dir,
    hostKey: { keyId: host.keyId, privateKeyPkcs8Pem: host.kp.privateKeyPkcs8Pem, publicKeySpkiBase64: host.kp.publicKeySpkiBase64 },
    knownKeys: { [host.keyId]: { publicKeySpkiBase64: host.kp.publicKeySpkiBase64 } },
  });

  // One principal + one membership so the corpus is admissible, then N decisions.
  const principal = envelope("principal", host, repo, { principal_id: host.principal, kind: "agent", host: host.host, key_id: host.keyId, public_key: host.kp.publicKeySpkiBase64 }, []);
  await store.append(principal, "import");
  const membership = envelope("membership", host, repo, { store_id: storeId, members: [{ principal: host.principal, roles: ["write"], scopes: [{ repo }] }] }, [principal.id as string]);
  await store.append(membership, "import");
  const infra = [principal.id as string, membership.id as string];

  const samples: number[] = [];
  const started = Date.now();
  for (let i = 0; i < n; i += 1) {
    const ev = envelope("decision", host, repo, { summary: `decision ${i}`, rationale: `because ${i}` }, infra, `2026-${String((i % 12) + 1).padStart(2, "0")}-15T12:00:00.000Z`);
    const t0 = performance.now();
    await store.append(ev, "import");
    samples.push(performance.now() - t0);
  }
  const totalMs = Date.now() - started;
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const sorted = [...samples].sort((a, b) => a - b);
  const decile = Math.max(1, Math.floor(n / 10));
  const first = [...samples.slice(0, decile)].sort((a, b) => a - b);
  const last = [...samples.slice(-decile)].sort((a, b) => a - b);
  return {
    n,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted.at(-1) ?? 0,
    totalMs,
    firstDecileP95: pct(first, 95),
    lastDecileP95: pct(last, 95),
  };
}

function envelope(type: string, host: { principal: string; host: string; keyId: string; kp: { privateKeyPkcs8Pem: string } }, repo: string, payload: Record<string, unknown>, parents: string[], occurredAt = "2026-09-15T12:00:00.000Z"): Record<string, unknown> {
  const id = mintEventId();
  const ev: Record<string, unknown> = {
    v: ENVELOPE_V,
    id,
    kind: "created",
    record: { type, id },
    scope: { repo, path: "svc/ledger/" },
    producer: { principal: host.principal, kind: "agent", host: host.host },
    parents,
    evidence_class: "proposal",
    occurred_at: occurredAt,
    payload,
  };
  ev.digest = computeEventDigest(ev);
  ev.sig = { alg: "ed25519", key: host.keyId, value: signEvent(ev, host.kp.privateKeyPkcs8Pem) };
  return ev;
}

async function main(): Promise<void> {
  const rows: Array<Awaited<ReturnType<typeof tier>>> = [];
  for (const n of TIERS) rows.push(await tier(n));
  process.stdout.write(`${JSON.stringify({ machine: `${os.platform()}/${os.arch()}`, node: process.version, tiers: rows }, null, 2)}\n`);
  for (const r of rows) {
    process.stdout.write(
      `n=${r.n}  p50=${r.p50.toFixed(2)}ms  p95=${r.p95.toFixed(2)}ms  max=${r.max.toFixed(1)}ms  total=${(r.totalMs / 1000).toFixed(1)}s  firstDecileP95=${r.firstDecileP95.toFixed(2)}ms  lastDecileP95=${r.lastDecileP95.toFixed(2)}ms\n`,
    );
  }
}

void main();
