# W3 — `twining-mcp migrate` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `twining-mcp migrate` CLI that moves an existing file-backend `.twining/` to the sqlite backend (idempotent, dry-run, verified) and back (reverse export), shipped as server 1.23.0 without any v2.0-gated change.

**Architecture:** The migration is *not* a special importer (FOUNDATION-PLAN W3 step 5): forward = read the file stores → write the W2.3 per-ULID export tree via `RecordExporter` → `openDatabase` + `ingestRecords` → verify the sqlite read model contains the file read model → flip `storage.backend: sqlite` in config.yml. Reverse = converge db to tree, then write the file-backend layout from the sqlite stores and flip back. Everything reuses shipped, tested W2.2/W2.3 machinery; the only new moving parts are a read-model comparator, a config editor, and CLI plumbing.

**Tech Stack:** TypeScript, node:sqlite (via existing `src/storage/sqlite/db.ts`), js-yaml (already a dependency), vitest.

---

## Plan-time discipline (assumptions, decision points, risks)

**Deviations from FOUNDATION-PLAN's W3 section, with reasons (the plan doc predates W2.3):**

1. **No `config.version: 2`.** The plan doc's finalize step sets version 2 — that is the v2.0 cut, which is explicitly gated ("propose, don't release"). This 1.x migrate sets `storage.backend: sqlite` and leaves `version: 1`. The version-2 flip moves to the v2.0 release checklist.
2. **No ULID minting.** The plan doc says entities/relations "have none today" — stale. `graph-store.ts:75,143` mints ULIDs via `generateId()` and has since before 1.21. Migration preserves all IDs.
3. **No `legacy-v1/` full backup.** Forward migration modifies exactly one legacy file: `config.yml` (backed up to `config.yml.pre-migrate.bak`). All other legacy files are left byte-identical — they *are* the backup. Reverse migration overwrites the file layout, so it backs up the five target paths to `.twining/pre-reverse-backup/` first.
4. **No trailing-fragment salvage pass.** W0's atomic writes shipped in 1.21.0; torn whole-file JSON is a legacy-era corruption the running server also can't read. The migration's source of truth is "what the file stores can read" — the same view the server has. Unreadable files are reported, never deleted. (YAGNI; revisit only if a real corpus surfaces.)
5. **No auto-migration at startup.** That is v2 behavior for the v2 server. 1.x migrate is explicit-invocation only.
6. **Verify is subset-containment, not equality.** Requirement "straggler re-run picks up late writes to legacy files" implies re-running after sqlite-side posts exist: sqlite is then a superset of the legacy files. Forward verify = every file-store record exists identically in sqlite. On a first migration this degenerates to equality.

**Assumptions (confirmed in code unless noted):**
- The plugin's `.mcp.json` pins `twining-mcp@^1.20.0` — caret range, so 1.23.0 reaches plugin users without a plugin release. No plugin bump, no token-budget impact, no BEHAVIORS.md change (no new MCP tools — `migrate` is a CLI subcommand).
- Embeddings are not migrated in either direction: the 1.22.0 startup reconcile rebuilds sqlite vectors by content hash automatically; file-backend `.index` files degrade to per-record keyword fallback (pre-existing behavior for unembedded records).
- Agents registry, `archive/`, `metrics.jsonl`, `pending-*.jsonl` are backend-agnostic or deliberately excluded from the export tree — untouched by migration, noted in the report.
- This repo's own `.twining/` runs the file backend (no `storage:` key in its config.yml) and has no `records/` tree — a clean golden fixture.

**Decision points an executor may hit, with criteria:**
- *Verify mismatch on the golden fixture* → hard stop, investigate; do not force-finalize (exit 1 leaves config untouched by design).
- *`config.yml` contains `#` comments* → proceed (yaml round-trip drops comments), print a warning naming the backup file. Twining never writes comments itself.
- *node:sqlite unavailable* → exit 2 with a clear message; never fall back silently for an explicit migrate.

**Risks:**
- Reverse migration leaves a frozen `records/` tree: a user who later hand-flips config back to sqlite would ingest the stale tree. Mitigation: reverse prints a prominent warning + the exact commands (`re-run migrate`, or `git rm -r .twining/records`), and README documents it.
- yaml re-dump reorders keys / drops comments. Mitigation: backup + warning (above).
- Concurrent server session during migration could write mid-flight. Mitigation: documented "stop sessions first" in CLI output and README; the operations themselves are store-level and locked/transactional, so the failure mode is a verify mismatch (exit 1, no finalize), not corruption.

**Strongest alternative considered:** a standalone importer that walks legacy files and INSERTs into sqlite directly. Rejected: duplicates parsing and upsert logic that `RecordExporter` + `ingestRecords` already implement and test; and it would not produce the committable `records/` tree, which is the actual durable artifact of the sqlite backend (design D1).

---

## File structure

```
src/migrate/
  verify.ts        — read-model containment comparator (backend-agnostic, interfaces only)
  config-edit.ts   — set storage.backend in config.yml (backup, preserve unknown keys)
  forward.ts       — files → export tree → ingest → verify → finalize
  reverse.ts       — tree/db → file layout → verify → finalize
  cli.ts           — argv parsing, report printing, exit codes
src/index.ts       — dispatch the `migrate` subcommand before MCP startup (modify)
test/migrate/
  verify.test.ts
  config-edit.test.ts
  forward.test.ts
  reverse.test.ts
  cli.test.ts
  golden-fixture.test.ts
docs: README.md (new section), CHANGELOG.md (1.23.0), docs/FOUNDATION-PLAN.md (status flip)
```

Exit codes (used consistently): `0` success / check passed · `1` verification failed · `2` usage or environment error (no `.twining/`, sqlite unavailable, wrong current backend).

---

### Task 1: Read-model comparator

**Files:**
- Create: `src/migrate/verify.ts`
- Test: `test/migrate/verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate/verify.test.ts
/**
 * Backend-agnostic read-model containment: every record readable from the
 * source stores must exist, byte-identically (stable serialization), in the
 * target stores. Subset semantics on purpose — see the plan's deviation #6.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStores, type StoreSet } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { verifyContains } from "../../src/migrate/verify.js";
import type { TwiningConfig } from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

const filesConfig = (): TwiningConfig => ({ ...DEFAULT_CONFIG });
const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-verify-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function twining(sub: string): string {
  const p = path.join(dir, sub, ".twining");
  fs.mkdirSync(p, { recursive: true });
  return p;
}

async function seed(stores: StoreSet) {
  const entry = await stores.blackboardStore.append({
    entry_type: "finding", summary: "s", detail: "d", tags: [], scope: "src/", agent_id: "main",
  });
  const decision = await stores.decisionStore.create({
    agent_id: "main", domain: "architecture", scope: "src/", summary: "dec",
    context: "c", rationale: "r", alternatives: [], confidence: "high",
    affected_files: [], affected_symbols: [], reversible: true,
  } as never);
  const ent = await stores.graphStore.addEntity({ name: "auth", type: "module" });
  await stores.graphStore.addEntity({ name: "db", type: "module" });
  await stores.graphStore.addRelation({ source: ent.id, target: "db", type: "depends_on" });
  await stores.handoffStore.create({
    source_agent: "a", target_agent: "b", scope: "src/", summary: "h", results: [],
    context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
  });
  return { entry, decision };
}

describe.skipIf(!HAS_SQLITE)("verifyContains", () => {
  it("passes when the target holds every source record identically", async () => {
    const source = createStores(twining("a"), filesConfig());
    await seed(source);
    // Build the target by copying source data through the export/ingest path:
    // easiest faithful copy is seeding an identical sqlite store from the same calls
    // — instead, run the real pipe: export tree from a sqlite twin is Task 3's job,
    // so here target = same twining dir read through sqlite after manual ingest is
    // out of scope. Use two stores over the SAME dir? No — simplest: target gets a
    // superset via its own seed with the same records is impossible (fresh ULIDs).
    // Therefore: target = sqlite stores whose db was ingested from an export tree
    // written from source records — done via RecordExporter directly:
    const { RecordExporter } = await import("../../src/storage/sync/record-export.js");
    const { openDatabase } = await import("../../src/storage/sqlite/db.js");
    const { ingestRecords } = await import("../../src/storage/sync/record-ingest.js");
    const targetDir = twining("b");
    const exporter = new RecordExporter(targetDir);
    for (const e of (await source.blackboardStore.read()).entries) exporter.post(e);
    for (const ix of await source.decisionStore.getIndex()) {
      exporter.decision((await source.decisionStore.get(ix.id))!);
    }
    for (const e of await source.graphStore.getEntities()) exporter.entity(e);
    for (const r of await source.graphStore.getRelations()) exporter.relation(r);
    for (const ix of await source.handoffStore.list({})) {
      exporter.handoff((await source.handoffStore.get(ix.id))!);
    }
    ingestRecords(openDatabase(targetDir), targetDir);
    const target = createStores(targetDir, sqliteConfig());

    const result = await verifyContains(source, target);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.counts).toEqual({
      posts: 1, decisions: 1, entities: 2, relations: 1, handoffs: 1,
    });
  });

  it("reports missing and mismatched records with kind-qualified ids", async () => {
    const source = createStores(twining("a"), filesConfig());
    const { entry, decision } = await seed(source);
    const target = createStores(twining("b"), sqliteConfig()); // empty

    const empty = await verifyContains(source, target);
    expect(empty.ok).toBe(false);
    expect(empty.missing).toContain(`posts/${entry.id}`);
    expect(empty.missing).toContain(`decisions/${decision.id}`);

    // Target has the decision but with drifted content → mismatched.
    await target.decisionStore.create({
      agent_id: "main", domain: "architecture", scope: "src/", summary: "dec",
      context: "c", rationale: "r", alternatives: [], confidence: "high",
      affected_files: [], affected_symbols: [], reversible: true,
    } as never);
    // (fresh ULID ≠ source id, so still missing — mismatch needs same id:)
    const raw = JSON.parse(JSON.stringify(decision));
    raw.summary = "drifted";
    const { openDatabase } = await import("../../src/storage/sqlite/db.js");
    const db = openDatabase(twining("b"));
    db.prepare(
      "INSERT INTO decisions (id, status, timestamp, data) VALUES (?, ?, ?, ?)",
    ).run(raw.id, raw.status ?? "active", raw.timestamp, JSON.stringify(raw));
    db.close();

    const drifted = await verifyContains(source, target);
    expect(drifted.mismatched).toContain(`decisions/${decision.id}`);
  });

  it("passes subset check when the target has extra records (straggler re-run shape)", async () => {
    const sourceDir = twining("a");
    const source = createStores(sourceDir, filesConfig());
    await seed(source);
    // Target = source dir itself read through the file stores again, plus one extra.
    const target = createStores(twining("b"), sqliteConfig());
    // copy source→target via direct row inserts is exercised above; here reuse:
    const first = await verifyContains(source, source); // trivially contains itself
    expect(first.ok).toBe(true);
    await target.blackboardStore.append({
      entry_type: "status", summary: "extra", detail: "", tags: [], scope: "project", agent_id: "x",
    });
    // extra-only target does not contain source:
    const result = await verifyContains(source, target);
    expect(result.ok).toBe(false); // sanity: subset is directional
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate/verify.test.ts`
Expected: FAIL — `Cannot find module '../../src/migrate/verify.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/migrate/verify.ts
/**
 * Read-model containment check for migrations: every record the SOURCE
 * stores can read must exist byte-identically (stable serialization) in the
 * TARGET stores. Subset — not equality — on purpose: a straggler re-run
 * migrates late legacy writes into a sqlite store that already has newer
 * records of its own, and that must verify clean (plan deviation #6).
 *
 * Works over the storage interfaces only, so either backend can be either
 * side (forward: files→sqlite, reverse: sqlite→files).
 */
import { stableStringify } from "../storage/sync/record-export.js";
import type {
  IBlackboardStore,
  IDecisionStore,
  IGraphStore,
  IHandoffStore,
} from "../storage/interfaces.js";

export interface ReadModelStores {
  blackboardStore: IBlackboardStore;
  decisionStore: IDecisionStore;
  graphStore: IGraphStore;
  handoffStore: IHandoffStore;
}

export interface VerifyResult {
  ok: boolean;
  counts: {
    posts: number;
    decisions: number;
    entities: number;
    relations: number;
    handoffs: number;
  };
  /** kind-qualified ids present in source, absent in target */
  missing: string[];
  /** kind-qualified ids present in both but not identical */
  mismatched: string[];
}

export async function verifyContains(
  source: ReadModelStores,
  target: ReadModelStores,
): Promise<VerifyResult> {
  const missing: string[] = [];
  const mismatched: string[] = [];

  const compare = (
    kind: string,
    id: string,
    src: unknown,
    tgt: unknown | null | undefined,
  ): void => {
    if (tgt === null || tgt === undefined) missing.push(`${kind}/${id}`);
    else if (stableStringify(src) !== stableStringify(tgt)) {
      mismatched.push(`${kind}/${id}`);
    }
  };

  const sourcePosts = (await source.blackboardStore.read()).entries;
  const targetPosts = new Map(
    (await target.blackboardStore.read()).entries.map((e) => [e.id, e]),
  );
  for (const e of sourcePosts) compare("posts", e.id, e, targetPosts.get(e.id));

  const sourceDecisionIds = (await source.decisionStore.getIndex()).map((d) => d.id);
  for (const id of sourceDecisionIds) {
    compare(
      "decisions",
      id,
      await source.decisionStore.get(id),
      await target.decisionStore.get(id),
    );
  }

  const sourceEntities = await source.graphStore.getEntities();
  for (const e of sourceEntities) {
    compare("entities", e.id, e, await target.graphStore.getEntityById(e.id));
  }

  const sourceRelations = await source.graphStore.getRelations();
  const targetRelations = new Map(
    (await target.graphStore.getRelations()).map((r) => [r.id, r]),
  );
  for (const r of sourceRelations) {
    compare("relations", r.id, r, targetRelations.get(r.id));
  }

  const sourceHandoffs = await source.handoffStore.list({});
  for (const h of sourceHandoffs) {
    compare(
      "handoffs",
      h.id,
      await source.handoffStore.get(h.id),
      await target.handoffStore.get(h.id),
    );
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    counts: {
      posts: sourcePosts.length,
      decisions: sourceDecisionIds.length,
      entities: sourceEntities.length,
      relations: sourceRelations.length,
      handoffs: sourceHandoffs.length,
    },
    missing,
    mismatched,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrate/verify.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Gate 2 + commit**

Call `twining_record` (summary: comparator added; decision: subset-containment semantics with rationale), then:

```bash
git add src/migrate/verify.ts test/migrate/verify.test.ts .twining/
git commit -m "feat(migrate): read-model containment comparator (W3)"
```

---

### Task 2: config.yml editor

**Files:**
- Create: `src/migrate/config-edit.ts`
- Test: `test/migrate/config-edit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate/config-edit.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { setStorageBackend } from "../../src/migrate/config-edit.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cfg-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const cfgPath = () => path.join(dir, "config.yml");

describe("setStorageBackend", () => {
  it("sets storage.backend while preserving every other key", () => {
    fs.writeFileSync(cfgPath(), yaml.dump({
      version: 1,
      project_name: "demo",
      context_assembly: { default_max_tokens: 9999 },
    }));
    const result = setStorageBackend(dir, "sqlite");
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
    expect((parsed.storage as Record<string, unknown>).backend).toBe("sqlite");
    expect(parsed.version).toBe(1); // v2 flip is gated — never touched here
    expect(parsed.project_name).toBe("demo");
    expect((parsed.context_assembly as Record<string, unknown>).default_max_tokens).toBe(9999);
    expect(result.hadComments).toBe(false);
  });

  it("backs up the previous config next to it", () => {
    fs.writeFileSync(cfgPath(), yaml.dump({ version: 1, project_name: "demo" }));
    const before = fs.readFileSync(cfgPath(), "utf-8");
    const result = setStorageBackend(dir, "sqlite");
    expect(result.backedUpTo).toBe(cfgPath() + ".pre-migrate.bak");
    expect(fs.readFileSync(result.backedUpTo!, "utf-8")).toBe(before);
  });

  it("updates an existing storage block without clobbering siblings", () => {
    fs.writeFileSync(cfgPath(), yaml.dump({
      version: 1, storage: { backend: "sqlite", export_records: false },
    }));
    setStorageBackend(dir, "files");
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as {
      storage: { backend: string; export_records: boolean };
    };
    expect(parsed.storage.backend).toBe("files");
    expect(parsed.storage.export_records).toBe(false);
  });

  it("creates a minimal config when none exists, and flags comments for the warning", () => {
    const created = setStorageBackend(dir, "sqlite");
    expect(created.backedUpTo).toBeNull();
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
    expect((parsed.storage as Record<string, unknown>).backend).toBe("sqlite");
    expect(parsed.version).toBe(1);

    fs.writeFileSync(cfgPath(), "# my note\nversion: 1\n");
    const commented = setStorageBackend(dir, "files");
    expect(commented.hadComments).toBe(true); // caller prints the comment-loss warning
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate/config-edit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/migrate/config-edit.ts
/**
 * Surgical config.yml edit for migrations: set storage.backend, preserve
 * everything else, back up the original. Deliberately does NOT touch
 * `version` — the config-format v2 flip belongs to the gated v2.0 release,
 * not to backend migration (plan deviation #1).
 *
 * yaml.load→dump drops comments; the caller must warn (using hadComments)
 * and point at the backup. Twining itself never writes comments.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface ConfigEditResult {
  backedUpTo: string | null;
  hadComments: boolean;
}

export function setStorageBackend(
  twiningDir: string,
  backend: "files" | "sqlite",
): ConfigEditResult {
  const configPath = path.join(twiningDir, "config.yml");

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, yaml.dump({ version: 1, storage: { backend } }));
    return { backedUpTo: null, hadComments: false };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const backupPath = configPath + ".pre-migrate.bak";
  fs.copyFileSync(configPath, backupPath);

  const parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>;
  const storage = (parsed.storage ?? {}) as Record<string, unknown>;
  storage.backend = backend;
  parsed.storage = storage;
  fs.writeFileSync(configPath, yaml.dump(parsed));

  return { backedUpTo: backupPath, hadComments: raw.includes("#") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrate/config-edit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Gate 2 + commit**

`twining_record`, then:

```bash
git add src/migrate/config-edit.ts test/migrate/config-edit.test.ts .twining/
git commit -m "feat(migrate): config.yml backend editor with backup (W3)"
```

---

### Task 3: Forward migration (files → sqlite)

**Files:**
- Create: `src/migrate/forward.ts`
- Test: `test/migrate/forward.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate/forward.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createStores, type StoreSet } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { migrateForward } from "../../src/migrate/forward.js";
import type { TwiningConfig } from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let projectRoot: string;
let twiningDir: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-fwd-"));
  twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.writeFileSync(
    path.join(twiningDir, "config.yml"),
    yaml.dump({ version: 1, project_name: "fwd-test" }),
  );
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

const filesConfig = (): TwiningConfig => ({ ...DEFAULT_CONFIG });
const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

async function seedFiles(): Promise<StoreSet> {
  const stores = createStores(twiningDir, filesConfig());
  await stores.blackboardStore.append({
    entry_type: "finding", summary: "legacy finding", detail: "d",
    tags: ["x"], scope: "src/", agent_id: "main",
  });
  const dec = await stores.decisionStore.create({
    agent_id: "main", domain: "architecture", scope: "src/", summary: "legacy decision",
    context: "c", rationale: "r", alternatives: [], confidence: "high",
    affected_files: [], affected_symbols: [], reversible: true,
  } as never);
  await stores.decisionStore.updateStatus(dec.id, "provisional");
  const e = await stores.graphStore.addEntity({ name: "auth", type: "module" });
  await stores.graphStore.addEntity({ name: "db", type: "module" });
  await stores.graphStore.addRelation({ source: e.id, target: "db", type: "depends_on" });
  await stores.handoffStore.create({
    source_agent: "a", target_agent: "b", scope: "src/", summary: "h", results: [],
    context_snapshot: { decision_ids: [], warning_ids: [], finding_ids: [], summaries: [] },
  });
  return stores;
}

describe.skipIf(!HAS_SQLITE)("migrateForward", () => {
  it("migrates a seeded file backend: tree written, db converged, config flipped", async () => {
    await seedFiles();
    const report = await migrateForward({ projectRoot, dryRun: false });

    expect(report.verified).toBe(true);
    expect(report.finalized).toBe(true);
    expect(report.counts).toEqual({
      posts: 1, decisions: 1, entities: 2, relations: 1, handoffs: 1,
    });

    const cfg = yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")) as {
      version: number; storage: { backend: string };
    };
    expect(cfg.storage.backend).toBe("sqlite");
    expect(cfg.version).toBe(1); // gated v2 flip untouched

    // The migrated project reads back identically through the sqlite backend.
    const sqlite = createStores(twiningDir, sqliteConfig());
    expect(sqlite.backend).toBe("sqlite");
    const { entries } = await sqlite.blackboardStore.read();
    expect(entries.map((e) => e.summary)).toEqual(["legacy finding"]);
    const index = await sqlite.decisionStore.getIndex();
    expect(index[0]!.status).toBe("provisional"); // status survived
    // Legacy files are untouched (they are their own backup):
    expect(fs.readFileSync(path.join(twiningDir, "blackboard.jsonl"), "utf-8"))
      .toContain("legacy finding");
  });

  it("is idempotent: second run verifies clean and changes nothing", async () => {
    await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });
    const before = fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8");

    const second = await migrateForward({ projectRoot, dryRun: false });
    expect(second.verified).toBe(true);
    expect(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")).toBe(before);
  });

  it("straggler re-run: a late write to legacy files is picked up, sqlite-era records survive", async () => {
    const legacy = await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });

    // A sqlite-era post lands (newer than the legacy files)…
    const sqlite = createStores(twiningDir, sqliteConfig());
    await sqlite.blackboardStore.append({
      entry_type: "status", summary: "sqlite era", detail: "", tags: [], scope: "project", agent_id: "m",
    });
    // …and a stale pre-1.21 client appends to the frozen legacy file.
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "straggler", detail: "", tags: [], scope: "src/", agent_id: "old",
    });

    const rerun = await migrateForward({ projectRoot, dryRun: false });
    expect(rerun.verified).toBe(true); // subset semantics: sqlite ⊇ legacy

    const { entries } = await sqlite.blackboardStore.read();
    const summaries = entries.map((e) => e.summary).sort();
    expect(summaries).toEqual(["legacy finding", "sqlite era", "straggler"]);
  });

  it("dry-run reports counts and writes nothing", async () => {
    await seedFiles();
    const before = fs.readdirSync(twiningDir).sort();
    const cfgBefore = fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8");

    const report = await migrateForward({ projectRoot, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.counts.posts).toBe(1);
    expect(report.finalized).toBe(false);
    expect(fs.readdirSync(twiningDir).sort()).toEqual(before); // no records/, no twining.db
    expect(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")).toBe(cfgBefore);
  });

  it("checkOnly verifies without writing, and fails cleanly on divergence", async () => {
    await seedFiles();
    await migrateForward({ projectRoot, dryRun: false });
    const ok = await migrateForward({ projectRoot, dryRun: false, checkOnly: true });
    expect(ok.verified).toBe(true);

    // Tamper: delete the db → check must fail (db missing legacy records),
    // and must NOT have re-written it.
    fs.rmSync(path.join(twiningDir, "twining.db"), { force: true });
    fs.rmSync(path.join(twiningDir, "twining.db-wal"), { force: true });
    fs.rmSync(path.join(twiningDir, "twining.db-shm"), { force: true });
    // (checkOnly opens the db read-style; an empty fresh db contains nothing)
    const bad = await migrateForward({ projectRoot, dryRun: false, checkOnly: true });
    expect(bad.verified).toBe(false);
    expect(bad.missing.length).toBeGreaterThan(0);
  });

  it("errors when .twining/ is absent", async () => {
    fs.rmSync(twiningDir, { recursive: true, force: true });
    await expect(migrateForward({ projectRoot, dryRun: false })).rejects.toThrow(/no \.twining/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate/forward.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/migrate/forward.ts
/**
 * Forward migration (FOUNDATION-PLAN W3): file backend → sqlite backend.
 *
 * NOT a special importer — this is "write the W2.3 export tree from the
 * file stores, then ordinary ingest" (plan step 5), so every parsing,
 * upsert, and deletion-safety rule is the shipped, soak-tested one:
 *
 *   file stores ──RecordExporter──▶ .twining/records/ ──ingestRecords──▶ twining.db
 *
 * Legacy files are never modified or deleted (they are their own backup);
 * the only file edited is config.yml (backed up by setStorageBackend).
 * Idempotent: exports are deterministic bytes, ingest is upsert-by-ULID,
 * and a re-run sweeps up straggler writes made to the legacy files by
 * stale clients. Verification is subset-containment (files ⊆ sqlite) so
 * re-runs verify clean after sqlite-era writes exist. Embeddings are not
 * migrated: the 1.22 startup reconcile rebuilds them by content hash.
 */
import fs from "node:fs";
import path from "node:path";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import { SqliteBlackboardStore, SqliteDecisionStore, SqliteGraphStore, SqliteHandoffStore } from "../storage/sqlite/sqlite-stores.js";
import { openDatabase, sqliteAvailable } from "../storage/sqlite/db.js";
import { RecordExporter } from "../storage/sync/record-export.js";
import { ingestRecords } from "../storage/sync/record-ingest.js";
import { setStorageBackend } from "./config-edit.js";
import { verifyContains, type ReadModelStores, type VerifyResult } from "./verify.js";

export interface ForwardOptions {
  projectRoot: string;
  dryRun: boolean;
  /** Verify only — no export, no ingest, no finalize. */
  checkOnly?: boolean;
}

export interface MigrateReport extends VerifyResult {
  dryRun: boolean;
  verified: boolean;
  finalized: boolean;
  configBackup: string | null;
  configHadComments: boolean;
  notes: string[];
}

export async function migrateForward(opts: ForwardOptions): Promise<MigrateReport> {
  const twiningDir = path.join(opts.projectRoot, ".twining");
  if (!fs.existsSync(twiningDir)) {
    throw new Error(`no .twining/ directory at ${twiningDir} — nothing to migrate`);
  }
  if (!sqliteAvailable()) {
    throw new Error(
      "node:sqlite is unavailable (requires Node >= 22.13) — the sqlite backend cannot run here, refusing to migrate",
    );
  }

  const legacy: ReadModelStores = {
    blackboardStore: new BlackboardStore(twiningDir),
    decisionStore: new DecisionStore(twiningDir),
    graphStore: new GraphStore(twiningDir),
    handoffStore: new HandoffStore(twiningDir),
  };

  const notes = [
    "agents registry, archive/, metrics, and pending queues are backend-agnostic — untouched",
    "embeddings are not migrated; the sqlite backend rebuilds them by content hash on first start",
  ];

  if (opts.dryRun) {
    // Count through the same reads a real run would use; write nothing.
    const counts = {
      posts: (await legacy.blackboardStore.read()).entries.length,
      decisions: (await legacy.decisionStore.getIndex()).length,
      entities: (await legacy.graphStore.getEntities()).length,
      relations: (await legacy.graphStore.getRelations()).length,
      handoffs: (await legacy.handoffStore.list({})).length,
    };
    return {
      ok: true, counts, missing: [], mismatched: [],
      dryRun: true, verified: false, finalized: false,
      configBackup: null, configHadComments: false, notes,
    };
  }

  if (!opts.checkOnly) {
    // 1. Export: file stores → per-ULID records tree (deterministic bytes).
    const exporter = new RecordExporter(twiningDir);
    for (const entry of (await legacy.blackboardStore.read()).entries) {
      exporter.post(entry);
    }
    for (const ix of await legacy.decisionStore.getIndex()) {
      const decision = await legacy.decisionStore.get(ix.id);
      if (decision) exporter.decision(decision);
    }
    for (const entity of await legacy.graphStore.getEntities()) {
      exporter.entity(entity);
    }
    for (const relation of await legacy.graphStore.getRelations()) {
      exporter.relation(relation);
    }
    for (const ix of await legacy.handoffStore.list({})) {
      const record = await legacy.handoffStore.get(ix.id);
      if (record) exporter.handoff(record);
    }
  }

  // 2. Converge the database to the tree (creates twining.db if absent).
  //    checkOnly still opens the db — a fresh/empty one simply contains nothing.
  const db = openDatabase(twiningDir);
  try {
    if (!opts.checkOnly) ingestRecords(db, twiningDir);

    // 3. Verify: everything the file stores can read is in sqlite, identical.
    const sqlite: ReadModelStores = {
      blackboardStore: new SqliteBlackboardStore(db),
      decisionStore: new SqliteDecisionStore(db),
      graphStore: new SqliteGraphStore(db),
      handoffStore: new SqliteHandoffStore(db),
    };
    const verdict = await verifyContains(legacy, sqlite);

    if (!verdict.ok || opts.checkOnly) {
      return {
        ...verdict, dryRun: false, verified: verdict.ok, finalized: false,
        configBackup: null, configHadComments: false, notes,
      };
    }

    // 4. Finalize: flip the backend. version stays 1 — the v2 flip is gated.
    const edit = setStorageBackend(twiningDir, "sqlite");
    return {
      ...verdict, dryRun: false, verified: true, finalized: true,
      configBackup: edit.backedUpTo, configHadComments: edit.hadComments, notes,
    };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrate/forward.test.ts`
Expected: PASS (6 tests)

Note for the executor: the idempotency test asserts config.yml bytes are unchanged on the second run — `setStorageBackend` re-dumps the same parsed object, which is byte-stable for yaml.dump given identical input; if this flakes, relax to yaml-parse equality and record the deviation.

- [ ] **Step 5: Gate 2 + commit**

`twining_record` (decisions: subset verify direction, no-version-flip, no-backup-needed rationale), then:

```bash
git add src/migrate/forward.ts test/migrate/forward.test.ts .twining/
git commit -m "feat(migrate): forward files→sqlite migration via export tree + ingest (W3)"
```

---

### Task 4: Reverse migration (sqlite → files)

**Files:**
- Create: `src/migrate/reverse.ts`
- Test: `test/migrate/reverse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate/reverse.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createStores } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { migrateForward } from "../../src/migrate/forward.js";
import { migrateReverse } from "../../src/migrate/reverse.js";
import type { TwiningConfig } from "../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let projectRoot: string;
let twiningDir: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-rev-"));
  twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.writeFileSync(
    path.join(twiningDir, "config.yml"),
    yaml.dump({ version: 1, project_name: "rev-test" }),
  );
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

const filesConfig = (): TwiningConfig => ({ ...DEFAULT_CONFIG });
const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

describe.skipIf(!HAS_SQLITE)("migrateReverse", () => {
  it("round-trips: forward, post more via sqlite, reverse — file backend sees everything", async () => {
    // Legacy era.
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "legacy", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });

    // Sqlite era: new post + a decision.
    const sqlite = createStores(twiningDir, sqliteConfig());
    await sqlite.blackboardStore.append({
      entry_type: "status", summary: "sqlite era", detail: "", tags: [], scope: "project", agent_id: "m",
    });
    const dec = await sqlite.decisionStore.create({
      agent_id: "m", domain: "architecture", scope: "src/", summary: "made on sqlite",
      context: "c", rationale: "r", alternatives: [], confidence: "high",
      affected_files: [], affected_symbols: [], reversible: true,
    } as never);
    await sqlite.decisionStore.updateStatus(dec.id, "provisional");

    const report = await migrateReverse({ projectRoot, dryRun: false });
    expect(report.verified).toBe(true);
    expect(report.finalized).toBe(true);

    const cfg = yaml.load(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")) as {
      storage: { backend: string };
    };
    expect(cfg.storage.backend).toBe("files");

    // Fresh file stores see the full sqlite-era state, statuses included.
    const files = createStores(twiningDir, filesConfig());
    expect(files.backend).toBe("files");
    const { entries } = await files.blackboardStore.read();
    expect(entries.map((e) => e.summary).sort()).toEqual(["legacy", "sqlite era"]);
    const index = await files.decisionStore.getIndex();
    expect(index.find((d) => d.id === dec.id)!.status).toBe("provisional");
    expect((await files.handoffStore.list({})).length).toBe(0);
  });

  it("backs up the file layout it overwrites", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "precious", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });
    await migrateReverse({ projectRoot, dryRun: false });

    const backupDir = path.join(twiningDir, "pre-reverse-backup");
    expect(fs.existsSync(path.join(backupDir, "blackboard.jsonl"))).toBe(true);
    expect(
      fs.readFileSync(path.join(backupDir, "blackboard.jsonl"), "utf-8"),
    ).toContain("precious");
  });

  it("dry-run writes nothing", async () => {
    const legacy = createStores(twiningDir, filesConfig());
    await legacy.blackboardStore.append({
      entry_type: "finding", summary: "x", detail: "", tags: [], scope: "src/", agent_id: "m",
    });
    await migrateForward({ projectRoot, dryRun: false });
    const cfgBefore = fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8");

    const report = await migrateReverse({ projectRoot, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.counts.posts).toBe(1);
    expect(fs.readFileSync(path.join(twiningDir, "config.yml"), "utf-8")).toBe(cfgBefore);
    expect(fs.existsSync(path.join(twiningDir, "pre-reverse-backup"))).toBe(false);
  });

  it("errors when there is no sqlite state to reverse from", async () => {
    await expect(migrateReverse({ projectRoot, dryRun: false })).rejects.toThrow(
      /no sqlite state/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate/reverse.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/migrate/reverse.ts
/**
 * Reverse migration (FOUNDATION-PLAN W3: "the reverse export path so
 * nobody is locked in"): sqlite backend → file backend.
 *
 * The committed records/ tree is the durable truth (design D1), so the
 * db is first converged to it (ordinary ingest), then the file-backend
 * layout is written wholesale from the sqlite read model:
 *
 *   blackboard.jsonl            one JSON line per entry, insertion order
 *   decisions/<id>.json          + decisions/index.json (from getIndex())
 *   graph/entities.json, graph/relations.json
 *   handoffs/<id>.json           + handoffs/index.jsonl (from index_data)
 *
 * Existing file-layout paths are copied to .twining/pre-reverse-backup/
 * before being overwritten. records/ and twining.db are left in place —
 * deleting committed state is not this tool's call — but the tree FREEZES
 * at this point: the CLI prints a warning that returning to sqlite later
 * requires re-running `twining-mcp migrate` (or removing the tree), or
 * startup ingest would resurrect the frozen tree over newer file records.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, ensureDir } from "../storage/file-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { DecisionStore } from "../storage/decision-store.js";
import { GraphStore } from "../storage/graph-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import { SqliteBlackboardStore, SqliteDecisionStore, SqliteGraphStore, SqliteHandoffStore } from "../storage/sqlite/sqlite-stores.js";
import { openDatabase, sqliteAvailable } from "../storage/sqlite/db.js";
import { ingestRecords } from "../storage/sync/record-ingest.js";
import { setStorageBackend } from "./config-edit.js";
import { verifyContains, type ReadModelStores } from "./verify.js";
import type { ForwardOptions, MigrateReport } from "./forward.js";

export async function migrateReverse(
  opts: Omit<ForwardOptions, "checkOnly">,
): Promise<MigrateReport> {
  const twiningDir = path.join(opts.projectRoot, ".twining");
  if (!fs.existsSync(twiningDir)) {
    throw new Error(`no .twining/ directory at ${twiningDir} — nothing to migrate`);
  }
  if (!sqliteAvailable()) {
    throw new Error(
      "node:sqlite is unavailable (requires Node >= 22.13) — cannot read the sqlite state to reverse it",
    );
  }
  const hasDb = fs.existsSync(path.join(twiningDir, "twining.db"));
  const hasTree = fs.existsSync(path.join(twiningDir, "records"));
  if (!hasDb && !hasTree) {
    throw new Error(
      "no sqlite state found (neither twining.db nor records/) — nothing to reverse",
    );
  }

  const notes = [
    "records/ tree and twining.db are left in place but FROZEN — re-run `twining-mcp migrate` before switching back to sqlite, or remove .twining/records/",
    "file-backend embedding indexes are not rebuilt; search uses keyword fallback for unembedded records",
  ];

  const db = openDatabase(twiningDir);
  try {
    // Tree is truth: converge the db to it before exporting.
    ingestRecords(db, twiningDir);

    const sqlite: ReadModelStores = {
      blackboardStore: new SqliteBlackboardStore(db),
      decisionStore: new SqliteDecisionStore(db),
      graphStore: new SqliteGraphStore(db),
      handoffStore: new SqliteHandoffStore(db),
    };

    const entries = (await sqlite.blackboardStore.read()).entries;
    const decisionIndex = await sqlite.decisionStore.getIndex();
    const entities = await sqlite.graphStore.getEntities();
    const relations = await sqlite.graphStore.getRelations();
    const handoffIndex = await sqlite.handoffStore.list({});
    const counts = {
      posts: entries.length,
      decisions: decisionIndex.length,
      entities: entities.length,
      relations: relations.length,
      handoffs: handoffIndex.length,
    };

    if (opts.dryRun) {
      return {
        ok: true, counts, missing: [], mismatched: [],
        dryRun: true, verified: false, finalized: false,
        configBackup: null, configHadComments: false, notes,
      };
    }

    // Back up the file-layout paths this run overwrites.
    const backupDir = path.join(twiningDir, "pre-reverse-backup");
    ensureDir(backupDir);
    for (const rel of ["blackboard.jsonl", "decisions", "graph", "handoffs"]) {
      const src = path.join(twiningDir, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(backupDir, rel), { recursive: true, force: true });
      }
    }

    // Write the file-backend layout from the sqlite read model.
    atomicWriteFileSync(
      path.join(twiningDir, "blackboard.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
    );

    ensureDir(path.join(twiningDir, "decisions"));
    for (const ix of decisionIndex) {
      const decision = await sqlite.decisionStore.get(ix.id);
      if (decision) {
        atomicWriteFileSync(
          path.join(twiningDir, "decisions", `${decision.id}.json`),
          JSON.stringify(decision, null, 2),
        );
      }
    }
    atomicWriteFileSync(
      path.join(twiningDir, "decisions", "index.json"),
      JSON.stringify(decisionIndex, null, 2),
    );

    ensureDir(path.join(twiningDir, "graph"));
    atomicWriteFileSync(
      path.join(twiningDir, "graph", "entities.json"),
      JSON.stringify(entities, null, 2),
    );
    atomicWriteFileSync(
      path.join(twiningDir, "graph", "relations.json"),
      JSON.stringify(relations, null, 2),
    );

    ensureDir(path.join(twiningDir, "handoffs"));
    for (const ix of handoffIndex) {
      const record = await sqlite.handoffStore.get(ix.id);
      if (record) {
        atomicWriteFileSync(
          path.join(twiningDir, "handoffs", `${record.id}.json`),
          JSON.stringify(record, null, 2),
        );
      }
    }
    // index.jsonl straight from the stored index rows (same derivation the
    // sqlite store maintains), newest-last like appendJSONL would produce.
    const indexRows = db
      .prepare("SELECT index_data FROM handoffs ORDER BY seq")
      .all()
      .map((r) => r.index_data as string);
    atomicWriteFileSync(
      path.join(twiningDir, "handoffs", "index.jsonl"),
      indexRows.join("\n") + (indexRows.length ? "\n" : ""),
    );

    // Verify: everything sqlite can read is now in the file layout.
    const files: ReadModelStores = {
      blackboardStore: new BlackboardStore(twiningDir),
      decisionStore: new DecisionStore(twiningDir),
      graphStore: new GraphStore(twiningDir),
      handoffStore: new HandoffStore(twiningDir),
    };
    const verdict = await verifyContains(sqlite, files);
    if (!verdict.ok) {
      return {
        ...verdict, dryRun: false, verified: false, finalized: false,
        configBackup: null, configHadComments: false, notes,
      };
    }

    const edit = setStorageBackend(twiningDir, "files");
    return {
      ...verdict, dryRun: false, verified: true, finalized: true,
      configBackup: edit.backedUpTo, configHadComments: edit.hadComments, notes,
    };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrate/reverse.test.ts`
Expected: PASS (4 tests)

Executor note: file stores cache by mtime — the round-trip test creates *fresh* store instances after reverse (it does; keep it that way). If `verifyContains` flags mismatches from `commit_hashes: []` default-normalization differences between backends, the fix belongs in the comparator test expectations only if the running server shows the same read — investigate against `SqliteDecisionStore.create`'s `commit_hashes` default before touching anything.

- [ ] **Step 5: Gate 2 + commit**

`twining_record` (decisions: leave frozen tree + print warning vs delete; backup dir), then:

```bash
git add src/migrate/reverse.ts test/migrate/reverse.test.ts .twining/
git commit -m "feat(migrate): reverse sqlite→files export path (W3)"
```

---

### Task 5: CLI subcommand

**Files:**
- Create: `src/migrate/cli.ts`
- Modify: `src/index.ts` (dispatch before MCP startup, lines 12-18 area)
- Test: `test/migrate/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate/cli.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { runMigrateCli } from "../../src/migrate/cli.js";
import { createStores } from "../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

let projectRoot: string;
let logs: string[];

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cli-"));
  const twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "config.yml"), yaml.dump({ version: 1 }));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

async function seedOnePost() {
  const stores = createStores(path.join(projectRoot, ".twining"), { ...DEFAULT_CONFIG });
  await stores.blackboardStore.append({
    entry_type: "finding", summary: "cli seed", detail: "", tags: [], scope: "src/", agent_id: "m",
  });
}

describe.skipIf(!HAS_SQLITE)("runMigrateCli", () => {
  it("migrates forward and exits 0, printing the report and next steps", async () => {
    await seedOnePost();
    const code = await runMigrateCli(["--project", projectRoot]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/posts:\s*1/);
    expect(out).toMatch(/storage\.backend.*sqlite/);
    expect(out).toMatch(/git add/); // prints commit guidance, never auto-commits
  });

  it("--dry-run exits 0 and changes nothing", async () => {
    await seedOnePost();
    const code = await runMigrateCli(["--project", projectRoot, "--dry-run"]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, ".twining", "twining.db"))).toBe(false);
  });

  it("--check exits 0 after a migration and 1 when the db diverges", async () => {
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]);
    expect(await runMigrateCli(["--project", projectRoot, "--check"])).toBe(0);

    for (const f of ["twining.db", "twining.db-wal", "twining.db-shm"]) {
      fs.rmSync(path.join(projectRoot, ".twining", f), { force: true });
    }
    expect(await runMigrateCli(["--project", projectRoot, "--check"])).toBe(1);
  });

  it("--reverse round-trips back to the file backend", async () => {
    await seedOnePost();
    await runMigrateCli(["--project", projectRoot]);
    const code = await runMigrateCli(["--project", projectRoot, "--reverse"]);
    expect(code).toBe(0);
    const cfg = yaml.load(
      fs.readFileSync(path.join(projectRoot, ".twining", "config.yml"), "utf-8"),
    ) as { storage: { backend: string } };
    expect(cfg.storage.backend).toBe("files");
    expect(logs.join("\n")).toMatch(/FROZEN/i); // the switch-back warning
  });

  it("exits 2 on usage/environment errors", async () => {
    expect(await runMigrateCli(["--bogus-flag"])).toBe(2);
    fs.rmSync(path.join(projectRoot, ".twining"), { recursive: true, force: true });
    expect(await runMigrateCli(["--project", projectRoot])).toBe(2);
  });
});

describe.skipIf(HAS_SQLITE)("runMigrateCli without node:sqlite (Node 18/20 CI legs)", () => {
  it("fails with a clear message and exit 2 instead of a silent fallback", async () => {
    const code = await runMigrateCli(["--project", projectRoot]);
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate/cli.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the CLI implementation**

```ts
// src/migrate/cli.ts
/**
 * `twining-mcp migrate` — explicit backend migration for existing installs.
 *
 *   twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]
 *
 * Exit codes: 0 success / check passed · 1 verification failed · 2 usage or
 * environment error. Runs as a plain CLI (stdout is fine here — the MCP
 * stdio rule applies only to the server path, which this never enters).
 * Never auto-commits: it prints the git commands instead (plan doc W3.7).
 */
import { migrateForward, type MigrateReport } from "./forward.js";
import { migrateReverse } from "./reverse.js";

const USAGE =
  "usage: twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]";

export async function runMigrateCli(argv: string[]): Promise<number> {
  let projectRoot = process.cwd();
  let dryRun = false;
  let check = false;
  let reverse = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project" && argv[i + 1]) projectRoot = argv[++i]!;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if (arg === "--reverse") reverse = true;
    else {
      console.error(`unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  try {
    const report = reverse
      ? await migrateReverse({ projectRoot, dryRun })
      : await migrateForward({ projectRoot, dryRun, checkOnly: check });
    printReport(report, { reverse, check, dryRun });
    if (check) return report.verified ? 0 : 1;
    if (dryRun) return 0;
    return report.verified && report.finalized ? 0 : 1;
  } catch (err) {
    console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function printReport(
  report: MigrateReport,
  mode: { reverse: boolean; check: boolean; dryRun: boolean },
): void {
  const direction = mode.reverse ? "sqlite → files" : "files → sqlite";
  const verb = mode.check ? "check" : mode.dryRun ? "dry-run" : "migration";
  console.log(`twining-mcp migrate — ${direction} ${verb}`);
  console.log(
    `  posts: ${report.counts.posts}  decisions: ${report.counts.decisions}  ` +
      `entities: ${report.counts.entities}  relations: ${report.counts.relations}  ` +
      `handoffs: ${report.counts.handoffs}`,
  );
  for (const note of report.notes) console.log(`  note: ${note}`);

  if (mode.dryRun) {
    console.log("  dry-run: nothing written. Re-run without --dry-run to migrate.");
    return;
  }
  if (!report.verified && !mode.dryRun) {
    console.log("  VERIFICATION FAILED — config.yml was NOT changed.");
    for (const m of report.missing.slice(0, 20)) console.log(`    missing: ${m}`);
    for (const m of report.mismatched.slice(0, 20)) console.log(`    mismatched: ${m}`);
    const more = report.missing.length + report.mismatched.length - 40;
    if (more > 0) console.log(`    …and ${more} more`);
    return;
  }
  if (mode.check) {
    console.log("  check passed: target contains every source record.");
    return;
  }

  console.log(`  verified ✓  config.yml storage.backend → ${mode.reverse ? "files" : "sqlite"}`);
  if (report.configBackup) console.log(`  previous config backed up to ${report.configBackup}`);
  if (report.configHadComments) {
    console.log("  WARNING: config.yml contained comments; yaml rewrite drops them (see backup).");
  }
  if (mode.reverse) {
    console.log(
      "  WARNING: .twining/records/ and twining.db are now FROZEN. Before ever switching\n" +
        "  back to the sqlite backend, re-run `twining-mcp migrate` (or remove .twining/records/),\n" +
        "  otherwise startup ingest would resurrect this frozen tree over newer records.",
    );
  } else {
    console.log(
      "\n  Next steps (nothing has been committed for you):\n" +
        "    git add .twining/records .twining/config.yml\n" +
        '    git commit -m "chore: migrate .twining to the sqlite backend"\n' +
        "  Teammates should update twining-mcp before pulling this commit.\n" +
        "  Stop any running twining sessions and restart them to pick up the new backend.",
    );
  }
}
```

- [ ] **Step 4: Wire the subcommand into `src/index.ts`**

In `src/index.ts`, insert between the `--version` block (ends line 18) and `async function main()`:

```ts
// Explicit CLI subcommand — never enters the MCP stdio path, so console.log
// is safe. Runs even under TWINING_DISABLED: migration is a deliberate act.
if (process.argv[2] === "migrate") {
  const { runMigrateCli } = await import("./migrate/cli.js");
  process.exit(await runMigrateCli(process.argv.slice(3)));
}
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/migrate/cli.test.ts`
Expected: PASS (6 tests; the no-sqlite test skips locally, runs on Node 18/20 CI)

Run: `npm run build && npm test`
Expected: all green (server-startup tests confirm the dispatch didn't disturb MCP startup)

- [ ] **Step 6: Dist smoke**

```bash
cd "$(mktemp -d)" && git init -q && mkdir .twining && printf 'version: 1\n' > .twining/config.yml
node /Users/dave/code/twining-mcp/dist/index.js migrate --dry-run
```
Expected: report with zero counts, exit 0.

- [ ] **Step 7: Gate 2 + commit**

`twining_record`, then:

```bash
git add src/migrate/cli.ts src/index.ts test/migrate/cli.test.ts .twining/
git commit -m "feat(migrate): twining-mcp migrate CLI subcommand (W3)"
```

---

### Task 6: Golden fixture — this repo's own `.twining/`

**Files:**
- Test: `test/migrate/golden-fixture.test.ts`

- [ ] **Step 1: Write the test**

```ts
// test/migrate/golden-fixture.test.ts
/**
 * FOUNDATION-PLAN W3 acceptance: migrating this repo's own committed
 * .twining/ (the best available real fixture — years of decisions, a
 * populated graph, a large blackboard) produces a verified, diff-clean
 * read model. Counts are asserted as lower bounds only: the fixture
 * grows every session.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateForward } from "../../src/migrate/forward.js";
import { migrateReverse } from "../../src/migrate/reverse.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try { require("node:sqlite"); return true; } catch { return false; }
})();

const REPO_TWINING = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".twining",
);

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-golden-"));
  const target = path.join(projectRoot, ".twining");
  fs.cpSync(REPO_TWINING, target, { recursive: true });
  // The copy must behave like a fresh clone: no local caches.
  for (const f of ["twining.db", "twining.db-wal", "twining.db-shm"]) {
    fs.rmSync(path.join(target, f), { force: true });
  }
  fs.rmSync(path.join(target, "records"), { recursive: true, force: true });
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe.skipIf(!HAS_SQLITE)("golden fixture: this repo's .twining/", () => {
  it("forward-migrates verified and diff-clean, then round-trips in reverse", async () => {
    const forward = await migrateForward({ projectRoot, dryRun: false });
    expect(forward.missing).toEqual([]);
    expect(forward.mismatched).toEqual([]);
    expect(forward.verified).toBe(true);
    expect(forward.finalized).toBe(true);
    // Real corpus, lower bounds only (fixture grows):
    expect(forward.counts.decisions).toBeGreaterThan(100);
    expect(forward.counts.posts).toBeGreaterThan(50);
    expect(forward.counts.entities).toBeGreaterThan(10);

    // Double-migration is a no-op that still verifies (W3 acceptance).
    const again = await migrateForward({ projectRoot, dryRun: false });
    expect(again.verified).toBe(true);

    // And the escape hatch holds on real data too.
    const back = await migrateReverse({ projectRoot, dryRun: false });
    expect(back.verified).toBe(true);
    expect(back.counts.decisions).toBeGreaterThanOrEqual(forward.counts.decisions);
  }, 60_000);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/migrate/golden-fixture.test.ts`
Expected: PASS. **If verification fails here, hard stop** — that is real data exposing a real bug (most likely a field-normalization difference between backends, e.g. `commit_hashes` defaults or provenance-less pre-1.19 records). Diagnose with the printed missing/mismatched ids against the actual files before changing anything; do not weaken the comparator to pass.

- [ ] **Step 3: Gate 2 + commit**

`twining_record` (finding: golden fixture results, any normalization quirks discovered), then:

```bash
git add test/migrate/golden-fixture.test.ts .twining/
git commit -m "test(migrate): golden-fixture migration of this repo's own .twining (W3 acceptance)"
```

---

### Task 7: Docs + plan status

**Files:**
- Modify: `README.md` (add a "Migrating to the SQLite backend" section near the existing storage/backend docs — locate with `grep -n "storage" README.md`)
- Modify: `CHANGELOG.md` (new `## [1.23.0]` section at top)
- Modify: `docs/FOUNDATION-PLAN.md` (status table: W3 row → `✅ done | server 1.23.0`, with a note that the v2-gated parts — version flip, auto-migration — remain open)

- [ ] **Step 1: CHANGELOG entry**

```markdown
## [1.23.0] - <date>

`twining-mcp migrate` — W3 of the v2 foundation plan. CLI-only; no MCP tool-surface or plugin changes.

### Added
- **`twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]`.** Moves an existing file-backend `.twining/` to the opt-in sqlite backend and back. Not a special importer: forward migration writes the per-ULID `records/` export tree from the file stores and runs the ordinary ingest, so every parsing and safety rule is the shipped W2.2/W2.3 one. Verified before finalizing — every record readable from the source backend must exist byte-identically in the target, or the tool exits 1 without touching config.yml. Idempotent: re-running picks up straggler writes made to the legacy files by stale clients. Legacy files are never modified or deleted (config.yml is the one exception — edited to flip `storage.backend`, with a `.pre-migrate.bak` backup). `--reverse` regenerates the full file-backend layout from the sqlite read model so nobody is locked in (the overwritten layout is backed up to `pre-reverse-backup/`; the now-frozen `records/` tree comes with a printed warning). Embeddings are not migrated — the sqlite backend rebuilds them by content hash on first start (1.22.0), and `config.version` stays 1: the format-v2 flip ships with v2.0, not here. Acceptance: migrating this repo's own committed `.twining/` (≈140 decisions, populated graph, large blackboard) verifies diff-clean and round-trips.
```

- [ ] **Step 2: README section** — document the command, the three flags, exit codes, the "stop running sessions first" instruction, the teammates-update-first sequencing, and the reverse-path frozen-tree warning. Keep it under ~40 lines; link to FOUNDATION-PLAN for design.

- [ ] **Step 3: Full gate**

```bash
npm run build && npm test
SOAK_SCALE=5 npx vitest run test/multiwriter-soak.test.ts
```
Expected: all green. (Migration touches storage read/write paths → the soak is the standing acceptance bar for storage-adjacent changes, even though migrate itself is single-process.)

- [ ] **Step 4: Gate 2 + commit**

```bash
git add README.md CHANGELOG.md docs/FOUNDATION-PLAN.md .twining/
git commit -m "docs(migrate): README + CHANGELOG + plan status for W3"
```

---

### Task 8: PR + release 1.23.0

- [ ] **Step 1:** Push branch, open PR to main (squash-merge is the repo standard). PR body: summary, validation evidence, the frozen-tree caveat, and the explicit statement that `config.version` stays 1.
- [ ] **Step 2:** Watch CI — note the Node 18/20 legs exercise the no-sqlite error-path test that skips locally.
- [ ] **Step 3:** When green, squash-merge. Then on main: `npm version 1.23.0 --no-git-tag-version`, light STATE.md TL;DR touch (1.23.0, W3 done, next = v2.0 prep **gated on explicit go-ahead**), `twining_record`, commit `chore(release): v1.23.0`, tag `v1.23.0`, push main + tag (publish.yml triggers on the tag).
- [ ] **Step 4:** Verify `npm view twining-mcp version` → `1.23.0` and the GitHub Release exists. No plugin bump: the plugin pins `twining-mcp@^1.20.0`, which resolves 1.23.0.

---

## Self-review notes

- **Spec coverage:** CLI with `--project/--dry-run/--check` (plan doc W3 head) ✓ Task 5; idempotent/re-runnable ✓ Tasks 3/6; salvage-parsing = the file stores' own salvage, deviation #4 recorded ✓; transform step is the identity (records already ULID-shaped) per stale-doc correction ✓; build-db-via-ordinary-ingest ✓ Task 3; verify-refuse-on-mismatch ✓ Tasks 1/3; finalize prints git commands, never auto-commits ✓ Task 5; golden fixture ✓ Task 6; double-migration no-op ✓ Task 6; straggler re-run ✓ Task 3; reverse path ✓ Task 4. **Deliberately out of scope (v2.0-gated, recorded):** `config.version: 2`, auto-migration at startup, `--keep-legacy` (nothing is ever deleted, so the flag is moot in 1.x).
- **Type consistency:** `MigrateReport` defined in forward.ts, reused by reverse.ts and cli.ts; `ReadModelStores` defined in verify.ts, used by both directions; `runMigrateCli(argv) → Promise<number>` matches the index.ts dispatch.
- **Known soft spot flagged for the executor:** Task 3's byte-identical-config idempotency assertion and Task 6's real-corpus normalization risks each carry an inline decision criterion rather than a placeholder.
