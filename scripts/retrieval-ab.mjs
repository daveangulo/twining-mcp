/**
 * Retrieval A/B: semantic embeddings vs keyword fallback, on twining-mcp's
 * own real .twining corpus (169 decisions, ~300 blackboard entries).
 *
 * Experiment 1 — dependency retrieval: for every valid depends_on link
 * (A depends on B), query searchDecisions with A's summary and measure the
 * rank of B among all decisions (excluding A). Metrics: MRR, hit@5, hit@10,
 * miss rate. Ground truth comes from real dependency links, so queries are
 * topically related to targets without being lexically contained in them.
 *
 * Experiment 2 — briefing impact: for 10 realistic task queries, run
 * ContextAssembler.assemble under both modes and compare which decision ids
 * make the briefing (Jaccard overlap). This measures the END effect on what
 * agents actually see, where relevance is one weight among five.
 *
* Usage: npm run build && node scripts/retrieval-ab.mjs [projectRoot]
 * (projectRoot defaults to this repo; point it at any .twining project.)
 * Runs against dist/ so the real ONNX model loads (no VITEST fallback).
 * Corpus is copied to a temp dir; the repo's .twining is never touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.cwd();
const PROJECT = process.argv[2] ? path.resolve(process.argv[2]) : REPO;
const dist = (p) => import(path.join(REPO, "dist", p));

const { BlackboardStore } = await dist("storage/blackboard-store.js");
const { DecisionStore } = await dist("storage/decision-store.js");
const { GraphStore } = await dist("storage/graph-store.js");
const { HandoffStore } = await dist("storage/handoff-store.js");
const { AgentStore } = await dist("storage/agent-store.js");
const { IndexManager } = await dist("embeddings/index-manager.js");
const { Embedder } = await dist("embeddings/embedder.js");
const { SearchEngine } = await dist("embeddings/search.js");
const { ContextAssembler } = await dist("engine/context-assembler.js");
const { DEFAULT_CONFIG } = await dist("config.js");
const { blackboardEmbedText, decisionEmbedText } = await dist("embeddings/embed-text.js");

// ---- corpus: copy the target project's .twining into a temp dir ---------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twining-ab-"));
const tw = path.join(tmp, ".twining");
fs.cpSync(path.join(PROJECT, ".twining"), tw, { recursive: true });
// fresh embeddings index — we build it ourselves below for a fair A arm
fs.rmSync(path.join(tw, "embeddings"), { recursive: true, force: true });
fs.mkdirSync(path.join(tw, "embeddings"), { recursive: true });
// Model cache: prefer the target project's own cache, else this repo's,
// else leave absent (first embed() downloads from huggingface.co — needs
// network; on an air-gapped machine pre-seed .twining/models from any
// machine that has it).
fs.rmSync(path.join(tw, "models"), { recursive: true, force: true });
for (const src of [path.join(PROJECT, ".twining", "models"), path.join(REPO, ".twining", "models")]) {
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(tw, "models"), { recursive: true });
    break;
  }
}

const decisionStore = new DecisionStore(tw);
const blackboardStore = new BlackboardStore(tw);
const graphStore = new GraphStore(tw);
const handoffStore = new HandoffStore(tw);
const agentStore = new AgentStore(tw);
const indexManager = new IndexManager(tw);

const index = await decisionStore.getIndex();
const decisions = [];
for (const ix of index) {
  const d = await decisionStore.get(ix.id);
  if (d) decisions.push(d);
}
const { entries } = await blackboardStore.read();
console.log(`corpus: ${decisions.length} decisions, ${entries.length} blackboard entries`);

// ---- arm A: real embedder; build the full index --------------------------
const embedder = Embedder.getInstance(tw);
const t0 = Date.now();
const dIndex = { model: "all-MiniLM-L6-v2", dimension: 384, entries: [] };
for (const d of decisions) {
  const v = await embedder.embed(decisionEmbedText(d));
  if (v) dIndex.entries.push({ id: d.id, vector: v });
}
const bIndex = { model: "all-MiniLM-L6-v2", dimension: 384, entries: [] };
for (const e of entries) {
  const v = await embedder.embed(blackboardEmbedText(e));
  if (v) bIndex.entries.push({ id: e.id, vector: v });
}
await indexManager.save("decisions", dIndex);
await indexManager.save("blackboard", bIndex);
console.log(
  `embedded ${dIndex.entries.length} decisions + ${bIndex.entries.length} entries in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
  `(fallback=${embedder.isFallbackMode()})`,
);
if (embedder.isFallbackMode()) {
  console.error("MODEL FAILED TO LOAD — A/B invalid, aborting");
  process.exit(1);
}

const semantic = new SearchEngine(embedder, indexManager);
const fallbackEmbedder = { embed: async () => null, isFallbackMode: () => true };
const keyword = new SearchEngine(fallbackEmbedder, indexManager);

// ---- experiment 1: dependency retrieval ----------------------------------
const knownIds = new Set(decisions.map((d) => d.id));
const pairs = [];
for (const d of decisions) {
  for (const dep of d.depends_on ?? []) {
    if (knownIds.has(dep) && dep !== d.id) pairs.push({ query: d, target: dep });
  }
}
console.log(`\nexperiment 1: ${pairs.length} valid depends_on pairs`);
if (pairs.length === 0) {
  console.log("  (no depends_on links in this corpus — experiment 1 skipped)");
}

async function rankOf(engine, queryText, excludeId, targetId) {
  const candidates = decisions.filter((d) => d.id !== excludeId);
  const { results } = await engine.searchDecisions(queryText, candidates, { limit: candidates.length });
  const i = results.findIndex((r) => r.decision.id === targetId);
  return i === -1 ? null : i + 1;
}

const stats = { semantic: [], keyword: [] };
for (const { query, target } of pairs) {
  stats.semantic.push(await rankOf(semantic, query.summary, query.id, target));
  stats.keyword.push(await rankOf(keyword, query.summary, query.id, target));
}

function summarize(name, ranks) {
  const n = ranks.length;
  const hits = (k) => ranks.filter((r) => r !== null && r <= k).length;
  const mrr = ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n;
  console.log(
    `  ${name.padEnd(9)} MRR=${mrr.toFixed(3)}  hit@1=${(hits(1) / n * 100).toFixed(0)}%  ` +
    `hit@5=${(hits(5) / n * 100).toFixed(0)}%  hit@10=${(hits(10) / n * 100).toFixed(0)}%  ` +
    `miss=${(ranks.filter((r) => r === null).length / n * 100).toFixed(0)}%`,
  );
}
if (pairs.length > 0) {
  summarize("semantic", stats.semantic);
  summarize("keyword", stats.keyword);
}

// ---- experiment 2: briefing impact ---------------------------------------
// Task queries come from the corpus itself so the script works against ANY
// project: 10 decisions evenly spaced through the store, query = their
// `context` (the situation that prompted them — topically related to the
// corpus without being the indexed summary text), scope = their scope.
// Pass a JSON file of [task, scope] pairs as argv[3] to override.
let TASKS;
if (process.argv[3]) {
  TASKS = JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), "utf-8"));
} else {
  const usable = decisions.filter((d) => (d.context ?? "").length > 20);
  const step = Math.max(1, Math.floor(usable.length / 10));
  TASKS = usable
    .filter((_, i) => i % step === 0)
    .slice(0, 10)
    .map((d) => [d.context.slice(0, 300), d.scope || "project"]);
}

const mkAssembler = (engine) =>
  new ContextAssembler(blackboardStore, decisionStore, engine, DEFAULT_CONFIG, null, null, handoffStore, agentStore);
const asmA = mkAssembler(semantic);
const asmB = mkAssembler(keyword);

console.log(`\nexperiment 2: briefing decision-set overlap across ${TASKS.length} tasks`);
let identical = 0, jaccards = [];
for (const [task, scope] of TASKS) {
  const a = await asmA.assemble(task, scope);
  const b = await asmB.assemble(task, scope);
  const sa = new Set(a.active_decisions.map((d) => d.id));
  const sb = new Set(b.active_decisions.map((d) => d.id));
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  const j = union === 0 ? 1 : inter / union;
  jaccards.push(j);
  if (j === 1) identical++;
  console.log(`  J=${j.toFixed(2)}  |A|=${sa.size} |B|=${sb.size}  ${task.slice(0, 55)}`);
}
console.log(
  `  mean Jaccard=${(jaccards.reduce((a, b) => a + b, 0) / jaccards.length).toFixed(3)}  ` +
  `identical briefings=${identical}/${TASKS.length}`,
);

fs.rmSync(tmp, { recursive: true, force: true });
