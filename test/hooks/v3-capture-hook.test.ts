/**
 * The bash shim, end to end: host JSON on stdin → shell script → CLI →
 * EventStore → host JSON on stdout.
 *
 * The adapter unit tests prove the CONTENT is right; this file proves the
 * WIRING is right, which is the part that has historically broken. Every
 * assertion here is about the boundary: does the script find the store, does
 * it find the CLI, does it pass the session through, does it stay silent and
 * exit 0 when anything is missing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundleCli } from "../cli/bundle-cli.js";
import { ensureStoreDescriptor } from "../../src/adapters/identity.js";
import { openRuntime } from "../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../src/contracts/index.js";

const HOOK = path.resolve(__dirname, "..", "..", "plugin", "hooks", "v3-capture-hook.sh");

let cliBundle: string;
let root: string;
let projectRoot: string;
let twiningDir: string;
let identityHome: string;

beforeAll(async () => {
  cliBundle = await bundleCli();
}, 120_000);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twining-v3hook-")));
  projectRoot = path.join(root, "project");
  twiningDir = path.join(projectRoot, ".twining");
  identityHome = path.join(root, "identity");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(identityHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  /* the bundle is cached under node_modules/.cache and is reused across suites */
});

function enableV3(): void {
  ensureStoreDescriptor(twiningDir, { format: STORE_FORMAT_VERSION });
}

function runShim(
  args: string[],
  stdin: string,
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [HOOK, ...args], {
    cwd: projectRoot,
    input: stdin,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TWINING_IDENTITY_HOME: identityHome,
      TWINING_CLI_JS: cliBundle,
      // The launcher's login-shell PATH merge is exercised by its own probe
      // test; here it would only add a shell spawn per invocation.
      TWINING_CLI_NO_PATH_RECOVERY: "1",
      ...extraEnv,
    },
    shell: false,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("the shim is invisible until the store is v3", () => {
  it("prints nothing and exits 0 when there is no store.json at all", () => {
    const r = runShim(["claude-code", "SessionStart"], JSON.stringify({ session_id: "s", source: "startup", cwd: projectRoot }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    // No events directory is created either — a 2.x store is left untouched.
    expect(fs.existsSync(path.join(twiningDir, "events"))).toBe(false);
  });

  it("prints nothing when store.json says format 2", () => {
    fs.writeFileSync(path.join(twiningDir, "store.json"), JSON.stringify({ store_id: "s_x", repo_ids: [], format: 2 }));
    const r = runShim(["claude-code", "SessionStart"], JSON.stringify({ session_id: "s", source: "startup", cwd: projectRoot }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 0 with TWINING_DISABLED=true even on a v3 store", () => {
    enableV3();
    const r = runShim(
      ["claude-code", "SessionStart"],
      JSON.stringify({ session_id: "s", source: "startup", cwd: projectRoot }),
      { TWINING_DISABLED: "true" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("capture through the shim", () => {
  it("UserPromptSubmit stores the literal prompt as an event", async () => {
    enableV3();
    const prompt = "make the reset token TTL configurable";
    const r = runShim(
      ["claude-code", "UserPromptSubmit"],
      JSON.stringify({ session_id: "sess-shim", prompt_id: "turn-1", prompt, cwd: projectRoot }),
    );
    expect(r.status).toBe(0);

    const runtime = openRuntime({
      projectRoot,
      env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
    });
    try {
      await runtime.store!.admit();
      const events = await runtime.store!.events({});
      const statement = events.find((e) => e.evidence_class === "human_statement");
      expect(statement, "the shim must have captured the prompt").toBeTruthy();
      expect((statement!.payload as Record<string, unknown>).detail).toBe(prompt);
      // The session the HOST gave the hook is what reaches the producer —
      // forwarded by the script as an env var, not invented by the CLI.
      expect(statement!.producer.session).toBe("sess-shim");
      expect(statement!.producer.turn).toBe("turn-1");
    } finally {
      runtime.close();
    }
  }, 60_000);

  it("SessionStart emits valid host JSON on stdout and nothing else", async () => {
    enableV3();
    // Seed something worth injecting.
    const seed = openRuntime({ projectRoot, env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome } });
    await seed.append({
      kind: "created",
      recordType: "decision",
      evidenceClass: "proposal",
      payload: { summary: "KRYPTON-9 retry budget is three attempts", rationale: "seeded" },
      ingress: "cli",
    });
    await seed.store!.admit();
    await seed.store!.project();
    seed.close();

    const r = runShim(
      ["claude-code", "SessionStart"],
      JSON.stringify({ session_id: "sess-inject", source: "startup", cwd: projectRoot }),
    );
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines, "stdout must carry exactly one JSON document").toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain("KRYPTON-9 retry budget");
    // The CLI envelope must NOT appear on this channel.
    expect(r.stdout).not.toContain('"schema_version"');
  }, 60_000);

  it("the receipt's payload hash equals a hash of the bytes printed on stdout", async () => {
    enableV3();
    const seed = openRuntime({ projectRoot, env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome } });
    await seed.append({
      kind: "created",
      recordType: "decision",
      evidenceClass: "proposal",
      payload: { summary: "receipts are proved against delivered bytes", rationale: "seeded" },
      ingress: "cli",
    });
    await seed.store!.admit();
    await seed.store!.project();
    seed.close();

    const r = runShim(
      ["claude-code", "SessionStart"],
      JSON.stringify({ session_id: "sess-hash", source: "startup", cwd: projectRoot }),
    );
    const delivered: string = JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;

    const runtime = openRuntime({ projectRoot, env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome } });
    try {
      await runtime.store!.admit();
      const receipts = (await runtime.store!.events({ kinds: ["receipt"] })).filter(
        (e) => (e.payload as Record<string, unknown>).stage === "injected",
      );
      expect(receipts.length).toBeGreaterThan(0);
      const hashes = receipts.map((e) => (e.payload as Record<string, unknown>).payload_hash);
      const { createHash } = await import("node:crypto");
      const expected = `sha256:${createHash("sha256").update(Buffer.from(delivered, "utf-8")).digest("hex")}`;
      // The proof C06 A15 / C15 C1 actually want: the receipt is over the bytes
      // the HOST received, captured here from the hook's own stdout.
      expect(hashes).toContain(expected);
    } finally {
      runtime.close();
    }
  }, 60_000);

  it("PreCompact captures and prints nothing (the host discards its output)", async () => {
    enableV3();
    const r = runShim(
      ["claude-code", "PreCompact"],
      JSON.stringify({ session_id: "sess-pc", trigger: "auto", cwd: projectRoot }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    // The honest note reaches stderr (the host's debug log), never the model.
    expect(r.stderr).toMatch(/cannot inject/i);
  }, 60_000);
});

describe("failure modes never break the turn", () => {
  it("an unresolvable CLI is silent and exits 0", () => {
    enableV3();
    // A PATH that still has the shell utilities the script itself needs, but
    // no node, npx or twining — so the failure under test is precisely "the
    // CLI could not be resolved", not "the script could not run at all".
    const bin = path.join(root, "bin-no-node");
    fs.mkdirSync(bin, { recursive: true });
    for (const tool of ["cat", "grep", "dirname", "sh", "bash"]) {
      const real = spawnSync("/usr/bin/which", [tool], { encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(bin, tool));
    }
    const r = spawnSync("/bin/bash", [HOOK, "claude-code", "SessionStart"], {
      cwd: projectRoot,
      input: JSON.stringify({ session_id: "s", source: "startup", cwd: projectRoot }),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: bin,
        HOME: root,
        TWINING_IDENTITY_HOME: identityHome,
        TWINING_CLI_JS: path.join(root, "does-not-exist.mjs"),
        TWINING_CLI_NO_PATH_RECOVERY: "1",
      },
    });
    expect(spawnSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: bin } }).status).not.toBe(0);
    expect(r.status ?? -1).toBe(0);
    expect(r.stdout ?? "").toBe("");
  });

  it("garbage on stdin exits 0 and says why on stderr only", () => {
    enableV3();
    const r = runShim(["claude-code", "SessionStart"], "{not json");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/could not parse/i);
  }, 60_000);

  it("a missing event name exits 0 without invoking anything", () => {
    enableV3();
    const r = runShim(["claude-code"], JSON.stringify({ session_id: "s" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("launch-cli.sh probe contract", () => {
  const LAUNCHER = path.resolve(__dirname, "..", "..", "plugin", "scripts", "launch-cli.sh");

  it("prints exactly one runner=… node=… line and exits 0", () => {
    const r = spawnSync("/bin/sh", [LAUNCHER, "--probe"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, TWINING_CLI_NO_PATH_RECOVERY: "1", TWINING_CLI_JS: cliBundle },
    });
    expect(r.status).toBe(0);
    const lines = (r.stdout ?? "").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^runner=(override|pin|bundled|global|npx|none) node=(v[0-9.]+|none)$/);
  });

  it("reports runner=none — not an error — when nothing is resolvable", () => {
    // The launcher uses only POSIX shell builtins, so it runs correctly even
    // with an empty PATH — which is exactly the situation it has to survive.
    const r = spawnSync("/bin/sh", [LAUNCHER, "--probe"], {
      encoding: "utf8",
      cwd: root,
      env: { PATH: "/nonexistent", HOME: root, TWINING_CLI_NO_PATH_RECOVERY: "1" },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? "").trim()).toBe("runner=none node=none");
  });
});
