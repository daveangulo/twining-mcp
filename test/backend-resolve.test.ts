import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAutoBackend } from "../src/storage/backend-resolve.js";
import { createStores } from "../src/storage/backend-factory.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

let dir: string;

// A minimal file that passes the S0 guard: real SQLite magic + nonzero size.
// (The guard checks the 16-byte header, not schema validity.)
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
function writeRealDb(p: string): void {
  fs.writeFileSync(p, Buffer.concat([SQLITE_HEADER, Buffer.alloc(84)]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-resolve-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveAutoBackend", () => {
  it("fresh project (empty dir) → sqlite", () => {
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("fresh project with only empty scaffold files → sqlite", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
    fs.mkdirSync(path.join(dir, "graph"));
    fs.writeFileSync(path.join(dir, "graph", "entities.json"), "[]");
    fs.writeFileSync(path.join(dir, "graph", "relations.json"), "[]");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("non-empty twining.db with sqlite header → sqlite (already migrated)", () => {
    writeRealDb(path.join(dir, "twining.db"));
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });

  // S0 guard (2026-08-15 field audit): a 0-byte twining.db — crash, disk-full,
  // or interrupted-migration artifact — must never select an empty database
  // beside real legacy state. Existence is not state.
  it("0-byte twining.db + legacy decisions → files (silent-amnesia guard)", () => {
    fs.writeFileSync(path.join(dir, "twining.db"), "");
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), '[{"id":"01X"}]');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("0-byte twining.db alone → fresh (crash artifact carries no state)", () => {
    fs.writeFileSync(path.join(dir, "twining.db"), "");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("garbage twining.db + legacy content → files (ambiguity lands safe)", () => {
    fs.writeFileSync(path.join(dir, "twining.db"), "not a database");
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("0-byte twining.db + populated records/ → sqlite (rehydrates from records)", () => {
    fs.writeFileSync(path.join(dir, "twining.db"), "");
    fs.mkdirSync(path.join(dir, "records", "decisions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "records", "decisions", "01ABC.json"), "{}");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });

  it("records/ tree with any record file → sqlite", () => {
    fs.mkdirSync(path.join(dir, "records", "posts", "2026-07"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "records", "posts", "2026-07", "01ABC.json"),
      "{}",
    );
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });

  it("empty records/ directories alone do NOT count as sqlite state", () => {
    fs.mkdirSync(path.join(dir, "records", "posts"), { recursive: true });
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "fresh" });
  });

  it("non-empty blackboard.jsonl and no sqlite state → files", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("non-trivial decisions index and no sqlite state → files", () => {
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), '[{"id":"01X"}]');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("stray decision file with empty index → files (index-desync salvage)", () => {
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
    fs.writeFileSync(path.join(dir, "decisions", "01ORPHAN.json"), "{}");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("non-empty graph entities and no sqlite state → files", () => {
    fs.mkdirSync(path.join(dir, "graph"));
    fs.writeFileSync(path.join(dir, "graph", "entities.json"), '[{"id":"e1"}]');
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("malformed legacy file → files (ambiguity lands on the safe branch)", () => {
    fs.mkdirSync(path.join(dir, "decisions"));
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "{not json");
    expect(resolveAutoBackend(dir)).toEqual({ backend: "files", reason: "legacy-content" });
  });

  it("sqlite state wins over legacy content (post-migration repos have both)", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    writeRealDb(path.join(dir, "twining.db"));
    expect(resolveAutoBackend(dir)).toEqual({ backend: "sqlite", reason: "sqlite-state" });
  });
});

describe("createStores auto resolution (v2 default flip)", () => {
  it.runIf(HAS_SQLITE)("default config on a fresh dir resolves to sqlite", () => {
    const stores = createStores(dir, { ...DEFAULT_CONFIG });
    expect(stores.backend).toBe("sqlite");
  });

  it("default config on a legacy-content dir resolves to files", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    const stores = createStores(dir, { ...DEFAULT_CONFIG });
    expect(stores.backend).toBe("files");
  });

  it("explicit backend: files is respected regardless of dir state", () => {
    const config = {
      ...DEFAULT_CONFIG,
      storage: { ...DEFAULT_CONFIG.storage, backend: "files" as const },
    };
    const stores = createStores(dir, config);
    expect(stores.backend).toBe("files");
  });

  it.runIf(HAS_SQLITE)("StoreSet carries the resolution reason (fresh)", () => {
    const stores = createStores(dir, { ...DEFAULT_CONFIG });
    expect(stores.reason).toBe("fresh");
    expect(stores.legacy_unread).toBe(false);
  });

  it("StoreSet carries the resolution reason (legacy-content)", () => {
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
    const stores = createStores(dir, { ...DEFAULT_CONFIG });
    expect(stores.reason).toBe("legacy-content");
    expect(stores.legacy_unread).toBe(false);
  });

  it("StoreSet carries reason 'explicit' for a configured backend", () => {
    const config = {
      ...DEFAULT_CONFIG,
      storage: { ...DEFAULT_CONFIG.storage, backend: "files" as const },
    };
    const stores = createStores(dir, config);
    expect(stores.reason).toBe("explicit");
  });

  // S0-explicit: config backend: sqlite over an empty db beside legacy-only
  // content must not boot silently — the store would read as empty.
  it.runIf(HAS_SQLITE)(
    "explicit sqlite with empty db beside legacy content sets legacy_unread",
    () => {
      fs.mkdirSync(path.join(dir, "decisions"));
      fs.writeFileSync(path.join(dir, "decisions", "index.json"), '[{"id":"01X"}]');
      const config = {
        ...DEFAULT_CONFIG,
        storage: { ...DEFAULT_CONFIG.storage, backend: "sqlite" as const },
      };
      const stores = createStores(dir, config);
      expect(stores.backend).toBe("sqlite");
      expect(stores.legacy_unread).toBe(true);
    },
  );

  it("user-set auto_migrate survives config merge (deepMerge target trap)", () => {
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      "storage:\n  auto_migrate: true\n",
    );
    const config = loadConfig(dir);
    expect(config.storage?.auto_migrate).toBe(true);
  });
});

// 2.16.0 pre-tag review LS-1/CS-5/SC-3: the amnesia warning must be
// tier-matched (a migrated blackboard-only store must not cry wolf forever)
// and id-precise for the decisions tier (post-flip decisions must not mask
// unread legacy state).
describe("legacy_unread tier matching", () => {
  it.runIf(HAS_SQLITE)(
    "migrated blackboard-only store goes quiet once posts are in the db",
    async () => {
      fs.writeFileSync(path.join(dir, "blackboard.jsonl"), '{"id":"01X"}\n');
      const config = {
        ...DEFAULT_CONFIG,
        storage: { ...DEFAULT_CONFIG.storage, backend: "sqlite" as const },
      };
      const boot1 = createStores(dir, config);
      // Legacy posts not yet imported — the blackboard tier IS unread.
      expect(boot1.legacy_unread).toBe(true);
      await boot1.blackboardStore.append({
        agent_id: "t",
        entry_type: "finding",
        tags: [],
        scope: "src/",
        summary: "imported",
        detail: "",
      });
      const boot2 = createStores(dir, config);
      // Posts tier populated; empty decisions table must NOT trigger the
      // warning (there is no legacy decisions content to be unread).
      expect(boot2.legacy_unread).toBe(false);
    },
  );

  it.runIf(HAS_SQLITE)(
    "legacy decision ids absent from the db flag unread state even beside post-flip decisions",
    async () => {
      const config = {
        ...DEFAULT_CONFIG,
        storage: { ...DEFAULT_CONFIG.storage, backend: "sqlite" as const },
      };
      const boot1 = createStores(dir, config);
      await boot1.decisionStore.create({
        agent_id: "t",
        domain: "architecture",
        scope: "src/",
        summary: "post-flip ruling",
        context: "",
        rationale: "r",
        constraints: [],
        alternatives: [],
        depends_on: [],
        confidence: "high",
        reversible: true,
        affected_files: [],
        affected_symbols: [],
      });
      // Legacy index appears afterwards (e.g. git checkout of an old branch)
      // with an id the db has never seen.
      fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "decisions", "index.json"),
        '[{"id":"01LEGACYUNSEEN00000000000X"}]',
      );
      const boot2 = createStores(dir, config);
      expect(boot2.legacy_unread).toBe(true);
    },
  );
});

// 2.16.0 pre-tag review SC-4: the reverse-stranding shape — sqlite→files
// fallback serving stale legacy history while migrated truth sits in records/.
describe("records_unread on sqlite fallback", () => {
  it("flags a fallback boot when records/ holds migrated state", () => {
    // A directory at twining.db makes openDatabase throw → files fallback.
    fs.mkdirSync(path.join(dir, "twining.db"));
    fs.mkdirSync(path.join(dir, "records", "decisions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "records", "decisions", "01ABC.json"), "{}");
    const config = {
      ...DEFAULT_CONFIG,
      storage: { ...DEFAULT_CONFIG.storage, backend: "sqlite" as const },
    };
    const stores = createStores(dir, config);
    expect(stores.backend).toBe("files");
    expect(stores.reason).toBe("fallback");
    expect(stores.records_unread).toBe(true);
  });
});
