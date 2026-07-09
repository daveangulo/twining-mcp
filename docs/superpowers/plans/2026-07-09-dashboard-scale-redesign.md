# Dashboard Scale Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-09-dashboard-scale-design.md` — read it first; it is the authority on behavior.

**Goal:** Make the dashboard's graphical views (timeline, graph, lists) usable at ~5k records per store via a server query layer, a compact client index, and scale-native visual idioms.

**Architecture:** New server endpoints (`/api/index` delta polling, graph summary/neighborhood, health report) coded against the `I*Store` interfaces; frontend gains native ES modules under `public/js/` (no build step) — an index store, a shared virtualized list, a canvas density timeline (vis-timeline deleted), and a drill-down graph explorer (cytoscape retained, capped).

**Tech Stack:** TypeScript (Node >=18), vitest, vanilla JS ES modules, canvas 2D, cytoscape (vendored), Playwright MCP browser for UI verification.

## Global Constraints

- **No stdout writes anywhere in server code** — MCP StdioServerTransport owns stdout; use `console.error` only. (Repeated at the top of every dashboard file.)
- **No build step, no framework, no new runtime dependencies.** Frontend is vanilla JS ES modules served statically. cytoscape stays vendored; vis-timeline gets deleted in Phase 3.
- **No view may render O(dataset) DOM.** Every list is windowed; every canvas redraw is O(visible buckets/items); cytoscape never receives more than ~200 elements.
- **All new endpoints are additive.** Existing `/api/*` routes keep working; existing tests must keep passing (`npm test`).
- **Code against `src/storage/interfaces.ts` types (`IBlackboardStore` etc.), never concrete store classes**, so the SQLite backend swap keeps working.
- **XSS rule from app.js header: all user content rendered via `textContent`/`createElement` — never `innerHTML` with data.**
- **Gate 2 discipline:** call `twining_record` (summary + decisions) before every `git commit`; commit `.twining/` changes in the same commit.
- **No `plugin/` changes** in this plan → no plugin version bump needed.
- Frontend modules that contain pure logic (store merge, bucketing math) must be importable in vitest under node — no DOM access at module top level.

## File Structure (end state)

```
src/dashboard/
  api-routes.ts               // existing, untouched except handleRequest wiring
  query-routes.ts             // NEW: /api/index, /api/blackboard/:id, /api/graph/summary,
                              //      /api/graph/entities, /api/graph/neighborhood, /api/health-report
  http-server.ts              // modified: wire createQueryHandler before createApiHandler
  public/
    index.html                // modified: <script type="module" src="js/main.js">, view containers
    app.js                    // shrinks: legacy renderers deleted as views are replaced
    style.css                 // gains component styles
    js/                       // NEW — all ES modules
      main.js                 // orchestrator bridge: init store, mount new views, polling
      store.js                // compact index store: load/delta/subscribe/facets/scopes
      list-view.js            // shared virtualized faceted list
      timeline-scale.js       // pure time-bucketing + coordinate math (unit-tested)
      density-timeline.js     // canvas timeline component
      graph-view.js           // overview / entity list / ego explorer
      health.js               // health cards in Insights
      router.js               // URL hash state
      scope-nav.js            // scope breadcrumb
    vendor/                   // vis-timeline files DELETED in Phase 3; cytoscape stays
scripts/seed-scale-fixture.ts // NEW: 5k/5k/5k synthetic .twining/ generator
test/dashboard/
  query-routes.test.ts        // NEW: endpoint tests
  store-logic.test.ts         // NEW: store.js merge/facet/scope unit tests
  timeline-scale.test.ts      // NEW: bucketing math unit tests
```

**Module interfaces** (single source of truth for names used across tasks):

```js
// store.js
export function createIndexStore({ fetchImpl } = {})   // returns store
// store.rows           -> [{id, kind:'blackboard'|'decision', timestamp, entry_type?, scope,
//                           summary, tags?, domain?, status?, confidence?}] sorted timestamp ASC
// store.load()         -> Promise<void>   full /api/index fetch
// store.poll(status)   -> Promise<void>   delta fetch + count validation (status = /api/status body)
// store.subscribe(fn)  -> unsubscribe fn; fn() called after any rows change
// store.filter(f)      -> rows matching f: {kinds?, entryTypes?, statuses?, domains?,
//                           confidences?, tags?, scope?, from?, to?, text?}
// store.facetCounts(f, field) -> Map<value, count>  (f applied EXCEPT the counted field)
// store.scopeChildren(f, prefix) -> [{segment, scope, count}] direct children of prefix
// store.counts         -> last server total_counts (for mismatch detection)

// list-view.js
export function createListView(container, { store, kinds, columns, onSelect, rowHeight = 48 })
// returns { setFilter(f), refresh(), getFilter(), destroy() }

// timeline-scale.js  (pure — no DOM)
export function chooseBucket(spanMs)                    // -> {unit, ms} from hour..year, 60–120 on screen
export function bucketize(rows, fromMs, toMs, bucketMs, colorKey) // -> [{t0, counts: Map<key,n>, total}]
export function makeScale(fromMs, toMs, widthPx)        // -> {x(tMs), t(xPx)}

// density-timeline.js
export function createDensityTimeline(container, { store, onSelect, onRangeChange })
// returns { setFilter(f), setColorKey('domain'|'status'), fit(), destroy() }

// graph-view.js
export function createGraphView(container, { onEntitySelect })   // manages 3 drill levels internally

// router.js
export function readRoute()                             // -> {tab, scope, filters, sel, range, anchor}
export function writeRoute(partial)                     // merge + history.replaceState
export function onRouteChange(fn)
```

---

## Phase 1 — Server query layer + fixture

### Task 1: Seed fixture generator

**Files:**
- Create: `scripts/seed-scale-fixture.ts`
- Modify: `package.json` (add script `"seed:scale": "npx tsx scripts/seed-scale-fixture.ts"`)

**Interfaces:**
- Consumes: `BlackboardStore`, `DecisionStore`, `GraphStore` concrete classes (this script is dev tooling — the one allowed place to use them directly).
- Produces: a `.twining/` directory at a target path with ~5k blackboard entries, ~5k decisions, ~5k entities + ~8k relations; used by Playwright verification in every later phase.

- [ ] **Step 1: Write the script.** Behavior: `npx tsx scripts/seed-scale-fixture.ts /tmp/twining-scale-fixture [--decisions 5000 --entries 5000 --entities 5000]`. Creates `<target>/.twining/` via the store classes:

```ts
// scripts/seed-scale-fixture.ts
// Synthetic .twining/ generator for dashboard scale testing.
// Usage: npx tsx scripts/seed-scale-fixture.ts <targetDir> [--decisions N --entries N --entities N]
import fs from "node:fs";
import path from "node:path";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";

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

  const twiningDir = path.join(target, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });

  const bb = new BlackboardStore(twiningDir);
  const dec = new DecisionStore(twiningDir);
  const graph = new GraphStore(twiningDir);

  console.error(`Seeding ${nEntries} entries, ${nDecisions} decisions, ${nEntities} entities into ${twiningDir}`);

  for (let i = 0; i < nEntries; i++) {
    const entry = await bb.append({
      agent_id: `agent-${Math.floor(rand() * 8)}`,
      entry_type: pick(ENTRY_TYPES),
      tags: [pick(["perf", "bug", "refactor", "infra", "ux"])],
      scope: pick(SCOPES),
      summary: `Synthetic ${i}: ${pick(["found", "observed", "measured", "flagged"])} behavior in ${pick(SCOPES)}`,
      detail: `Detail body for synthetic entry ${i}. `.repeat(5),
    });
    // Overwrite timestamp for spread (append stamps "now"): rewrite happens in Step 2
    void entry;
  }

  const decisionIds: string[] = [];
  for (let i = 0; i < nDecisions; i++) {
    const d = await dec.create({
      domain: pick(DOMAINS),
      scope: pick(SCOPES),
      summary: `Synthetic decision ${i}: chose ${pick(["A", "B", "C"])} over ${pick(["X", "Y"])}`,
      rationale: `Rationale for synthetic decision ${i}. `.repeat(4),
      alternatives: [{ option: "alt", pros: [], cons: [], reason_rejected: "synthetic" }],
      confidence: pick(["high", "medium", "low"] as const),
      affected_files: [pick(SCOPES) + "file" + (i % 40) + ".ts"],
      affected_symbols: [],
      context: "synthetic",
    } as never);
    decisionIds.push(d.id);
  }
  // ~8% superseded chains (some length 3+)
  for (let i = 0; i < Math.floor(nDecisions * 0.08); i++) {
    const a = pick(decisionIds); const b = pick(decisionIds);
    if (a !== b) await dec.updateStatus(a, "superseded", { superseded_by: b } as never);
  }

  const entityIds: string[] = [];
  for (let i = 0; i < nEntities; i++) {
    const e = await graph.addEntity({
      name: `${pick(ENTITY_TYPES)}-${i}`,
      type: pick(ENTITY_TYPES),
      properties: { path: pick(SCOPES) },
    });
    entityIds.push(e.id);
  }
  // Power-law-ish relations: 20 hubs get heavy degree, rest sparse. ~1.6x entities.
  const hubs = entityIds.slice(0, 20);
  for (let i = 0; i < nEntities * 1.6; i++) {
    const source = rand() < 0.35 ? pick(hubs) : pick(entityIds);
    const target = pick(entityIds);
    if (source === target) continue;
    await graph.addRelation({ source, target, type: pick(["depends_on", "calls", "imports", "related_to"] as const) });
  }

  console.error("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Implementation notes for the executor:
- The `as never` casts mark spots where you must check the real `Decision` input type in `src/utils/types.ts` and supply required fields exactly — fix the object literals to typecheck cleanly and **remove the casts**. Same for `superseded_by`: verify the actual field name on `Decision` (spec §1.1 flags this); `twining_record`'s `supersedes` parameter is the tool-level name, the store field may differ. Use whatever `DecisionStore.updateStatus` actually persists.
- Timestamp spread: `append()`/`create()` stamp "now". After seeding, rewrite timestamps: for blackboard, stream-rewrite `blackboard.jsonl` replacing each `timestamp` with `randomTimestamp()` (keep JSONL line order sorted by the new timestamps); for decisions, rewrite each `decisions/<id>.json` and `decisions/index.json` entry consistently. This is fixture tooling, so raw-file rewriting is acceptable here.

- [ ] **Step 2: Run and verify.**

Run: `npx tsx scripts/seed-scale-fixture.ts /tmp/twining-scale-fixture --decisions 500 --entries 500 --entities 500` (small smoke first), then full 5k run.
Expected: completes without error; `wc -l /tmp/twining-scale-fixture/.twining/blackboard.jsonl` ≈ 5000; `ls /tmp/twining-scale-fixture/.twining/decisions | wc -l` ≈ 5001 (incl. index.json); timestamps in JSONL span ~18 months.

- [ ] **Step 3: Verify the current dashboard can point at it** (baseline for later comparison): `npx tsx src/index.ts` is not needed — instead run the standalone check: start a scratch server with `handleRequest` or simply confirm `/tmp/twining-scale-fixture/.twining` loads by running the store classes in a node one-liner printing counts.

- [ ] **Step 4: Commit** (`twining_record` first, per global constraints).

```bash
git add scripts/seed-scale-fixture.ts package.json .twining/
git commit -m "feat(dashboard): seed-scale-fixture generator for 5k-record testing"
```

### Task 2: `/api/index` endpoint (compact index + delta + counts)

**Files:**
- Create: `src/dashboard/query-routes.ts`
- Modify: `src/dashboard/http-server.ts:149-190` (`handleRequest` — wire query handler first)
- Test: `test/dashboard/query-routes.test.ts`

**Interfaces:**
- Consumes: `DashboardDeps` (exported from `api-routes.ts`), `IBlackboardStore.read()`, `IDecisionStore.getIndex()`.
- Produces: `createQueryHandler(projectRoot: string, deps?: DashboardDeps)` with the same `(req,res) => Promise<boolean>` contract as `createApiHandler`; response shape below is what `store.js` (Task 7) parses — do not deviate:

```json
{
  "rows": [ { "id": "...", "kind": "blackboard", "timestamp": "...", "entry_type": "finding",
              "scope": "src/", "summary": "≤120 chars", "tags": ["..."] },
            { "id": "...", "kind": "decision", "timestamp": "...", "scope": "src/",
              "summary": "≤120 chars", "domain": "architecture", "status": "active",
              "confidence": "high" } ],
  "total_counts": { "blackboard": 5000,
                    "decisions": { "active": 4600, "provisional": 0, "superseded": 380, "overridden": 20 } },
  "generated_at": "ISO"
}
```

- [ ] **Step 1: Write failing tests** in `test/dashboard/query-routes.test.ts`, following the exact fixture pattern of `test/dashboard/api-routes.test.ts` (temp project, raw legacy files, `handleRequest(publicDir, projectRoot)`, `httpGet` helper — copy those helpers):
  - full index returns rows for every blackboard entry AND decision, sorted timestamp ascending, `kind` set correctly, summaries truncated to 120 chars (fixture must include one >120-char summary), blackboard rows have `entry_type` and no `status`, decision rows have `status`/`domain`/`confidence` and no `entry_type`
  - `?since=<ts>` returns only rows strictly newer, but `total_counts` still reflects the full store
  - decisions `total_counts` broken down by status (fixture: 2 active, 1 superseded)
  - gzip: request with `Accept-Encoding: gzip` gets `Content-Encoding: gzip` and a decompressable body (use `zlib.gunzipSync`)
  - uninitialized project (no `.twining/`) → `{ initialized: false, rows: [], ... }`

Run: `npx vitest run test/dashboard/query-routes.test.ts` — Expected: FAIL (endpoint 404s / falls through to static handler).

- [ ] **Step 2: Implement** `createQueryHandler` in `query-routes.ts`:

```ts
/**
 * Scale-oriented dashboard query endpoints (compact index, graph drill-down,
 * health report). Additive to api-routes.ts.
 * CRITICAL: never write to stdout — MCP owns it. console.error only.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import type { DashboardDeps } from "./api-routes.js";
import type { IBlackboardStore, IDecisionStore, IGraphStore } from "../storage/interfaces.js";

const SUMMARY_MAX = 120;

function truncate(s: string): string {
  return s.length <= SUMMARY_MAX ? s : s.slice(0, SUMMARY_MAX - 1) + "…";
}

/** Send JSON, gzipping when the client accepts it and the body is large. */
function sendJSON(req: http.IncomingMessage, res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  };
  if (acceptsGzip && body.length > 8192) {
    headers["Content-Encoding"] = "gzip";
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body));
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

export function createQueryHandler(
  projectRoot: string,
  deps?: DashboardDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const twiningDir = path.join(projectRoot, ".twining");
  const blackboardStore: IBlackboardStore = deps?.blackboardStore ?? new BlackboardStore(twiningDir);
  const decisionStore: IDecisionStore = deps?.decisionStore ?? new DecisionStore(twiningDir);
  const graphStore: IGraphStore = deps?.graphStore ?? new GraphStore(twiningDir);
  void graphStore; // used from Task 4 on

  return async (req, res) => {
    const url = req.url || "/";
    const parsed = new URL(url, "http://localhost");
    const route = parsed.pathname;

    if (route === "/api/index") {
      try {
        if (!fs.existsSync(twiningDir)) {
          sendJSON(req, res, { initialized: false, rows: [], total_counts: { blackboard: 0, decisions: { active: 0, provisional: 0, superseded: 0, overridden: 0 } }, generated_at: new Date().toISOString() });
          return true;
        }
        const since = parsed.searchParams.get("since");
        const [{ entries, total_count }, decIndex] = await Promise.all([
          blackboardStore.read(),
          decisionStore.getIndex(),
        ]);
        const decCounts = { active: 0, provisional: 0, superseded: 0, overridden: 0 } as Record<string, number>;
        for (const d of decIndex) decCounts[d.status] = (decCounts[d.status] ?? 0) + 1;

        const rows = [
          ...entries.map((e) => ({
            id: e.id, kind: "blackboard" as const, timestamp: e.timestamp,
            entry_type: e.entry_type, scope: e.scope, summary: truncate(e.summary),
            tags: e.tags.length ? e.tags : undefined,
          })),
          ...decIndex.map((d) => ({
            id: d.id, kind: "decision" as const, timestamp: d.timestamp,
            scope: d.scope, summary: truncate(d.summary),
            domain: d.domain, status: d.status, confidence: d.confidence,
          })),
        ]
          .filter((r) => !since || r.timestamp > since)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        sendJSON(req, res, {
          initialized: true, rows,
          total_counts: { blackboard: total_count, decisions: decCounts },
          generated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[twining] /api/index error:", err);
        sendJSON(req, res, { error: "Internal server error" }, 500);
      }
      return true;
    }

    return false;
  };
}
```

- [ ] **Step 3: Wire into `handleRequest`** (`http-server.ts`): create `const queryHandler = createQueryHandler(projectRoot, deps);` next to `apiHandler`, and try it first: `queryHandler(req, res).then((handled) => handled ? undefined : apiHandler(req, res)).then(...)` — preserve the existing health-check and static fallback flow and the `.catch` block exactly.

- [ ] **Step 4: Run tests.** `npx vitest run test/dashboard/query-routes.test.ts` → PASS. Then the full suite `npm test` → all existing tests still pass.

- [ ] **Step 5: Commit.** `git add src/dashboard/query-routes.ts src/dashboard/http-server.ts test/dashboard/query-routes.test.ts .twining/ && git commit -m "feat(dashboard): /api/index compact-index endpoint with delta + gzip"`

### Task 3: `/api/blackboard/:id` detail endpoint

**Files:** Modify: `src/dashboard/query-routes.ts`; Test: `test/dashboard/query-routes.test.ts`

**Interfaces:** Produces `GET /api/blackboard/:id` → full `BlackboardEntry` JSON, 404 `{error}` when missing. (Frontend detail panels rely on it from Task 8 on. Note: `IBlackboardStore` has no `get(id)` — implement via `read()` + find; ~5k-line scan per click is fine server-side.)

- [ ] **Step 1: Failing tests:** existing entry returns full body incl. `detail`; unknown id → 404; no `.twining/` → 404. Run → FAIL.
- [ ] **Step 2: Implement** inside `createQueryHandler` (before the `/api/index` block so prefixes can't collide with future routes): match `route.startsWith("/api/blackboard/")`, slice the id, `(await blackboardStore.read()).entries.find((e) => e.id === id)`. **Careful:** the legacy `/api/blackboard` (exact match) lives in `api-routes.ts`; since queryHandler runs first and only matches the *prefixed* form, both coexist.
- [ ] **Step 3: Run tests** → PASS; `npm test` → green.
- [ ] **Step 4: Commit.** `git commit -m "feat(dashboard): blackboard detail endpoint"`

### Task 4: `/api/graph/summary` + `/api/graph/entities`

**Files:** Modify: `src/dashboard/query-routes.ts`; Test: `test/dashboard/query-routes.test.ts`

**Interfaces:** Produces (consumed verbatim by `graph-view.js`, Task 12):

```json
GET /api/graph/summary ->
{ "initialized": true,
  "groups": [ {"type": "file", "count": 192} ],
  "group_edges": [ {"source_type": "file", "target_type": "function",
                     "relation_counts": {"contains": 40}, "total": 57} ],
  "hubs": [ {"id": "...", "name": "...", "type": "file", "degree": 31} ],
  "orphan_count": 12, "entity_count": 425, "relation_count": 905 }

GET /api/graph/entities?type=file&sort=degree&offset=0&limit=50&q=substr ->
{ "entities": [ {"id","name","type","degree"} ], "total": 192, "offset": 0 }
```

- [ ] **Step 1: Failing tests** (fixture: 6 entities across 3 types, 5 relations incl. one orphan entity):
  - summary: groups have correct counts; `group_edges` aggregates by unordered type-pair with per-relation-type counts; hubs sorted degree desc; orphan_count correct
  - entities: filter by `type`, sort by degree desc then name asc, `offset/limit` paging, `q` substring on name (case-insensitive), `total` = filtered count pre-paging
- [ ] **Step 2: Implement.** Shared helper `buildDegreeMap(relations): Map<string, number>` (each relation increments source and target). Summary groups: count `Entity.type`; group_edges key = `srcType + "→" + tgtType` using each relation's endpoint entity types (skip relations with missing endpoints); hubs = top 20 by degree. Entities route: build once per request from `getEntities()` + degree map; apply q/type filter → sort → slice.
- [ ] **Step 3: Tests PASS; `npm test` green.**
- [ ] **Step 4: Commit.** `git commit -m "feat(dashboard): graph summary + paged entity list endpoints"`

### Task 5: `/api/graph/neighborhood`

**Files:** Modify: `src/dashboard/query-routes.ts`; Test: `test/dashboard/query-routes.test.ts`

**Interfaces:** Produces (consumed by ego explorer, Task 13):

```json
GET /api/graph/neighborhood?id=E1&depth=1&limit=150 ->
{ "anchor": "E1",
  "entities": [ {"id","name","type","degree"} ],      // includes anchor
  "relations": [ {"id","source","target","type"} ],   // all relations among included entities
  "overflow": [ {"from": "E1", "type": "file", "omitted": 34} ] }

GET /api/graph/neighborhood?id=E1&type=file&offset=20&limit=20 ->   // overflow paging variant
{ "anchor": "E1", "entities": [...], "relations": [...], "total_of_type": 54 }
```

**Selection algorithm (deterministic — tests depend on it):**
1. Neighbors of a node = entities on the other end of any relation touching it. Sort every candidate list by (degree desc, name asc).
2. Depth 1: group anchor's neighbors by entity type. Fill by round-robin across types (take the best remaining from each non-empty type group in type-name alphabetical order) until `limit - 1` nodes are chosen or groups empty. Per-type leftovers become `overflow` entries with `from = anchor`.
3. Depth 2: with remaining budget, walk chosen depth-1 nodes in (degree desc, name asc) order; for each, add its not-yet-included neighbors (same sort) until budget exhausted; record per-node overflow only when a node had neighbors cut.
4. Include every relation whose endpoints are both in the included set.
5. `type`+`offset` variant: sorted neighbors of `id` filtered to `type`, slice `offset..offset+limit`; relations returned are those linking the returned page to `id`.

- [ ] **Step 1: Failing tests:** star fixture (anchor + 30 neighbors of 2 types, limit 11 → 5+5 round-robin + overflow counts 10/10); determinism (two identical calls, identical JSON); depth=2 pulls second ring within budget; unknown id → 404; paging variant returns slice + `total_of_type`.
- [ ] **Step 2: Implement** exactly per the algorithm. Build adjacency `Map<string, Relation[]>` once per request.
- [ ] **Step 3: Tests PASS; suite green.**
- [ ] **Step 4: Commit.** `git commit -m "feat(dashboard): capped deterministic graph neighborhood endpoint"`

### Task 6: `/api/health-report`

**Files:** Modify: `src/dashboard/query-routes.ts`; Test: `test/dashboard/query-routes.test.ts`

**Interfaces:**
- Consumes: `runStalenessAudit`/equivalent from `src/engine/staleness.ts` (verify the exported audit entry point's exact name and signature there — `scoreItem`/`buildProbes` exist; there may be a higher-level function. If only the primitives exist, compose them: score every decision index entry + blackboard entry with `buildProbes(projectRoot)`, threshold from config default 0.95), `IHandoffStore.list()` + handoff acknowledged field (check `HandoffIndexEntry` in types.ts), `IDecisionStore.get()` for chain links.
- Produces (consumed by `health.js`, Task 14) — every list capped at 50, sorted worst-first:

```json
{ "stale_decisions": [ {"id","summary","scope","score","reasons":["..."]} ],
  "unresolved_warnings": [ {"id","summary","scope","age_days"} ],
  "superseded_chains": [ {"head_id","head_summary","length"} ],
  "orphan_entities": {"count": 12, "sample": [ {"id","name","type"} ]},
  "unacknowledged_handoffs": [ {"id","summary","age_days"} ],
  "generated_at": "ISO" }
```

- [ ] **Step 1: Failing tests:** fixture with 1 decision whose scope path doesn't exist (→ stale), 2 warnings with different ages (sorted oldest first), a 3-link superseded chain (A superseded_by B superseded_by C → chain head C reported with length 3), 1 orphan entity, 1 unacknowledged handoff.
- [ ] **Step 2: Implement.** Superseded chains: read full decisions for index entries with `status === "superseded"` only (bounded by superseded count, not total); build `superseded_by` link map; walk to terminal head; report chains length ≥ 2, longest first. **Cache the whole report in the closure for 60s** (`{at: number, body: unknown}`) — chain-building reads O(superseded) files and must not run on every poll.
- [ ] **Step 3: Tests PASS; suite green.**
- [ ] **Step 4: Run the endpoint against the 5k fixture** (standalone server on the fixture root) and confirm response < 2s cold, < 10ms warm (cache).
- [ ] **Step 5: Commit.** `git commit -m "feat(dashboard): health-report endpoint with 60s cache"`

---

## Phase 2 — Frontend foundation: index store + virtualized lists

### Task 7: `store.js` — client index store (logic unit-tested in vitest)

**Files:**
- Create: `src/dashboard/public/js/store.js`
- Test: `test/dashboard/store-logic.test.ts` (imports the .js module directly — vitest handles ESM; no DOM used in store.js)

**Interfaces:** Produces the `createIndexStore` contract from the File Structure section — copy the signatures from there. Key behaviors:

- `load()`: GET `/api/index`, replace `rows`, record `counts`, notify.
- `poll(statusBody)`: compare `statusBody.blackboard_entries` + decision status counts against `store.counts`; when unchanged → no-op. When changed → GET `/api/index?since=<latest row timestamp>`; merge (append + resort; dedupe by id keeping newest); then **validate**: if local per-kind/per-status counts ≠ response `total_counts` → one `load()` full refetch (never loop).
- `filter(f)`: single pass; scope matches by prefix (`row.scope.startsWith(f.scope)`); `text` is case-insensitive substring on summary; date range on timestamp; array fields OR-within, AND-across.
- `facetCounts(f, field)`: counts for `field` values with `f` applied except `f[field]` (standard faceted-search semantics).
- `scopeChildren(f, prefix)`: for rows matching `f` (ignoring scope) whose scope starts with `prefix`, extract next path segment; return sorted by count desc.

- [ ] **Step 1: Failing tests** with a stubbed `fetchImpl` (plain function returning canned Responses — use `new Response(JSON.stringify(body))`):
  - load populates + sorts rows
  - poll with unchanged counts issues no fetch
  - poll with changed counts fetches delta and merges without duplicates
  - poll where merged counts mismatch server counts triggers exactly one full refetch
  - status-flip scenario: decision goes active→superseded server-side (counts change, no new rows) → full refetch path picks it up (this is the spec §1.1 resolution — count comparison, not `updated_at`)
  - filter/facetCounts/scopeChildren semantics incl. scope-prefix and facet-exclusion rule
- [ ] **Step 2: Implement `store.js`** (pure ESM, no DOM; `fetchImpl` injected for tests, defaults to `globalThis.fetch`).
- [ ] **Step 3: Tests PASS.**
- [ ] **Step 4: Commit.** `git commit -m "feat(dashboard): client index store with delta merge + facets"`

### Task 8: `list-view.js` + replace the Blackboard tab list

**Files:**
- Create: `src/dashboard/public/js/list-view.js`, `src/dashboard/public/js/main.js`, `src/dashboard/public/js/util.js`
- Modify: `src/dashboard/public/index.html` (add `<script type="module" src="js/main.js" defer></script>` after app.js; replace the blackboard table container with `<div id="blackboard-listview"></div>` + keep the existing detail panel markup), `src/dashboard/public/style.css` (list + facet styles), `src/dashboard/public/app.js` (delete `renderBlackboard` + its pagination wiring; `fetchBlackboard` stays only for the Stats tab's recent-activity use — check `renderRecentActivity` and keep whatever it needs)
- Verify: Playwright against the 5k fixture

**Interfaces:**
- Consumes: `createIndexStore` (main.js instantiates ONE store shared by all views; expose as `window.__twiningStore` for the transition so later tasks and debugging can reach it), `/api/blackboard/:id` for detail.
- Produces: `createListView(container, {store, kinds, columns, onSelect, rowHeight})` per File Structure block. Virtualization contract: absolute-positioned rows inside a spacer div of height `rowCount * rowHeight`; render only `ceil(viewportH/rowHeight) + 2*10` overscan rows on scroll (rAF-throttled); DOM row count NEVER exceeds ~60 regardless of dataset.

- [ ] **Step 1: Build `util.js`** — move (copy, don't yet delete) `el/clearElement/formatTimestamp/truncate/debounce` from app.js as exports.
- [ ] **Step 2: Build `list-view.js`**: header facet bar (chips per facet value with live counts from `store.facetCounts`, click toggles, text input debounced 150ms), windowed body, day-group sticky headers (a group header row is injected when the day changes between consecutive rows — include these in row-position math), timestamp-desc default sort, selection highlight, `onSelect(row)` callback.
- [ ] **Step 3: Wire Blackboard tab in `main.js`**: on tab switch to blackboard (listen to existing tab buttons via event delegation — do NOT modify app.js's switchTab), mount the list view filtered to `kinds:['blackboard']` with columns type/summary/scope/time; `onSelect` fetches `/api/blackboard/:id` and renders into the existing detail panel using a new exported `renderBlackboardDetail` moved into `main.js` (copy the logic from app.js, keep textContent-only rendering). Delete app.js's `renderBlackboard` and its callers.
- [ ] **Step 4: Verify with Playwright on the 5k fixture** (start a standalone dashboard against `/tmp/twining-scale-fixture`): blackboard tab shows rows; `document.querySelectorAll('#blackboard-listview .lv-row').length < 70` while total shows 5000; scroll to bottom stays smooth; facet chip click filters instantly; selecting a row loads full detail. Take a screenshot for the record.
- [ ] **Step 5: Run `npm test` (nothing broke server-side), commit.** `git commit -m "feat(dashboard): virtualized faceted list view, blackboard tab at 5k"`

### Task 9: Decisions table view on `list-view.js`

**Files:** Modify: `src/dashboard/public/js/main.js`, `index.html` (decisions table container → `<div id="decisions-listview">`), `app.js` (delete `renderDecisions` list rendering; keep `renderDecisionDetail` — move it to `main.js` as-is), `style.css`

**Interfaces:** Consumes `createListView` with `kinds:['decision']`, columns status/summary/domain/scope/confidence/time, facets status+domain+confidence; `onSelect` → existing `/api/decisions/:id` → moved `renderDecisionDetail`.

- [ ] **Step 1: Mount + wire exactly as Task 8 did for blackboard.**
- [ ] **Step 2: Playwright verify at 5k:** facet counts match totals, superseded rows struck through (reuse existing `getDecisionClassName` logic moved into main.js), detail panel works, DOM bounded.
- [ ] **Step 3: Commit.** `git commit -m "feat(dashboard): decisions table on virtualized list"`

---

## Phase 3 — Density timeline

### Task 10: `timeline-scale.js` — pure math (TDD)

**Files:** Create: `src/dashboard/public/js/timeline-scale.js`; Test: `test/dashboard/timeline-scale.test.ts`

**Interfaces:** Produces (consumed by Task 11): `chooseBucket(spanMs)` → one of `{unit:'hour'|'day'|'week'|'month'|'year', ms}` targeting 60–120 buckets for the span (test the boundaries: 3-day span → hour, 3-month span → day, 2-year span → week/month); `bucketize(rows, fromMs, toMs, bucketMs, colorKey)` → array of `{t0, counts: Map, total}` where `colorKey` is `'domain'` or `'status'` (blackboard rows bucket under their `entry_type` when colorKey is `'status'`); `makeScale(fromMs, toMs, widthPx)` → `{x, t}` linear transforms (round-trip property test).

- [ ] **Step 1: Failing tests** for all three (incl. empty rows → empty buckets; rows outside range excluded; bucket alignment to unit boundaries — floor to UTC day/hour etc.).
- [ ] **Step 2: Implement; tests PASS.**
- [ ] **Step 3: Commit.** `git commit -m "feat(dashboard): timeline bucketing math"`

### Task 11: `density-timeline.js` + replace vis-timeline

**Files:**
- Create: `src/dashboard/public/js/density-timeline.js`
- Modify: `main.js` (mount in decisions timeline view; synced list below reuses `createListView` with a range filter), `index.html` (remove vis-timeline `<script>`/`<link>` tags; timeline container → `<canvas>` wrapper + list container; keep the existing toolbar buttons/ids), `app.js` (delete `initTimeline`, `buildTimelineGroups`, `buildTimelineItems`, `updateTimelineData`, `wireTimelineControls`, `fetchTimelineDecisionDetail`, timeline legend/domain-filter functions), `style.css`
- Delete: `src/dashboard/public/vendor/vis-timeline-graph2d.min.js`, `vendor/vis-timeline-graph2d.min.css`
- Verify: Playwright at 5k

**Interfaces:** Consumes `timeline-scale.js` exports + shared store. Produces `createDensityTimeline(container, {store, onSelect, onRangeChange})` per File Structure block.

**Component behavior contract (implement exactly):**
- State: `{fromMs, toMs}` visible range (init = full data extent padded 2%), colorKey, current filter.
- Render (one rAF per invalidation, canvas sized to devicePixelRatio): x-axis with unit ticks; stacked bars per bucket colored by colorKey using the existing CSS palette variables (read via `getComputedStyle`); **mode switch**: when `store.filter(f∩range).length < 150` draw individual lozenges (rounded rects, 3 per stack row max, superseded struck) instead of bars; legend text for current mode.
- Wheel: zoom ×1.15 centered on cursor time; drag: pan; shift+drag: brush selection → `onRangeChange({from,to})` (main.js sets the synced list's filter); click on lozenge (hit-test) → `onSelect(row)`; toolbar buttons: zoom in/out ×1.4, fit (data extent), today (center on now, keep span).
- Domain filter chips (existing UI position) re-render from `store.facetCounts` and set the component filter.

- [ ] **Step 1: Implement the component** (~350 lines).
- [ ] **Step 2: Wire + delete** old code paths and vendor files; grep for `vis` / `timelineInstance` in the tree to confirm zero references remain: `grep -rn "vis-timeline\|timelineInstance\|vis\.Timeline" src/ --include="*.js" --include="*.html"` → no hits.
- [ ] **Step 3: Playwright verify at 5k:** timeline tab renders < 1s; wide zoom shows bars; zooming into a burst switches to lozenges; brush updates the synced list; click opens decision detail; screenshot both modes.
- [ ] **Step 4: `npm test` green (postbuild copies public/ — run `npm run build` to confirm no TS breakage and the copy works).**
- [ ] **Step 5: Commit.** `git commit -m "feat(dashboard): canvas density timeline, vis-timeline removed"`

---

## Phase 4 — Graph drill-down explorer

### Task 12: Overview + entity list (drill levels 0–1)

**Files:**
- Create: `src/dashboard/public/js/graph-view.js`
- Modify: `main.js` (own the graph tab's Visual view), `index.html` (side panel containers for hubs/orphans/entity list), `app.js` (delete `initGraphVis`, `buildGraphElements`, `updateGraphData`, `expandNeighbors`, graph type-filter functions — the render-everything path dies here; keep the graph Table view functions until Step 4), `style.css`
- Verify: Playwright at 5k

**Interfaces:** Consumes `/api/graph/summary`, `/api/graph/entities`; cytoscape global (already vendored). Produces `createGraphView(container, {onEntitySelect})`; internal drill state `{level: 'overview'|'ego', anchor?}`.

**Behavior contract:**
- Overview: one cytoscape node per type (label `type (count)`, diameter ∝ sqrt(count), existing per-type palette), edges width ∝ log(total), layout `circle` (deterministic, instant — cose is unnecessary for ≤10 nodes). Side panel: top-hubs list (name, type, degree; click → ego view Task 13) and orphan count.
- Click a type node → side panel swaps to the paged entity list for that type (search box → `q=`, infinite "load more" via offset; each row click → ego view).
- Graph Table view: repoint at `/api/graph/entities` paging (replaces full-dataset `fetchGraph` + client pagination; delete `renderGraph` after).

- [ ] **Step 1: Implement overview + entity list panel.**
- [ ] **Step 2: Wire tab, delete legacy graph code listed above; `grep -n "buildGraphElements\|initGraphVis" src/dashboard/public -r` → no hits.**
- [ ] **Step 3: Playwright verify at 5k:** overview renders instantly with ~6 type nodes (never a hairball); type-node click lists entities sorted by degree; search filters. Screenshot.
- [ ] **Step 4: Commit.** `git commit -m "feat(dashboard): graph overview meta-graph + entity drill list"`

### Task 13: Ego explorer (drill level 2)

**Files:** Modify: `graph-view.js`, `main.js`, `style.css`; Verify: Playwright at 5k

**Interfaces:** Consumes `/api/graph/neighborhood` (both variants). Entity links elsewhere (detail panels' related-entity ids) call `window.__twiningGraphFocus(entityId)` which main.js exposes → switches to graph tab in ego mode.

**Behavior contract:**
- Load neighborhood (depth 1, limit 150); layout `concentric` (anchor center, ring by distance... anchor + depth rings). Overflow chips rendered as special cytoscape nodes labeled `+34 file` — tapping one calls the paging variant (`offset` = currently shown of that type, `limit` 20) and adds nodes; if total shown would exceed 200, first evict lowest-degree non-anchor leaf nodes (visible count stays ≤ 200).
- Tap a normal node → re-anchor: push current anchor onto a breadcrumb trail (rendered above the canvas; click any crumb to return); fetch that node's neighborhood fresh.
- 404 on fetch (pruned entity) → toast (reuse/add a 3s dismissible banner) + return to overview.
- Detail side panel: reuse the moved `renderGraphDetail` logic on tap.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Playwright verify at 5k:** hub click from overview opens ego view ≤ 150 nodes; overflow chip pages in more; re-anchor + breadcrumb back work; node count stays ≤ 200 (`window.cyInstance` is gone — expose the instance as `window.__twiningCy` for verification and debugging: `window.__twiningCy.nodes().length`). Screenshot.
- [ ] **Step 3: `npm test` + `npm run build` green. Commit.** `git commit -m "feat(dashboard): ego-network graph explorer with overflow paging"`

---

## Phase 5 — Health, scope navigation, routing, cleanup

### Task 14: Health section in Insights

**Files:** Create: `src/dashboard/public/js/health.js`; Modify: `main.js`, `index.html` (health container at top of Insights tab), `style.css`

**Interfaces:** Consumes `/api/health-report`; produces cards that deep-link via `router.js` routes (Task 16) — until Task 16 lands, card clicks call the direct view APIs (`listView.setFilter`) — wire through a small `navigate({tab, filter})` helper in main.js that Task 16 will reroute through the router.

- [ ] **Step 1: Implement 5 cards** (stale decisions, warnings by age, superseded chains, orphans, unacked handoffs) with counts + top-3 preview rows each; empty-state text per card.
- [ ] **Step 2: Playwright verify on 5k fixture (it seeds superseded chains + warnings).**
- [ ] **Step 3: Commit.** `git commit -m "feat(dashboard): health panel in insights"`

### Task 15: Scope breadcrumb

**Files:** Create: `src/dashboard/public/js/scope-nav.js`; Modify: `main.js`, `index.html` (replace `#global-scope` free-text input in the header), `app.js` (delete `applyGlobalScope` once no callers remain — remaining legacy callers (agents/search) keep reading the same `state.globalScope` variable, so **write the chosen scope back to `state.globalScope`** for compatibility), `style.css`

**Interfaces:** Consumes `store.scopeChildren`; produces a breadcrumb (root ▸ src/ ▸ dashboard/) where each segment opens a dropdown of children with counts + a free-text row; emits scope to: all list views, density timeline, health (client-side filters) — via a shared `setGlobalScope(scope)` in main.js that updates every mounted view and `state.globalScope`.

- [ ] **Step 1: Implement + wire.**
- [ ] **Step 2: Playwright verify:** selecting `src/` filters lists + timeline; counts in dropdown match facet totals; free-text still works.
- [ ] **Step 3: Commit.** `git commit -m "feat(dashboard): scope breadcrumb navigation"`

### Task 16: Hash routing

**Files:** Create: `src/dashboard/public/js/router.js`; Modify: `main.js` (all view mounts read initial state from route; view interactions call `writeRoute`), `app.js` `switchTab` (one-line addition: call `window.__twiningRoute?.({tab})` if defined)

**Interfaces:** Route format: `#/<tab>?scope=src/&f=<URI-encoded JSON filter>&sel=<id>&range=<fromMs>-<toMs>&anchor=<entityId>`. `readRoute/writeRoute/onRouteChange` per File Structure block; `replaceState` for filter tweaks, `pushState` for tab/selection changes (back button = previous view).

- [ ] **Step 1: Implement router + wire all views (tab, scope, list filters, selected record, timeline range, graph anchor).**
- [ ] **Step 2: Playwright verify:** deep-link URL reload restores tab+scope+filter+selection; back button returns from ego view to overview.
- [ ] **Step 3: Commit.** `git commit -m "feat(dashboard): shareable hash routing"`

### Task 17: Cleanup + full-scale verification pass

**Files:** Modify: `app.js` (delete now-dead code: `paginate`, `renderPagination`, `sortData`/`handleSort` if orphaned, dead fetches; verify each with grep before deleting), `index.html`, `style.css` (orphaned rules); Docs: update `TWINING-DESIGN-SPEC.md` dashboard section + `README.md` if it mentions the dashboard views.

- [ ] **Step 1: Dead-code sweep** — for each candidate function: `grep -n "<name>" src/dashboard/public -r`; delete when the only hit is its definition. Run the dashboard after each batch.
- [ ] **Step 2: Full Playwright scale pass on the 5k fixture, all tabs:** first-paint timing (< 1s target — measure via `performance.timing` or navigation timing), every view's DOM bounded, console has zero errors across the whole session (`browser_console_messages`), light + dark themes both rendered (screenshots).
- [ ] **Step 3: Regression pass on THIS repo's real `.twining/`** (425 entities / 240 entries / 203 decisions): all tabs render, detail panels work, Stats/Search/Agents untouched surfaces still fine.
- [ ] **Step 4: `npm test` + `npm run build` green.**
- [ ] **Step 5: Final commit + `twining_record`** with per-phase decisions and any discovered-need notes accumulated along the way. `git commit -m "chore(dashboard): remove dead render paths, scale verification pass"`

---

## Self-review (done at plan time)

- **Spec coverage:** §1.1→T2, §1.2→T3, §1.3→T4+T5, §1.4→T6, §1.5→T7 (poll) + main.js wiring in T8, §2→T10+T11, §3→T12+T13, §4→T8+T9, §5→T14+T15+T16, §6→T7-T16 file layout + T17 cleanup, §7 error handling→T7 (refetch), T13 (404 toast), T11 (empty guards), §8→T1 (fixture), per-task tests + T17 verification pass. No gaps found.
- **Spec §1.1 decision point resolved in T7:** status flips are caught by per-status count comparison from `/api/status`+`/api/index` `total_counts`, triggering full refetch — no store `updated_at` needed.
- **Type consistency:** `createIndexStore/createListView/createDensityTimeline/createGraphView/readRoute/writeRoute` names match between File Structure block and all consuming tasks; endpoint JSON shapes stated once in the producing task and referenced by consumers.
- **Known implementation-time checks (criteria stated in-task):** staleness audit entry-point name (T6), `Decision` supersession field name (T1/T6), `HandoffIndexEntry` acknowledged field (T6), `renderRecentActivity`'s data dependency (T8).
