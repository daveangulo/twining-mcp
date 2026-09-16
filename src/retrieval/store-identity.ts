/**
 * Repo identity for the scope gate, on both store generations (R01, R13).
 *
 * The gate needs a repo id for every record. Where it comes from depends on
 * what the store is:
 *
 *  - **v3** (`.twining/store.json` at `format: 3`): `repo_id` is minted once by
 *    `twining identity init` and survives renames and relocated clones. A
 *    shared store holds one `store_id` and several `repo_id`s; `repo_ids` lists
 *    them and `repo_id` names this checkout's.
 *  - **2.x** (no `store.json`, or an older format): there is no minted
 *    identity. A stable synthetic one is derived from the store's real path, so
 *    two different stores on one machine can never be confused for each other
 *    and one store's records always carry the same id across a session.
 *
 * The synthetic id is explicitly NOT a `repo_id` in the ADR's sense: it is not
 * portable, it does not survive a clone, and it is labelled `derived: true` so
 * nothing downstream mistakes it for minted identity. What it buys is the one
 * property gap 3 needs today — records from one store can never be ranked into
 * another store's briefing — without inventing durable identity that only
 * `identity init` may mint.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface StoreIdentity {
  repo: string;
  store_id?: string;
  /** Every repo this store holds records for, when the store declares them. */
  repo_ids?: string[];
  format: number;
  /** True when the id was derived from the path rather than minted. */
  derived: boolean;
  source: "store.json" | "derived-from-path";
}

/**
 * A stable, collision-resistant id for a store that has no minted identity.
 * The `r_` prefix satisfies `repoIdSchema`; `derived: true` keeps it honest.
 */
export function deriveRepoId(twiningDir: string): string {
  let real = twiningDir;
  try {
    real = fs.realpathSync(twiningDir);
  } catch {
    /* the directory may not exist yet; the literal path is still stable */
  }
  const digest = createHash("sha256").update(real).digest("hex").slice(0, 26);
  return `r_${digest}`;
}

export function readStoreIdentity(twiningDir: string): StoreIdentity {
  const file = path.join(twiningDir, "store.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      format?: number;
      repo_id?: string;
      store_id?: string;
      repo_ids?: string[];
    };
    if (raw && typeof raw.repo_id === "string" && raw.repo_id.length > 0) {
      return {
        repo: raw.repo_id,
        ...(raw.store_id ? { store_id: raw.store_id } : {}),
        ...(Array.isArray(raw.repo_ids) ? { repo_ids: raw.repo_ids } : {}),
        format: typeof raw.format === "number" ? raw.format : 3,
        derived: false,
        source: "store.json",
      };
    }
  } catch {
    /* absent or unreadable — fall through to the derived identity */
  }
  return { repo: deriveRepoId(twiningDir), format: 2, derived: true, source: "derived-from-path" };
}

/** Cached per directory: the file does not change inside one process's session. */
const cache = new Map<string, StoreIdentity>();

export function storeIdentity(twiningDir: string): StoreIdentity {
  const hit = cache.get(twiningDir);
  if (hit) return hit;
  const id = readStoreIdentity(twiningDir);
  cache.set(twiningDir, id);
  return id;
}

/** Test seam — the identity file can be written between cases. */
export function resetStoreIdentityCache(): void {
  cache.clear();
}
