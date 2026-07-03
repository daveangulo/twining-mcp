/**
 * Live record sync (W2.3 phase 2): git moves HEAD mid-session → the sqlite
 * database converges to the checked-out export tree without a restart.
 * Uses real git repositories. Skipped where node:sqlite is unavailable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/storage/sqlite/db.js";
import {
  RecordSyncManager,
  attachSyncProbe,
} from "../src/storage/sync/sync-manager.js";
import { createStores, type StoreSet } from "../src/storage/backend-factory.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { TwiningConfig } from "../src/utils/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "soak",
      GIT_AUTHOR_EMAIL: "soak@test",
      GIT_COMMITTER_NAME: "soak",
      GIT_COMMITTER_EMAIL: "soak@test",
    },
  }).trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  // twining.db and its WAL siblings must never be committed (design D1).
  fs.writeFileSync(path.join(dir, ".gitignore"), ".twining/twining.db*\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-m", "init");
}

async function post(stores: StoreSet, summary: string): Promise<void> {
  await stores.blackboardStore.append({
    entry_type: "finding",
    summary,
    detail: "",
    tags: [],
    scope: "src/",
    agent_id: "main",
  });
}

async function summaries(stores: StoreSet): Promise<string[]> {
  return (await stores.blackboardStore.read()).entries
    .map((e) => e.summary)
    .sort();
}

function commitRecords(dir: string, message: string): void {
  git(dir, "add", ".twining");
  git(dir, "commit", "-m", message);
}

let dirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!HAS_SQLITE)("record sync manager", () => {
  it("branch switches converge the database both ways without a restart", async () => {
    const root = tmp("twining-sync-branch-");
    initRepo(root);
    const twiningDir = path.join(root, ".twining");
    fs.mkdirSync(twiningDir, { recursive: true });

    const stores = createStores(twiningDir, sqliteConfig());
    await post(stores, "on-main");
    commitRecords(root, "main records");

    git(root, "checkout", "-b", "feature");
    await post(stores, "on-feature");
    commitRecords(root, "feature records");
    expect(await summaries(stores)).toEqual(["on-feature", "on-main"]);

    // A separate connection to the same database — what the manager gets
    // in production (WAL: readers see committed writes across handles).
    const mgr = new RecordSyncManager(
      openDatabase(twiningDir),
      twiningDir,
      root,
      0, // no TTL — probe on every call
    );

    git(root, "checkout", "main"); // feature's record file leaves the worktree
    mgr.maybeResync();
    expect(await summaries(stores)).toEqual(["on-main"]);

    git(root, "checkout", "feature"); // and comes back
    mgr.maybeResync();
    expect(await summaries(stores)).toEqual(["on-feature", "on-main"]);
  });

  it("acceptance: a colleague's pushed records appear after pull + probe, no restart", async () => {
    // Bare origin, two clones — the actual multi-user topology.
    const origin = tmp("twining-sync-origin-");
    git(origin, "init", "--bare", "-b", "main");

    const alice = tmp("twining-sync-alice-");
    git(alice, "clone", path.join(origin), ".");
    initRepoContents(alice);
    git(alice, "push", "-u", "origin", "main");

    const bob = tmp("twining-sync-bob-");
    git(bob, "clone", path.join(origin), ".");

    // Bob's server is running (created BEFORE Alice's records exist).
    const bobTwining = path.join(bob, ".twining");
    fs.mkdirSync(bobTwining, { recursive: true });
    const bobStores = createStores(bobTwining, sqliteConfig());
    expect(await summaries(bobStores)).toEqual([]);

    // Alice records a finding and pushes.
    const aliceTwining = path.join(alice, ".twining");
    fs.mkdirSync(aliceTwining, { recursive: true });
    const aliceStores = createStores(aliceTwining, sqliteConfig());
    await post(aliceStores, "alice: auth tokens leak");
    commitRecords(alice, "alice records");
    git(alice, "push");

    // Bob pulls; his next tool call probes and ingests — no restart.
    git(bob, "pull");
    bobStores.recordSync!.maybeResync();
    expect(await summaries(bobStores)).toEqual(["alice: auth tokens leak"]);

    function initRepoContents(dir: string): void {
      fs.writeFileSync(path.join(dir, ".gitignore"), ".twining/twining.db*\n");
      git(dir, "add", ".gitignore");
      git(dir, "commit", "-m", "init");
    }
  });

  it("throttles probing to the TTL window", async () => {
    const root = tmp("twining-sync-ttl-");
    initRepo(root);
    const twiningDir = path.join(root, ".twining");
    fs.mkdirSync(twiningDir, { recursive: true });
    const stores = createStores(twiningDir, sqliteConfig());
    await post(stores, "on-main");
    commitRecords(root, "main records");
    git(root, "checkout", "-b", "feature");
    await post(stores, "on-feature");
    commitRecords(root, "feature records");

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const mgr = new RecordSyncManager(
      openDatabase(twiningDir),
      twiningDir,
      root,
      60_000,
    );
    mgr.maybeResync(); // consumes the window (HEAD unchanged — no work)

    git(root, "checkout", "main");
    mgr.maybeResync(); // inside the TTL window — skipped, still stale
    expect(await summaries(stores)).toEqual(["on-feature", "on-main"]);

    vi.setSystemTime(1_000_000 + 61_000);
    mgr.maybeResync(); // window expired — probes and converges
    expect(await summaries(stores)).toEqual(["on-main"]);
  });

  it("does nothing and never throws outside a git repository", async () => {
    const root = tmp("twining-sync-nogit-");
    const twiningDir = path.join(root, ".twining");
    fs.mkdirSync(twiningDir, { recursive: true });
    const mgr = new RecordSyncManager(
      openDatabase(twiningDir),
      twiningDir,
      root,
      0,
    );
    expect(() => {
      mgr.maybeResync();
      mgr.maybeResync();
    }).not.toThrow();
  });

  it("attachSyncProbe runs the probe before every registered tool callback", async () => {
    const probed: string[] = [];
    const mgr = {
      maybeResync: () => probed.push("probe"),
    } as unknown as RecordSyncManager;

    let registered: ((...a: unknown[]) => unknown) | null = null;
    const server = {
      registerTool: (
        _name: string,
        _config: unknown,
        cb: (...a: unknown[]) => unknown,
      ) => {
        registered = cb;
      },
    } as unknown as McpServer;

    attachSyncProbe(server, mgr);
    (server.registerTool as never as (...a: unknown[]) => void)(
      "twining_assemble",
      {},
      () => probed.push("tool"),
    );
    registered!();
    expect(probed).toEqual(["probe", "tool"]);
  });
});
