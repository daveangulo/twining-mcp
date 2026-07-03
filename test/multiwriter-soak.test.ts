/**
 * Multiwriter concurrency soak (FOUNDATION-PLAN W2.2 acceptance).
 *
 * Spawns real writer PROCESSES against one shared store — the scenario the
 * product actually lives in (N Claude Code sessions, one .twining/) — and
 * audits four claims per backend:
 *
 *  1. No lost acknowledged writes: every op a child ACKed (printed only
 *     after commit) exists in the store afterward, exactly once.
 *  2. No torn reads: a reader polling DURING the writes never sees an
 *     unparseable store or a shrinking count.
 *  3. Crash tolerance: one writer is SIGKILLed mid-stream; the store stays
 *     consistent, survivors finish, and every op the victim ACKed before
 *     death is durable. (Lost pipe-buffered ACKs under-count, never
 *     over-claim — the assertion direction is safe by construction.)
 *  4. Contended upserts converge: all writers hammer the same graph entity
 *     and agent row; exactly one row remains with merged state.
 *
 * Children run the COMPILED stores from dist/ (vitest can't lend its TS
 * transform to child processes), so the suite skips when dist/ is missing.
 * CI builds before testing and always runs it. Scale up locally with e.g.
 * SOAK_SCALE=10 npm test -- multiwriter-soak
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CHILD = path.join(__dirname, "soak", "child-writer.mjs");
const HAS_DIST = fs.existsSync(
  path.join(REPO_ROOT, "dist", "storage", "sqlite", "db.js"),
);

const SCALE = Number(process.env.SOAK_SCALE || 1);
const WRITERS = 4;
const OPS = 60 * SCALE; // per writer; keeps the default run in seconds
const KILLED_WRITER = 1;
// The victim gets a budget it cannot finish before the SIGKILL lands: on a
// fast machine the sqlite writers complete 60 ops in well under the ack
// poller's latency, and a victim that finishes cleanly can't be killed
// "mid-stream" — the flake this bound removes.
const VICTIM_OPS = OPS * 100;

interface WriterResult {
  writerId: number;
  acks: string[];
  done: boolean;
  exitCode: number | null;
  killed: boolean;
}

function spawnWriter(
  backend: "files" | "sqlite",
  projectRoot: string,
  writerId: number,
  ops: number,
): { child: ChildProcess; result: WriterResult; finished: Promise<void> } {
  const result: WriterResult = {
    writerId,
    acks: [],
    done: false,
    exitCode: null,
    killed: false,
  };
  const child = spawn(
    process.execPath,
    [CHILD, backend, projectRoot, String(writerId), String(ops)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buf = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("ACK ")) result.acks.push(line.slice(4));
      if (line.startsWith("DONE ")) result.done = true;
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const finished = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      result.exitCode = code;
      result.killed = signal === "SIGKILL";
      if (code !== 0 && !result.killed && stderr) {
        // Surface child failures in the test output
        console.error(`[soak] writer ${writerId} stderr:\n${stderr}`);
      }
      resolve();
    });
  });
  return { child, result, finished };
}

/** Load stores from dist for the parent's own reads/audit. */
async function parentStores(backend: "files" | "sqlite", projectRoot: string) {
  const twiningDir = path.join(projectRoot, ".twining");
  const dist = path.join(REPO_ROOT, "dist");
  if (backend === "sqlite") {
    const { openDatabase } = await import(
      path.join(dist, "storage", "sqlite", "db.js")
    );
    const stores = await import(
      path.join(dist, "storage", "sqlite", "sqlite-stores.js")
    );
    const db = openDatabase(twiningDir);
    return {
      db,
      bb: new stores.SqliteBlackboardStore(db),
      dc: new stores.SqliteDecisionStore(db),
      gr: new stores.SqliteGraphStore(db),
      ag: new stores.SqliteAgentStore(db),
      im: new stores.SqliteIndexManager(db),
    };
  }
  const { BlackboardStore } = await import(
    path.join(dist, "storage", "blackboard-store.js")
  );
  const { DecisionStore } = await import(
    path.join(dist, "storage", "decision-store.js")
  );
  const { GraphStore } = await import(
    path.join(dist, "storage", "graph-store.js")
  );
  const { AgentStore } = await import(
    path.join(dist, "storage", "agent-store.js")
  );
  const { IndexManager } = await import(
    path.join(dist, "embeddings", "index-manager.js")
  );
  return {
    db: null,
    bb: new BlackboardStore(twiningDir),
    dc: new DecisionStore(twiningDir),
    gr: new GraphStore(twiningDir),
    ag: new AgentStore(twiningDir),
    im: new IndexManager(twiningDir),
  };
}

async function initProject(backend: "files" | "sqlite", projectRoot: string) {
  const dist = path.join(REPO_ROOT, "dist");
  const { initTwiningDir } = await import(path.join(dist, "storage", "init.js"));
  initTwiningDir(projectRoot);
  if (backend === "sqlite") {
    const { openDatabase } = await import(
      path.join(dist, "storage", "sqlite", "db.js")
    );
    openDatabase(path.join(projectRoot, ".twining")).close(); // pre-create schema
  }
}

async function runSoak(backend: "files" | "sqlite") {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `twining-soak-${backend}-`),
  );
  try {
    await initProject(backend, projectRoot);

    // Parent uses fresh store instances for polling (its own connection).
    const reader = await parentStores(backend, projectRoot);

    const writers = Array.from({ length: WRITERS }, (_, i) =>
      spawnWriter(backend, projectRoot, i, i === KILLED_WRITER ? VICTIM_OPS : OPS),
    );

    // Torn-read poller: every observation must parse and counts must be
    // monotonically non-decreasing. Runs until all writers exit.
    let lastCount = 0;
    let pollError: unknown = null;
    let polling = true;
    const poller = (async () => {
      while (polling) {
        try {
          const { total_count } = await reader.bb.read();
          if (total_count < lastCount) {
            throw new Error(
              `blackboard count shrank: ${lastCount} -> ${total_count}`,
            );
          }
          lastCount = total_count;
          await reader.dc.getIndex(); // must parse
          await reader.gr.getEntities(); // must parse
        } catch (err) {
          pollError = err;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    // Kill one writer once it has made some progress.
    const victim = writers[KILLED_WRITER]!;
    const killer = (async () => {
      const deadline = Date.now() + 30_000;
      while (victim.result.acks.length < OPS / 3 && Date.now() < deadline) {
        if (victim.result.exitCode !== null) return; // finished early
        await new Promise((r) => setTimeout(r, 20));
      }
      victim.child.kill("SIGKILL");
    })();

    await Promise.all(writers.map((w) => w.finished));
    await killer;
    polling = false;
    await poller;

    expect(pollError).toBeNull();

    // Survivors must have completed cleanly.
    for (const w of writers) {
      if (w.result.writerId === KILLED_WRITER) continue;
      expect(w.result.done, `writer ${w.result.writerId} finished`).toBe(true);
      expect(w.result.exitCode).toBe(0);
      expect(w.result.acks).toHaveLength(OPS);
    }
    // Victim was actually killed mid-stream with some progress.
    expect(victim.result.killed).toBe(true);
    expect(victim.result.acks.length).toBeGreaterThan(0);
    expect(victim.result.acks.length).toBeLessThan(VICTIM_OPS);

    // ---- Final audit through a FRESH connection ----
    const audit = await parentStores(backend, projectRoot);

    if (backend === "sqlite") {
      const row = (audit.db as { prepare(sql: string): { get(): unknown } })
        .prepare("PRAGMA integrity_check;")
        .get() as { integrity_check: string };
      expect(row.integrity_check).toBe("ok");
    }

    const { entries } = await audit.bb.read();
    const index = await audit.dc.getIndex();
    const entities = await audit.gr.getEntities();
    const decisionsBySummary = new Map(index.map((d) => [d.summary, d]));
    const bbSummaries = entries.map((e) => e.summary);
    const bbSet = new Set(bbSummaries);

    // No duplicates anywhere.
    expect(bbSet.size).toBe(bbSummaries.length);
    expect(new Set(index.map((d) => d.summary)).size).toBe(index.length);

    // Contended upserts converged to a single merged row.
    const shared = entities.filter((e) => e.name === "shared-entity");
    expect(shared).toHaveLength(1);
    expect(await audit.ag.get("shared-agent")).not.toBeNull();

    // Every ACKed op is durable — including the victim's pre-kill ACKs.
    for (const w of writers) {
      for (const ack of w.result.acks) {
        const seq = Number(ack.split(":")[1]);
        switch (seq % 5) {
          case 0:
            expect(bbSet.has(ack), `blackboard ${ack}`).toBe(true);
            break;
          case 1: {
            const d = decisionsBySummary.get(ack);
            expect(d, `decision ${ack}`).toBeDefined();
            expect(d!.status).toBe("provisional");
            break;
          }
          case 2:
            expect(
              shared[0]!.properties[`w${w.result.writerId}_${seq}`],
              `entity property ${ack}`,
            ).toBe("1");
            break;
          case 3:
            break; // touch: presence asserted above; per-op state is overwritten by design
          case 4:
            expect(
              await audit.im.getVector("blackboard", ack),
              `vector ${ack}`,
            ).toEqual([seq, w.result.writerId, 1]);
            break;
        }
      }
    }

    if (backend === "sqlite") {
      (audit.db as { close(): void }).close();
      (reader.db as { close(): void }).close();
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe.skipIf(!HAS_DIST)("multiwriter soak (real processes)", () => {
  // Generous timeouts: the file backend's stale-lock recovery after SIGKILL
  // can legitimately stall other writers for up to proper-lockfile's 10s
  // stale window.
  it("file backend: 4 writers, one SIGKILLed, no lost acks or torn reads", {
    timeout: 120_000,
  }, async () => {
    await runSoak("files");
  });

  it.skipIf(!HAS_SQLITE)(
    "sqlite backend: 4 writers, one SIGKILLed, no lost acks or torn reads",
    { timeout: 120_000 },
    async () => {
      await runSoak("sqlite");
    },
  );
});

// Keep vitest from treating an empty skip as a missing suite on no-dist runs.
describe.skipIf(HAS_DIST)("multiwriter soak (skipped)", () => {
  it("requires dist/ — run `npm run build` first (CI always does)", () => {
    expect(HAS_DIST).toBe(false);
  });
});
