/**
 * The offline switch (R18).
 *
 * `createTwiningContext` builds the embedder for BOTH front ends, so this is
 * the one place the decision can be made once. Before the foundation merge it
 * read only the caller's option, which meant the long-lived MCP server
 * (src/server.ts calls `createTwiningContext(projectRoot)` with no options)
 * ignored both the environment and the config: an operator who had said "never
 * download a model" still got a download attempt on first use.
 *
 * Three sources, OR'd, because each answers a different question:
 *   caller      — "this process must not use the network" (the CLI always does)
 *   environment — "this shell has no network" (Codex, CI sandboxes)
 *   config      — "this installation never downloads a model"
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTwiningContext, offlineFromEnvironment } from "../../src/core/context.js";
import { Embedder } from "../../src/embeddings/embedder.js";

let projectRoot: string;

/** The embedder's own view of whether it may reach the network. */
function isOffline(ctx: { embedder: Embedder }): boolean {
  return (ctx.embedder as unknown as { offline: boolean }).offline;
}

/** Flip embeddings.offline in the config init already wrote. */
function setConfigOffline(value: boolean): void {
  const file = path.join(projectRoot, ".twining", "config.yml");
  const body = fs.readFileSync(file, "utf-8");
  const next = body.replace(/^(embeddings:\n\s+offline:\s*)(true|false)$/m, `$1${String(value)}`);
  expect(next, "the init config must carry an embeddings.offline key to flip").not.toBe(body);
  fs.writeFileSync(file, next);
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-offline-"));
  Embedder.resetInstances();
  delete process.env.TWINING_OFFLINE;
});

afterEach(() => {
  delete process.env.TWINING_OFFLINE;
  Embedder.resetInstances();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("offlineFromEnvironment", () => {
  it("is true only for an explicit affirmative", () => {
    for (const v of ["1", "true", "TRUE", "yes", " Yes "]) {
      expect(offlineFromEnvironment({ TWINING_OFFLINE: v }), v).toBe(true);
    }
  });

  it("is false for absent, empty and negative values — exporting it empty is not a switch", () => {
    for (const v of ["", "0", "false", "no", "off"]) {
      expect(offlineFromEnvironment({ TWINING_OFFLINE: v }), JSON.stringify(v)).toBe(false);
    }
    expect(offlineFromEnvironment({})).toBe(false);
  });
});

describe("createTwiningContext honours every offline source", () => {
  it("defaults to online when nothing asks otherwise", () => {
    const ctx = createTwiningContext(projectRoot, { background: false });
    try {
      expect(isOffline(ctx)).toBe(false);
    } finally {
      ctx.stopBackgroundWork();
      ctx.closeDb();
    }
  });

  it("TWINING_OFFLINE=1 makes the server's own context offline", () => {
    // No options at all — exactly how src/server.ts builds it.
    process.env.TWINING_OFFLINE = "1";
    const ctx = createTwiningContext(projectRoot);
    try {
      expect(isOffline(ctx)).toBe(true);
    } finally {
      ctx.stopBackgroundWork();
      ctx.closeDb();
    }
  });

  it("config embeddings.offline: true makes it offline with no environment variable set", () => {
    // Initialize the store so config.yml exists, then flip the flag it wrote.
    const first = createTwiningContext(projectRoot, { background: false });
    first.stopBackgroundWork();
    first.closeDb();
    Embedder.resetInstances();
    setConfigOffline(true);

    expect(process.env.TWINING_OFFLINE).toBeUndefined();
    const ctx = createTwiningContext(projectRoot);
    try {
      expect(isOffline(ctx)).toBe(true);
    } finally {
      ctx.stopBackgroundWork();
      ctx.closeDb();
    }
  });

  it("the caller's option still forces offline on its own (the CLI's guarantee)", () => {
    const ctx = createTwiningContext(projectRoot, { background: false, offline: true });
    try {
      expect(isOffline(ctx)).toBe(true);
    } finally {
      ctx.stopBackgroundWork();
      ctx.closeDb();
    }
  });

  it("offline: false does NOT override an operator who asked for offline", () => {
    process.env.TWINING_OFFLINE = "1";
    const ctx = createTwiningContext(projectRoot, { background: false, offline: false });
    try {
      expect(isOffline(ctx)).toBe(true);
    } finally {
      ctx.stopBackgroundWork();
      ctx.closeDb();
    }
  });
});
