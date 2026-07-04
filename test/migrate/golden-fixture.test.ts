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
