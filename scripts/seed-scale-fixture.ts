#!/usr/bin/env npx tsx
// Synthetic .twining/ generator for dashboard scale testing.
// Usage: npx tsx scripts/seed-scale-fixture.ts <targetDir> [--decisions N --entries N --entities N]
import fs from "node:fs";
import path from "node:path";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { initTwiningDir } from "../src/storage/init.js";
import type { Decision, DecisionIndexEntry, BlackboardEntry } from "../src/utils/types.js";

const SCOPES = [
  "src/auth/", "src/auth/oauth/", "src/api/", "src/api/routes/", "src/db/",
  "src/db/migrations/", "src/ui/", "src/ui/components/", "src/utils/",
  "test/", "docs/", "project",
];
const DOMAINS = ["architecture", "implementation", "testing", "data-model", "deployment", "security", "performance"];
const ENTRY_TYPES = ["finding", "status", "warning", "need"] as const;
const ENTITY_TYPES = ["file", "function", "class", "concept", "module", "pattern"] as const;

// Deterministic PRNG so fixtures are reproducible
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

// Timestamps spread over 18 months with bursts (realistic activity clumps)
function randomTimestamp(): string {
  const now = Date.now();
  const spanMs = 548 * 24 * 3600 * 1000;
  const burst = Math.floor(rand() * 40); // 40 burst centers
  const center = now - spanMs + (burst / 40) * spanMs;
  const jitter = (rand() - 0.5) * 14 * 24 * 3600 * 1000;
  return new Date(Math.min(center + jitter, now)).toISOString();
}

async function main() {
  const target = process.argv[2];
  if (!target) { console.error("usage: seed-scale-fixture.ts <targetDir>"); process.exit(1); }
  const args = process.argv.slice(3);
  const num = (flag: string, dflt: number) => {
    const i = args.indexOf(flag);
    return i >= 0 ? parseInt(args[i + 1]!, 10) : dflt;
  };
  const nDecisions = num("--decisions", 5000);
  const nEntries = num("--entries", 5000);
  const nEntities = num("--entities", 5000);

  // initTwiningDir creates the full .twining/ scaffold (decisions/index.json,
  // graph/entities.json + relations.json, blackboard.jsonl, agents/registry.json,
  // etc.) — the store classes assume this scaffold already exists rather than
  // creating it themselves (discovered while smoke-testing: DecisionStore.create
  // throws ENOENT if decisions/index.json is missing). It no-ops if .twining/
  // already exists, so re-running against a stale/partial target dir requires
  // deleting it first.
  const twiningDir = path.join(target, ".twining");
  initTwiningDir(target);

  const bb = new BlackboardStore(twiningDir);
  const dec = new DecisionStore(twiningDir);
  const graph = new GraphStore(twiningDir);

  console.error(`Seeding ${nEntries} entries, ${nDecisions} decisions, ${nEntities} entities into ${twiningDir}`);

  for (let i = 0; i < nEntries; i++) {
    await bb.append({
      agent_id: `agent-${Math.floor(rand() * 8)}`,
      entry_type: pick(ENTRY_TYPES),
      tags: [pick(["perf", "bug", "refactor", "infra", "ux"])],
      scope: pick(SCOPES),
      summary: `Synthetic ${i}: ${pick(["found", "observed", "measured", "flagged"])} behavior in ${pick(SCOPES)}`,
      detail: `Detail body for synthetic entry ${i}. `.repeat(5),
    });
    if (i > 0 && i % 500 === 0) console.error(`  entries: ${i}/${nEntries}`);
  }

  const decisionIds: string[] = [];
  for (let i = 0; i < nDecisions; i++) {
    const d = await dec.create({
      agent_id: `agent-${Math.floor(rand() * 8)}`,
      domain: pick(DOMAINS),
      scope: pick(SCOPES),
      summary: `Synthetic decision ${i}: chose ${pick(["A", "B", "C"])} over ${pick(["X", "Y"])}`,
      context: "synthetic",
      rationale: `Rationale for synthetic decision ${i}. `.repeat(4),
      constraints: [],
      alternatives: [{ option: "alt", pros: [], cons: [], reason_rejected: "synthetic" }],
      depends_on: [],
      confidence: pick(["high", "medium", "low"] as const),
      reversible: rand() < 0.85,
      affected_files: [pick(SCOPES) + "file" + (i % 40) + ".ts"],
      affected_symbols: [],
      commit_hashes: [],
    });
    decisionIds.push(d.id);
    if (i > 0 && i % 500 === 0) console.error(`  decisions: ${i}/${nDecisions}`);
  }
  // ~8% superseded chains (some length 3+)
  for (let i = 0; i < Math.floor(nDecisions * 0.08); i++) {
    const a = pick(decisionIds); const b = pick(decisionIds);
    if (a !== b) await dec.updateStatus(a, "superseded", { superseded_by: b });
  }

  const entityIds: string[] = [];
  for (let i = 0; i < nEntities; i++) {
    const e = await graph.addEntity({
      name: `${pick(ENTITY_TYPES)}-${i}`,
      type: pick(ENTITY_TYPES),
      properties: { path: pick(SCOPES) },
    });
    entityIds.push(e.id);
    if (i > 0 && i % 500 === 0) console.error(`  entities: ${i}/${nEntities}`);
  }
  // Power-law-ish relations: 20 hubs get heavy degree, rest sparse. ~1.6x entities.
  const hubs = entityIds.slice(0, 20);
  const nRelations = Math.floor(nEntities * 1.6);
  for (let i = 0; i < nRelations; i++) {
    const source = rand() < 0.35 ? pick(hubs) : pick(entityIds);
    const target = pick(entityIds);
    if (source === target) continue;
    await graph.addRelation({ source, target, type: pick(["depends_on", "calls", "imports", "related_to"] as const) });
    if (i > 0 && i % 1000 === 0) console.error(`  relations: ${i}/${nRelations}`);
  }

  console.error("Rewriting timestamps for 18-month spread...");

  // Blackboard: rewrite each entry's timestamp, then re-sort the JSONL by new timestamp
  // (append() stamps "now"; raw-file rewriting is acceptable here since this is fixture tooling).
  {
    const bbPath = path.join(twiningDir, "blackboard.jsonl");
    const raw = fs.readFileSync(bbPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entries = lines.map((l) => JSON.parse(l) as BlackboardEntry);
    for (const entry of entries) entry.timestamp = randomTimestamp();
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    fs.writeFileSync(bbPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  // Decisions: rewrite timestamp in each decisions/<id>.json and in decisions/index.json,
  // keeping both consistent for the same decision id.
  {
    const decisionsDir = path.join(twiningDir, "decisions");
    const indexPath = path.join(decisionsDir, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as DecisionIndexEntry[];
    const tsById = new Map<string, string>();
    for (const entry of index) {
      const ts = randomTimestamp();
      tsById.set(entry.id, ts);
      entry.timestamp = ts;
    }
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    for (const [id, ts] of tsById) {
      const filePath = path.join(decisionsDir, `${id}.json`);
      const decision = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Decision;
      decision.timestamp = ts;
      fs.writeFileSync(filePath, JSON.stringify(decision, null, 2));
    }
  }

  console.error("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
