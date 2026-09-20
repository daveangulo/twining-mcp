/**
 * `.twining/store.json` has two producers with two shapes:
 *
 *  - `twining identity init` (ensureStoreDescriptor) writes
 *    `{ store_id, repo_ids: [...], format, created_at }` — no `repo_id` key.
 *  - `migrate --to 3` finalize writes BOTH `repo_id` and `repo_ids`.
 *
 * The scope gate must read both as minted identity. Before this suite an
 * identity-init store fell through to the path-derived synthetic id, so the
 * RetrievalAnnex reported format 2 / derived-from-path for a v3 store while
 * every event the runtime minted cited `repo_ids[0]`.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureStoreDescriptor } from "../../src/adapters/identity.js";
import {
  deriveRepoId,
  readStoreIdentity,
  resetStoreIdentityCache,
  storeIdentity,
} from "../../src/retrieval/store-identity.js";

const STORE = "s_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPO_A = "r_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPO_B = "r_01BX5ZZKBKACTAV9WEVGEMMVRZ";

const roots: string[] = [];

/** A fresh `.twining` path under a scratch project; the directory may not exist yet. */
function scratchTwiningDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-store-identity-"));
  roots.push(dir);
  return path.join(dir, ".twining");
}

function writeStoreJson(twiningDir: string, body: unknown): void {
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "store.json"), JSON.stringify(body, null, 2) + "\n");
}

afterEach(() => {
  resetStoreIdentityCache();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readStoreIdentity on an identity-init store (repo_ids only)", () => {
  it("reads the minted store_id and repo_ids[0] as format 3, non-derived, source store.json", () => {
    const tw = scratchTwiningDir();
    const { descriptor, repoId } = ensureStoreDescriptor(tw);

    // Pin the producer shape this suite exists for: the real writer emits no repo_id key.
    const raw = JSON.parse(fs.readFileSync(path.join(tw, "store.json"), "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("repo_id");
    expect(raw.repo_ids).toEqual([repoId]);
    expect(raw.format).toBe(3);

    const id = readStoreIdentity(tw);
    expect(id).toEqual({
      repo: repoId,
      store_id: descriptor.store_id,
      repo_ids: [repoId],
      format: 3,
      derived: false,
      source: "store.json",
    });
    expect(id.repo).not.toBe(deriveRepoId(tw));
  });

  it("takes the FIRST declared repo id on a shared store, matching repoIdFor", () => {
    const tw = scratchTwiningDir();
    const first = ensureStoreDescriptor(tw);
    const second = ensureStoreDescriptor(tw, { repoId: REPO_B });
    expect(second.descriptor.repo_ids).toEqual([first.repoId, REPO_B]);

    const id = readStoreIdentity(tw);
    expect(id.repo).toBe(first.repoId);
    expect(id.repo_ids).toEqual([first.repoId, REPO_B]);
    expect(id.store_id).toBe(first.descriptor.store_id);
    expect(id.derived).toBe(false);
    expect(id.source).toBe("store.json");
  });
});

describe("readStoreIdentity on a migrate-finalized store (both keys)", () => {
  it("prefers repo_id over repo_ids[0]", () => {
    const tw = scratchTwiningDir();
    writeStoreJson(tw, { store_id: STORE, repo_id: REPO_A, repo_ids: [REPO_B, REPO_A], format: 3 });

    const id = readStoreIdentity(tw);
    expect(id.repo).toBe(REPO_A);
    expect(id.repo_ids).toEqual([REPO_B, REPO_A]);
    expect(id.store_id).toBe(STORE);
    expect(id.format).toBe(3);
    expect(id.derived).toBe(false);
    expect(id.source).toBe("store.json");
  });
});

describe("readStoreIdentity falls back to the path-derived id", () => {
  const derived = (tw: string) => ({
    repo: deriveRepoId(tw),
    format: 2,
    derived: true,
    source: "derived-from-path",
  });

  it("when store.json is absent", () => {
    const tw = scratchTwiningDir();
    expect(readStoreIdentity(tw)).toEqual(derived(tw));
  });

  it("when store.json declares an EMPTY repo_ids and no repo_id", () => {
    const tw = scratchTwiningDir();
    writeStoreJson(tw, { store_id: STORE, repo_ids: [], format: 3 });
    expect(readStoreIdentity(tw)).toEqual(derived(tw));
  });

  it("when repo_ids[0] is not a non-empty string", () => {
    const tw = scratchTwiningDir();
    writeStoreJson(tw, { store_id: STORE, repo_ids: [42, REPO_A], format: 3 });
    expect(readStoreIdentity(tw)).toEqual(derived(tw));
    writeStoreJson(tw, { store_id: STORE, repo_ids: ["", REPO_A], format: 3 });
    expect(readStoreIdentity(tw)).toEqual(derived(tw));
  });

  it("when store.json is unparseable", () => {
    const tw = scratchTwiningDir();
    fs.mkdirSync(tw, { recursive: true });
    fs.writeFileSync(path.join(tw, "store.json"), "{ not json");
    expect(readStoreIdentity(tw)).toEqual(derived(tw));
  });
});

describe("storeIdentity cache", () => {
  it("caches per directory until reset, then re-reads the identity-init file", () => {
    const tw = scratchTwiningDir();
    const before = storeIdentity(tw);
    expect(before.derived).toBe(true);

    const { repoId } = ensureStoreDescriptor(tw);
    expect(storeIdentity(tw)).toBe(before);

    resetStoreIdentityCache();
    const after = storeIdentity(tw);
    expect(after.derived).toBe(false);
    expect(after.repo).toBe(repoId);
  });
});
