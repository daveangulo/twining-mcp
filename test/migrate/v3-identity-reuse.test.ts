/**
 * `twining identity init` BEFORE `twining migrate --to 3`.
 *
 * identity init (ensureStoreDescriptor) writes `.twining/store.json` as
 * `{ store_id, repo_ids, format, created_at }` — no `repo_id` key — and every
 * event minted through the adapter runtime cites `repo_ids[0]` as
 * `scope.repo`. A migration run afterwards used to read only `repo_id`, find
 * nothing, mint a path-seeded store_id/repo_id and overwrite store.json at
 * finalize — orphaning the ids already cited by events and the ceremony
 * membership. These cases pin the reuse: the migration adopts the existing
 * ids, finalize keeps them (and every other declared repo id), and a rerun is
 * byte-stable.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { ensureStoreDescriptor, readStoreDescriptor } from "../../src/adapters/identity.js";
import { EventStore } from "../../src/events/event-store.js";
import { migrateStatus, migrateToV3 } from "../../src/migrate/v3-forward.js";
import { cleanupStores, copyStore, readJson, scratchDir, twiningDirOf, V1_FIXTURE } from "./v3-helpers.js";

afterAll(cleanupStores);

const SECOND_REPO = "r_01BX5ZZKBKACTAV9WEVGEMMVRZ";

interface StoreJson {
  store_id: string;
  repo_id?: string;
  repo_ids: string[];
  format: number;
  created_at: string;
  migrated_from?: number;
}

const storeJsonOf = (tw: string): StoreJson => readJson<StoreJson>(path.join(tw, "store.json"));

describe("migrate status on an identity-init store", () => {
  it("reports the existing store_id and repo_ids[0], format 3, migration not_started", () => {
    const tw = path.join(scratchDir("v3idreuse"), ".twining");
    const { descriptor, repoId } = ensureStoreDescriptor(tw);
    expect(storeJsonOf(tw)).not.toHaveProperty("repo_id");

    const status = migrateStatus(tw);
    expect(status.store_id).toBe(descriptor.store_id);
    expect(status.repo_id).toBe(repoId);
    expect(status.format).toBe(3);
    expect(status.migration).toBe("not_started");
  });
});

describe("migrate --to 3 after identity init", () => {
  it("adopts the identity-init store_id and repo_ids[0]; finalize keeps them and every event cites them", async () => {
    const root = copyStore(V1_FIXTURE, "v3idreuse");
    const tw = twiningDirOf(root);
    const { descriptor: before, repoId } = ensureStoreDescriptor(tw);
    expect(storeJsonOf(tw)).not.toHaveProperty("repo_id");

    const report = await migrateToV3({ projectRoot: root });
    expect(report.ok).toBe(true);
    expect(report.state.identity.store_id).toBe(before.store_id);
    expect(report.state.identity.repo_id).toBe(repoId);

    const after = storeJsonOf(tw);
    expect(after.store_id).toBe(before.store_id);
    expect(after.repo_ids[0]).toBe(repoId);
    expect(after.repo_id).toBe(repoId);
    expect(after.format).toBe(3);
    expect(after.created_at).toBe(before.created_at);
    expect(after.migrated_from).toBe(1);

    // The adapter runtime and the migration now agree on scope.repo.
    expect(readStoreDescriptor(tw)?.repo_ids[0]).toBe(repoId);

    const status = migrateStatus(tw);
    expect(status.store_id).toBe(before.store_id);
    expect(status.repo_id).toBe(repoId);
    expect(status.migration).toBe("complete");

    const store = new EventStore({ twiningDir: tw });
    try {
      const events = await store.events({});
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) expect(ev.scope.repo).toBe(repoId);
    } finally {
      store.close();
    }
  });

  it("a shared store keeps EVERY declared repo id through finalize, first one as repo_id", async () => {
    const root = copyStore(V1_FIXTURE, "v3idreuse");
    const tw = twiningDirOf(root);
    const first = ensureStoreDescriptor(tw);
    ensureStoreDescriptor(tw, { repoId: SECOND_REPO });
    expect(storeJsonOf(tw).repo_ids).toEqual([first.repoId, SECOND_REPO]);

    const report = await migrateToV3({ projectRoot: root });
    expect(report.ok).toBe(true);

    const after = storeJsonOf(tw);
    expect(after.store_id).toBe(first.descriptor.store_id);
    expect(after.repo_id).toBe(first.repoId);
    expect(after.repo_ids).toEqual([first.repoId, SECOND_REPO]);
  });

  it("a rerun on the migrated store leaves store.json byte-identical", async () => {
    const root = copyStore(V1_FIXTURE, "v3idreuse");
    const tw = twiningDirOf(root);
    ensureStoreDescriptor(tw);
    expect((await migrateToV3({ projectRoot: root })).ok).toBe(true);
    const once = fs.readFileSync(path.join(tw, "store.json"), "utf8");

    const rerun = await migrateToV3({ projectRoot: root });
    expect(rerun.ok).toBe(true);
    expect(fs.readFileSync(path.join(tw, "store.json"), "utf8")).toBe(once);
  });
});
