/**
 * Gap 8 — export/ingest round-trip fidelity (baseline 07230e6).
 * Requirements R05 R06 R07 R08 R09 R19.
 *
 * The export tree (.twining/records/) is the committable truth that rides git
 * between hosts, and ingest converges the local sqlite db to it with a
 * file-wins rule. This file pins the two observable consequences of that
 * design at baseline:
 *
 *   Gap A — a lifecycle MUTATION rewrites the SAME file path in place. No new
 *   file is produced, the record's prior bytes are overwritten, and nothing in
 *   the tree retains them. The tree is a snapshot of current state, not a log
 *   of what happened to a record.
 *
 *   Gap B — because the file wins unconditionally on content, a peer host's
 *   (or git's) older committed bytes landing on that same path silently move
 *   the db row BACKWARDS through the lifecycle; the local supersede is gone.
 *   Baseline counts the event (stats.lifecycle_reverts) but does not prevent
 *   or preserve the losing write.
 *
 * Positive control (first test): a CREATE-ONLY record round-trips
 * byte-identical through export -> ingest, proving the instrument — stores,
 * export tree, ingest and the byte comparison — works, so the two gap
 * assertions below are about mutation, not about a broken harness.
 *
 * Setup idioms (HAS_SQLITE guard, sqliteConfig, dirA/dirB tmpdirs, store
 * construction) are mirrored from test/record-sync.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../../src/storage/sqlite/db.js";
import { stableStringify } from "../../../src/storage/sync/record-export.js";
import { ingestRecords } from "../../../src/storage/sync/record-ingest.js";
import {
  createStores,
  type StoreSet,
} from "../../../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";
import type { TwiningConfig } from "../../../src/utils/types.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const sqliteConfig = (): TwiningConfig => ({
  ...DEFAULT_CONFIG,
  storage: { backend: "sqlite", export_records: true },
});

let dirA: string;
let dirB: string;

beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap8-a-"));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap8-b-"));
});

afterEach(() => {
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

/** Every .json file under the export tree, sorted — used to prove no NEW file appears. */
function treeFiles(recordsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".json")) out.push(path.relative(recordsDir, p));
    }
  };
  walk(recordsDir);
  return out.sort();
}

function makeStores(dir: string): { tw: string; stores: StoreSet } {
  const tw = path.join(dir, ".twining");
  fs.mkdirSync(tw, { recursive: true });
  return { tw, stores: createStores(tw, sqliteConfig()) };
}

async function createDecision(stores: StoreSet) {
  return stores.decisionStore.create({
    agent_id: "main",
    domain: "architecture",
    scope: "src/auth/",
    summary: "use blackboard pattern",
    context: "c",
    rationale: "r",
    alternatives: [],
    confidence: "high",
    affected_files: [],
    affected_symbols: [],
    reversible: true,
  } as never);
}

describe.skipIf(!HAS_SQLITE)("gap 8 — export/ingest round-trip", () => {
  // ---------------------------------------------------------------- control
  it("POSITIVE CONTROL: a create-only record round-trips byte-identical through export -> ingest", async () => {
    const { tw: twA, stores: storesA } = makeStores(dirA);
    const decision = await createDecision(storesA);
    const post = await storesA.blackboardStore.append({
      entry_type: "finding",
      summary: "auth tokens in localStorage",
      detail: "d",
      tags: ["auth"],
      scope: "src/auth/",
      agent_id: "main",
    });

    const decFileA = path.join(twA, "records", "decisions", `${decision.id}.json`);
    const postFileA = path.join(
      twA,
      "records",
      "posts",
      post.timestamp.slice(0, 7),
      `${post.id}.json`,
    );
    const decBytesA = fs.readFileSync(decFileA, "utf-8");
    const postBytesA = fs.readFileSync(postFileA, "utf-8");
    expect(JSON.parse(decBytesA).status).toBe("active");

    // Host B clones only the records tree (twining.db is gitignored) and
    // ingests it on startup.
    const twB = path.join(dirB, ".twining");
    fs.mkdirSync(twB, { recursive: true });
    fs.cpSync(path.join(twA, "records"), path.join(twB, "records"), {
      recursive: true,
    });
    const storesB = createStores(twB, sqliteConfig());

    // B's read model re-serializes to exactly A's exported bytes.
    const decB = await storesB.decisionStore.get(decision.id);
    expect(decB).toBeDefined();
    expect(stableStringify(decB)).toBe(decBytesA);
    const postB = (await storesB.blackboardStore.read()).entries.find(
      (e) => e.id === post.id,
    );
    expect(postB).toBeDefined();
    expect(stableStringify(postB)).toBe(postBytesA);

    // And B's own export of the ingested records is byte-identical too.
    expect(
      fs.readFileSync(
        path.join(twB, "records", "decisions", `${decision.id}.json`),
        "utf-8",
      ),
    ).toBe(decBytesA);
  });

  // ------------------------------------------------------------------ gap A
  it("GAP A: a lifecycle mutation rewrites the SAME export file in place — the record's prior bytes are gone from the tree", async () => {
    const { tw: twA, stores } = makeStores(dirA);
    const decision = await createDecision(stores);

    const recordsDir = path.join(twA, "records");
    const decFile = path.join(recordsDir, "decisions", `${decision.id}.json`);
    const activeBytes = fs.readFileSync(decFile, "utf-8");
    expect(JSON.parse(activeBytes).status).toBe("active");
    const filesBefore = treeFiles(recordsDir);

    await stores.decisionStore.updateStatus(decision.id, "superseded");

    const filesAfter = treeFiles(recordsDir);
    // 1. No new file: the mutation produced no additional record anywhere.
    expect(filesAfter).toEqual(filesBefore);
    expect(
      filesAfter.filter((f) => f.includes(decision.id)),
    ).toHaveLength(1);

    // 2. The same path now holds different bytes.
    const supersededBytes = fs.readFileSync(decFile, "utf-8");
    expect(supersededBytes).not.toBe(activeBytes);
    expect(JSON.parse(supersededBytes).status).toBe("superseded");

    // 3. The prior bytes survive nowhere in the tree — no sibling copy, no
    //    history file, no backup. Recovering "what this decision said before"
    //    requires git, not Twining.
    const everyFile = treeFiles(recordsDir).map((f) =>
      fs.readFileSync(path.join(recordsDir, f), "utf-8"),
    );
    expect(everyFile).not.toContain(activeBytes);
    expect(
      everyFile.some(
        (b) => b.includes(decision.id) && JSON.parse(b).status === "active",
      ),
    ).toBe(false);
  });

  // ------------------------------------------------------------------ gap B
  it("GAP B: a peer host's older committed bytes on that same path revert the db lifecycle state (file wins)", async () => {
    const { tw: twA, stores } = makeStores(dirA);
    const decision = await createDecision(stores);
    const decFile = path.join(twA, "records", "decisions", `${decision.id}.json`);
    const activeBytes = fs.readFileSync(decFile, "utf-8");

    // Host A supersedes locally (db row + mirror both say "superseded").
    await stores.decisionStore.updateStatus(decision.id, "superseded");
    expect(JSON.parse(fs.readFileSync(decFile, "utf-8")).status).toBe(
      "superseded",
    );
    const dbBefore = openDatabase(twA);
    expect(
      (
        dbBefore
          .prepare("SELECT status FROM decisions WHERE id = ?")
          .get(decision.id) as { status: string }
      ).status,
    ).toBe("superseded");
    dbBefore.close();

    // Host B never saw the supersede: its committed bytes for this record
    // still say "active". A git pull / checkout lands them on the SAME path
    // (gap A: there is only one path), overwriting A's mirror.
    fs.writeFileSync(decFile, activeBytes);

    const db = openDatabase(twA);
    const stats = ingestRecords(db, twA);

    // File wins: the db row is dragged backwards through the lifecycle.
    expect(stats.updated).toBe(1);
    expect(stats.lifecycle_reverts).toBe(1);
    expect(stats.lifecycle_revert_details).toEqual([
      {
        id: decision.id,
        from: "superseded",
        to: "active",
        scope: decision.scope,
      },
    ]);
    expect(
      (
        db
          .prepare("SELECT status FROM decisions WHERE id = ?")
          .get(decision.id) as { status: string }
      ).status,
    ).toBe("active");
    db.close();

    // The supersede is unrecoverable from Twining state: read model agrees,
    // and the mirror holds the peer's bytes verbatim.
    const after = await stores.decisionStore.get(decision.id);
    expect(after!.status).toBe("active");
    expect(fs.readFileSync(decFile, "utf-8")).toBe(activeBytes);
  });
});
