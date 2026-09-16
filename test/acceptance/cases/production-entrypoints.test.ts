/**
 * Scope enforcement at the PRODUCTION entry points (C25 A1/A2/A4, C12 A13,
 * C05 A11 — driven through the real callers).
 *
 * ## Why this file exists
 *
 * The adversarial review found that every C0x/C12/C19/C25 case called the
 * test-local `scopedQuery` wrapper in `harness.ts`, which applies
 * `selectCandidates` itself. Those cases therefore asserted that the GATE
 * FUNCTION works — not that any shipped caller invokes it. A call site that
 * skipped the gate entirely could not fail any of them, and one did:
 * `ContextAssembler.assemble`'s `decisionStore.getByScope` path went straight
 * into the briefing while the module docstring claimed otherwise.
 *
 * So: at least one case per surface, driven through the real entry point.
 *
 *   | surface   | entry point                       |
 *   | --------- | --------------------------------- |
 *   | assemble  | `ContextAssembler.assemble`       |
 *   | why       | `DecisionEngine.why`              |
 *   | dashboard | `createQueryHandler`              |
 *
 * `scopedQuery` remains in `harness.ts` only for the v3 event-store surfaces
 * that genuinely have no production caller yet (lane 02/03 own those), and
 * that limitation is stated in the lane report rather than hidden behind a
 * green suite.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { ContextAssembler } from "../../../src/engine/context-assembler.js";
import { DecisionEngine } from "../../../src/engine/decisions.js";
import { BlackboardEngine } from "../../../src/engine/blackboard.js";
import { BlackboardStore } from "../../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../../src/storage/decision-store.js";
import { SearchEngine } from "../../../src/embeddings/search.js";
import { Embedder } from "../../../src/embeddings/embedder.js";
import { IndexManager } from "../../../src/embeddings/index-manager.js";
import { createQueryHandler } from "../../../src/dashboard/query-routes.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots.length = 0;
  Embedder.resetInstances();
});

function project(): { root: string; twiningDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-prod-entry-"));
  roots.push(root);
  const twiningDir = path.join(root, ".twining");
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "embeddings"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "graph"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
  fs.writeFileSync(path.join(twiningDir, "decisions", "index.json"), "[]");
  return { root, twiningDir };
}

const BASE = {
  agent_id: "test",
  domain: "implementation" as const,
  context: "ctx",
  constraints: [] as string[],
  alternatives: [],
  depends_on: [],
  confidence: "high" as const,
  reversible: true,
  affected_files: [] as string[],
  affected_symbols: [] as string[],
};

/**
 * The three records every case below needs:
 *  - IN-SCOPE      : plainly inside `src/auth/`
 *  - SEGMENT-COLLIDE: `src/authz/`, which 2.x's raw `startsWith` admits for a
 *                     `src/auth` query and the contract's `pathCovers` does not
 *  - FOREIGN-FILE  : scoped far away but NAMING a file inside `src/auth/`
 */
async function seed(twiningDir: string) {
  const ds = new DecisionStore(twiningDir);
  const inScope = await ds.create({ ...BASE, scope: "src/auth/", summary: "IN-SCOPE-RECORD", rationale: "r" });
  const collide = await ds.create({ ...BASE, scope: "src/authz/", summary: "SEGMENT-COLLIDE-RECORD", rationale: "r" });
  const foreignFile = await ds.create({
    ...BASE,
    scope: "vendor/billing/",
    summary: "FOREIGN-FILE-RECORD",
    rationale: "r",
    affected_files: ["src/auth/jwt.ts"],
  });
  const foreignOnly = await ds.create({
    ...BASE,
    scope: "vendor/billing/",
    summary: "FOREIGN-ONLY-RECORD",
    rationale: "r",
    affected_files: ["vendor/billing/proration.ts"],
  });
  return { ds, inScope, collide, foreignFile, foreignOnly };
}

/* ------------------------------------------------------------------ */
/* Surface 1 — ContextAssembler.assemble                               */
/* ------------------------------------------------------------------ */

describe("PRODUCTION ENTRY POINT — ContextAssembler.assemble", () => {
  it("LIVENESS: all four records exist and the in-scope one is returned", async () => {
    const { twiningDir } = project();
    const { ds, inScope } = await seed(twiningDir);
    expect(await ds.getIndex()).toHaveLength(4);
    const a = new ContextAssembler(new BlackboardStore(twiningDir), ds, null, { ...DEFAULT_CONFIG });
    const ctx = await a.assemble("auth work", "src/auth/", 100000);
    expect(ctx.active_decisions.map((d) => d.id)).toContain(inScope.id);
  });

  it("C25 A1/C12 A13 — a SEGMENT COLLISION is cut: src/authz never answers a src/auth query", async () => {
    const { twiningDir } = project();
    const { ds, collide } = await seed(twiningDir);
    const a = new ContextAssembler(new BlackboardStore(twiningDir), ds, null, { ...DEFAULT_CONFIG });
    // NOTE the query has no trailing slash — that is the shape 2.x's raw
    // matcher actually mis-admits ("src/authz/".startsWith("src/auth")), and it
    // is how a caller naturally names a module. With a trailing slash the 2.x
    // matcher already misses, so the fixture would prove nothing.
    const ctx = await a.assemble("auth work", "src/auth", 100000);

    // 2.x's matcher admits it; the gate does not.
    expect("src/authz/".startsWith("src/auth")).toBe(true);
    expect(ctx.active_decisions.map((d) => d.id)).not.toContain(collide.id);
    expect(ContextAssembler.formatForLLM(ctx)).not.toContain("SEGMENT-COLLIDE-RECORD");
  });

  it("a foreign record NAMING an in-scope file is KEPT — Gate 1's actual question", async () => {
    // Authorization is decided by the record's own scope; relevance by the file
    // that matched. Cutting these would turn a real constraint into silence on
    // exactly the query this project's workflow tells agents to make.
    const { twiningDir } = project();
    const { ds, foreignFile } = await seed(twiningDir);
    const a = new ContextAssembler(new BlackboardStore(twiningDir), ds, null, { ...DEFAULT_CONFIG });
    const ctx = await a.assemble("auth work", "src/auth/", 100000);
    expect(ctx.active_decisions.map((d) => d.id)).toContain(foreignFile.id);
  });

  it("a foreign record naming only FOREIGN files is cut", async () => {
    const { twiningDir } = project();
    const { ds, foreignOnly } = await seed(twiningDir);
    const a = new ContextAssembler(new BlackboardStore(twiningDir), ds, null, { ...DEFAULT_CONFIG });
    const ctx = await a.assemble("auth work", "src/auth/", 100000);
    expect(ctx.active_decisions.map((d) => d.id)).not.toContain(foreignOnly.id);
  });

  it("the SEMANTIC path is gated too: a strong text match from an unrelated scope never enters", async () => {
    const { twiningDir } = project();
    const ds = new DecisionStore(twiningDir);
    await ds.create({ ...BASE, scope: "src/auth/", summary: "Use JWT", rationale: "scaling" });
    const bait = await ds.create({
      ...BASE,
      scope: "vendor/billing/",
      summary: "Proration rounding uses banker's rounding for invoice totals",
      rationale: "Proration rounding drift across invoice totals reconciles with banker's rounding",
    });
    const embedder = new Embedder(twiningDir);
    (embedder as unknown as { fallbackMode: boolean }).fallbackMode = true;
    const a = new ContextAssembler(
      new BlackboardStore(twiningDir),
      ds,
      new SearchEngine(embedder, new IndexManager(twiningDir)),
      { ...DEFAULT_CONFIG },
    );
    const ctx = await a.assemble("proration rounding drift across invoice totals", "src/auth/", 100000);
    expect(ctx.active_decisions.map((d) => d.id)).not.toContain(bait.id);
  });

  it("the annex reports the cut rather than leaving a zero result indistinguishable from an empty store", async () => {
    const { twiningDir } = project();
    const { ds } = await seed(twiningDir);
    const a = new ContextAssembler(new BlackboardStore(twiningDir), ds, null, { ...DEFAULT_CONFIG });
    const ctx = await a.assemble("auth work", "src/auth/", 100000);
    const visible = ctx.retrieval.selection.suppressed_visible.map((s) => s.id);
    expect(visible.length).toBeGreaterThan(0);
    expect(Object.keys(ctx.retrieval.selection.suppressed)).toContain("out_of_query_scope");
  });

  it("the named-suppression sample is CAPPED, so the annex cannot grow with the store", async () => {
    const { twiningDir } = project();
    const ds = new DecisionStore(twiningDir);
    await ds.create({ ...BASE, scope: "src/auth/", summary: "in", rationale: "r" });
    for (let i = 0; i < 40; i++) {
      await ds.create({ ...BASE, scope: `vendor/mod${i}/`, summary: `out ${i}`, rationale: "r" });
    }
    const a = new ContextAssembler(new BlackboardStore(twiningDir), ds, null, { ...DEFAULT_CONFIG });
    const ctx = await a.assemble("auth work", "src/auth/", 100000);
    expect(ctx.retrieval.selection.suppressed_visible.length).toBeLessThanOrEqual(20);
    expect(ctx.retrieval.selection.suppressed_visible_truncated).toBeGreaterThan(0);
    // The COUNTS stay exact even though the sample is capped.
    expect(ctx.retrieval.selection.suppressed.out_of_query_scope).toBe(40);
  });
});

/* ------------------------------------------------------------------ */
/* Surface 2 — DecisionEngine.why                                      */
/* ------------------------------------------------------------------ */

describe("PRODUCTION ENTRY POINT — DecisionEngine.why", () => {
  function engine(twiningDir: string) {
    const ds = new DecisionStore(twiningDir);
    const bb = new BlackboardStore(twiningDir);
    return { ds, engine: new DecisionEngine(ds, new BlackboardEngine(bb), { ...DEFAULT_CONFIG }) };
  }

  it("Gate 1's question: why(<file path>) KEEPS a decision that names the file from another scope", async () => {
    const { twiningDir } = project();
    const { ds, engine: de } = engine(twiningDir);
    const foreign = await ds.create({
      ...BASE,
      scope: "vendor/billing/",
      summary: "FOREIGN-FILE-RECORD",
      rationale: "r",
      affected_files: ["src/auth/jwt.ts"],
    });
    const res = await de.why("src/auth/jwt.ts");
    expect(res.decisions.map((d) => d.id)).toContain(foreign.id);
    expect(res.total_in_scope).toBeGreaterThanOrEqual(1);
  });

  it("why still cuts a segment collision", async () => {
    const { twiningDir } = project();
    const { ds, engine: de } = engine(twiningDir);
    const collide = await ds.create({ ...BASE, scope: "src/authz/", summary: "SEGMENT-COLLIDE", rationale: "r" });
    await ds.create({ ...BASE, scope: "src/auth/", summary: "IN", rationale: "r" });
    const res = await de.why("src/auth");
    expect(res.decisions.map((d) => d.id)).not.toContain(collide.id);
  });

  it("a zero result is distinguishable from an empty store: the cut is reported", async () => {
    const { twiningDir } = project();
    const { ds, engine: de } = engine(twiningDir);
    await ds.create({ ...BASE, scope: "src/authz/", summary: "SEGMENT-COLLIDE", rationale: "r" });
    const res = await de.why("src/auth");
    expect(res.total_in_scope).toBe(0);
    expect(res.scope_suppressed).toBeDefined();
    expect(res.scope_suppressed!.some((x) => x.count > 0)).toBe(true);

    // ...whereas a genuinely empty store reports no suppression at all.
    const { twiningDir: empty } = project();
    const emptyRes = await engine(empty).engine.why("src/auth");
    expect(emptyRes.total_in_scope).toBe(0);
    expect(emptyRes.scope_suppressed).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Surface 3 — dashboard createQueryHandler                            */
/* ------------------------------------------------------------------ */

describe("PRODUCTION ENTRY POINT — dashboard createQueryHandler", () => {
  async function call(root: string, url: string): Promise<any> {
    const handler = createQueryHandler(root);
    let payload = "";
    const req = { url, method: "GET", headers: {} } as unknown as http.IncomingMessage;
    const res = {
      writeHead() {
        return this;
      },
      setHeader() {
        return this;
      },
      end(chunk?: unknown) {
        if (typeof chunk === "string") payload = chunk;
        else if (Buffer.isBuffer(chunk)) payload = chunk.toString("utf8");
        return this;
      },
    } as unknown as http.ServerResponse;
    await handler(req, res);
    return payload ? JSON.parse(payload) : null;
  }

  it("the scope filter runs the shared gate: a segment collision is cut", async () => {
    const { root, twiningDir } = project();
    await seed(twiningDir);
    const body = await call(root, "/api/index?scope=src/auth");
    const summaries = body.rows.map((r: { summary: string }) => r.summary);
    expect(summaries).toContain("IN-SCOPE-RECORD");
    expect(summaries).not.toContain("SEGMENT-COLLIDE-RECORD");
    expect(body.scope_filtered).toBeGreaterThan(0);
  });

  it("without the parameter nothing is filtered — behaviour is unchanged", async () => {
    const { root, twiningDir } = project();
    await seed(twiningDir);
    const body = await call(root, "/api/index");
    expect(body.rows).toHaveLength(4);
    expect(body.scope_filtered).toBeUndefined();
  });
});
