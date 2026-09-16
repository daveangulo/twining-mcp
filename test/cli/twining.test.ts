import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveWorktreeMain } from "../../src/utils/project-root.js";

// The CLI under test is bundled ONCE per suite from src/ into a cache dir under
// node_modules (so bare imports still resolve against the repo's packages) —
// the suite must not depend on a prior `npm run build`, and the main checkout
// deliberately never builds dist/ (its dist serves every session on this
// machine through the npm link). Same esbuild recipe as the plugin bundle.
const ENTRY = path.join(path.resolve(__dirname, "..", ".."), "node_modules", ".cache", "twining-cli-test", "twining.mjs");
const PKG_VERSION = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

interface Envelope {
  ok: boolean;
  schema_version: string;
  server_version: string;
  command: string | null;
  project_root?: string;
  store_dir?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/**
 * A real model cache, if this machine has one. `.twining/models/` is
 * gitignored, so this is always absent on CI and the test that needs it skips.
 * In a linked worktree the cache lives in the main checkout — the same
 * redirect the store itself follows.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
function findModelCache(): string | null {
  const roots = [REPO_ROOT, resolveWorktreeMain(REPO_ROOT)].filter(
    (r): r is string => typeof r === "string",
  );
  for (const root of roots) {
    const cache = path.join(root, ".twining", "models");
    if (
      fs.existsSync(
        path.join(cache, "Xenova", "all-MiniLM-L6-v2", "onnx", "model.onnx"),
      )
    ) {
      return cache;
    }
  }
  return null;
}
const REAL_MODEL_CACHE = findModelCache();

function run(
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  return spawnSync("node", [ENTRY, ...args], {
    input: opts.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });
}

function envelope(stdout: string): Envelope {
  const lines = stdout.trim().split("\n").filter(Boolean);
  // The contract is ONE envelope and nothing else on stdout.
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Envelope;
}

let projectRoot: string;

beforeAll(async () => {
  const { build } = await import("esbuild");
  fs.mkdirSync(path.dirname(ENTRY), { recursive: true });
  await build({
    entryPoints: [path.resolve(__dirname, "..", "..", "src", "cli", "twining.ts")],
    outfile: ENTRY,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    sourcemap: "inline",
    logLevel: "silent",
    // Same relocation-safe version injection as scripts/build-plugin-bundle.mjs:
    // src/version.ts's package.json fallback is only valid at dist/ depth.
    define: { __TWINING_VERSION__: JSON.stringify(PKG_VERSION) },
  });
}, 60_000);

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cli-"));
});

afterEach(() => {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("twining --version / --help", () => {
  it("--version prints a plain line (not an envelope) and exits 0", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`twining ${PKG_VERSION}`);
  });

  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("twining capabilities");
    expect(r.stdout).toContain("Exit codes: 0 ok, 1 command error, 2 usage");
  });
});

describe("twining capabilities", () => {
  it("lists every command with a JSON Schema and does NOT create a store", () => {
    const r = run(["capabilities", "--project", projectRoot]);
    expect(r.status).toBe(0);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("capabilities");
    expect(env.schema_version).toBe("1");
    expect(env.server_version).toBe(PKG_VERSION);

    const result = env.result as {
      commands: Array<{
        name: string;
        surface: string;
        requires_mode?: string;
        description: string;
        input_schema: { type: string; properties?: Record<string, unknown> };
      }>;
      store_dir: string;
      store_writable: boolean;
      store_exists: boolean;
    };
    expect(result.commands.length).toBeGreaterThan(30);
    expect(result.store_writable).toBe(true);
    expect(result.store_exists).toBe(false);
    expect(result.store_dir).toBe(path.join(projectRoot, ".twining"));

    const assemble = result.commands.find((c) => c.name === "twining_assemble")!;
    expect(assemble.surface).toBe("default");
    expect(assemble.input_schema.type).toBe("object");
    expect(Object.keys(assemble.input_schema.properties ?? {})).toEqual(
      expect.arrayContaining(["task", "scope", "max_tokens", "agent_id"]),
    );
    // A full-surface command is still listed — the CLI dispatches everything,
    // `surface` only reports where MCP peers would see it.
    expect(
      result.commands.find((c) => c.name === "twining_triage")!.surface,
    ).toBe("full");

    // The SECOND MCP gate (tools.mode) is reported too, and only where it
    // applies: twining_status is default-surface yet absent in a lite install.
    const status = result.commands.find((c) => c.name === "twining_status")!;
    expect(status.surface).toBe("default");
    expect(status.requires_mode).toBe("full");
    expect(
      result.commands.filter((c) => c.requires_mode === "full").map((c) => c.name),
    ).toHaveLength(7);
    // Omitted where both modes register the command.
    expect(assemble.requires_mode).toBeUndefined();

    // Listing must never initialize a store.
    expect(fs.existsSync(path.join(projectRoot, ".twining"))).toBe(false);
  });
});

describe("twining command dispatch", () => {
  it("records a session and writes the .last-record sentinel (Gate 2 from a shell)", () => {
    const r = run([
      "record",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({
        summary: "CLI round-trip",
        findings: ["a finding from the CLI"],
        scope: "src/cli/",
      }),
    ]);
    expect(r.status).toBe(0);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("twining_record");
    const result = env.result as {
      status_entry_id: string;
      findings_created: unknown[];
      scope: string;
    };
    expect(result.status_entry_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(result.findings_created).toHaveLength(1);
    expect(result.scope).toBe("src/cli/");

    const sentinel = path.join(projectRoot, ".twining", ".last-record");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(Number(fs.readFileSync(sentinel, "utf-8"))).toBeGreaterThan(0);
  });

  it("accepts the bare command name as well as the twining_ prefix", () => {
    const withPrefix = run([
      "twining_post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "prefixed" }),
    ]);
    expect(withPrefix.status).toBe(0);
    expect(envelope(withPrefix.stdout).command).toBe("twining_post");

    const bare = run([
      "post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "bare" }),
    ]);
    expect(bare.status).toBe(0);
    // The canonical name is what the envelope reports either way.
    expect(envelope(bare.stdout).command).toBe("twining_post");
  });

  it("reads the payload from stdin with --stdin", () => {
    run([
      "post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "seeded", scope: "src/cli/" }),
    ]);
    const r = run(["assemble", "--project", projectRoot, "--stdin"], {
      input: JSON.stringify({ task: "check the cli", scope: "src/cli/" }),
    });
    expect(r.status).toBe(0);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(true);
    const result = env.result as { briefing: string; scope: string };
    expect(result.scope).toBe("src/cli/");
    expect(result.briefing).toContain("seeded");
  });

  it("reads the payload from a file with --input-file", () => {
    const file = path.join(projectRoot, "input.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ entry_type: "warning", summary: "from a file" }),
    );
    const r = run(["post", "--project", projectRoot, "--input-file", file]);
    expect(r.status).toBe(0);
    expect(envelope(r.stdout).ok).toBe(true);
  });

  it("--agent-id fills agent_id when the payload omits it", () => {
    const r = run([
      "post",
      "--project",
      projectRoot,
      "--agent-id",
      "cli-lane",
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "attributed" }),
    ]);
    expect(r.status).toBe(0);
    const read = run([
      "read",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ limit: 10 }),
    ]);
    const entries = (envelope(read.stdout).result as {
      entries: Array<{ agent_id?: string; summary: string }>;
    }).entries;
    expect(entries.find((e) => e.summary === "attributed")!.agent_id).toBe(
      "cli-lane",
    );
  });

  it("keeps stdout to the envelope alone — diagnostics go to stderr", () => {
    const r = run([
      "post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "clean stdout" }),
    ]);
    expect(r.status).toBe(0);
    // envelope() already asserts exactly one stdout line; confirm it parses
    // and that nothing leaked a [twining] log line into it.
    expect(r.stdout).not.toContain("[twining]");
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });
});

describe("twining exit codes", () => {
  it("exit 0 on success", () => {
    const r = run(["status", "--project", projectRoot]);
    expect(r.status).toBe(0);
    expect(envelope(r.stdout).ok).toBe(true);
  });

  it("exit 1 when the command itself fails", () => {
    const r = run(["why", "--project", projectRoot, "--json", "{}"]);
    expect(r.status).toBe(1);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.command).toBe("twining_why");
    expect(env.error!.code).toBe("INVALID_INPUT");
  });

  it("exit 2 for an unknown command", () => {
    const r = run(["drain", "--project", projectRoot]);
    expect(r.status).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error!.code).toBe("UNKNOWN_COMMAND");
    expect(r.stderr).toContain("unknown command");
  });

  it("exit 2 for no command at all", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(envelope(r.stdout).error!.code).toBe("USAGE");
    expect(r.stderr).toContain("usage: twining");
  });

  it("exit 2 for unparseable JSON", () => {
    const r = run(["post", "--project", projectRoot, "--json", "{nope"]);
    expect(r.status).toBe(2);
    expect(envelope(r.stdout).error!.code).toBe("INVALID_JSON");
  });

  it("exit 2 for input the tool schema rejects", () => {
    const r = run([
      "post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "not_a_type", summary: "x" }),
    ]);
    expect(r.status).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error!.code).toBe("INVALID_ARGUMENTS");
    expect(env.error!.message).toContain("entry_type");
  });

  it("exit 1 with STORE_UNWRITABLE on a read-only store directory — never a silent fallback", () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cli-ro-"));
    try {
      fs.chmodSync(ro, 0o555);
      const r = run(["status", "--project", ro]);
      expect(r.status).toBe(1);
      const env = envelope(r.stdout);
      expect(env.error!.code).toBe("STORE_UNWRITABLE");
      // Names the path and the fix.
      expect(env.error!.message).toContain(path.join(ro, ".twining"));
      expect(env.error!.message).toContain("--project");
      expect(env.error!.message).toContain("TWINING_WORKTREE_LOCAL");
      // And nothing was created anywhere else.
      expect(fs.existsSync(path.join(ro, ".twining"))).toBe(false);
    } finally {
      fs.chmodSync(ro, 0o755);
      fs.rmSync(ro, { recursive: true, force: true });
    }
  });
});

describe("twining folds in the pre-2.17 subcommands", () => {
  // Both subcommands read an EXISTING store; on a bare directory migrate
  // --check still exits 2 on the pre-2.17 missing-index path, which this
  // change deliberately does not alter.
  function seedStore(): void {
    const r = run([
      "post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "seed" }),
    ]);
    expect(r.status).toBe(0);
  }

  it("validate-records keeps its own output and exit code (no envelope)", () => {
    seedStore();
    const r = run(["validate-records", "--project", projectRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("validate-records");
    expect(r.stdout).not.toContain('"schema_version"');
  });

  it("migrate --check keeps its own output and exit code (no envelope)", () => {
    seedStore();
    const r = run(["migrate", "--check", "--project", projectRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("migrate");
    expect(r.stdout).not.toContain('"schema_version"');
  });
});

describe("twining is offline-safe", () => {
  it("falls back to keyword search when the model is absent, and never attempts a download", () => {
    // The VITEST short-circuit inside Embedder would mask the offline branch,
    // so this child runs without it — and with HOME pointed at an empty dir so
    // no ambient model cache can be found either.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cli-home-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: emptyHome };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env.VITEST_POOL_ID;
    try {
      const r = run(
        [
          "post",
          "--project",
          projectRoot,
          "--json",
          JSON.stringify({ entry_type: "finding", summary: "offline embed path" }),
        ],
        { env },
      );
      expect(r.status).toBe(0);
      expect(envelope(r.stdout).ok).toBe(true);
      expect(r.stderr).toContain("using keyword search");
      expect(r.stderr).toContain("no download attempted");
      // transformers.js creates env.cacheDir on a fetch — its absence is the
      // evidence that no download was even started.
      expect(fs.existsSync(path.join(projectRoot, ".twining", "models"))).toBe(
        false,
      );
      // And it did not crash into the ONNX init failure path either.
      expect(r.stderr).not.toContain("ONNX embedding initialization failed");
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("twining reports the store it used", () => {
  it("every success envelope names project_root and store_dir, absolute", () => {
    const r = run([
      "post",
      "--project",
      projectRoot,
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "which store?" }),
    ]);
    expect(r.status).toBe(0);
    const env = envelope(r.stdout);
    // path.resolve absolutizes; it deliberately does NOT canonicalize
    // symlinks, so the reported path is the one the caller named.
    expect(env.project_root).toBe(path.resolve(projectRoot));
    expect(env.store_dir).toBe(path.join(path.resolve(projectRoot), ".twining"));
    expect(path.isAbsolute(env.project_root!)).toBe(true);
  });

  it("absolutizes a RELATIVE --project for reporting without changing resolution", () => {
    const parent = path.dirname(projectRoot);
    const leaf = path.basename(projectRoot);
    const r = run(["capabilities", "--project", `./${leaf}`], { cwd: parent });
    expect(r.status).toBe(0);
    const env = envelope(r.stdout);
    const result = env.result as { project_root: string; store_dir: string };
    expect(path.isAbsolute(result.project_root)).toBe(true);
    expect(result.project_root).not.toContain("./");
    expect(result.store_dir).toBe(path.join(result.project_root, ".twining"));
    // Resolution is unchanged: it still described the directory we named.
    expect(path.basename(result.project_root)).toBe(leaf);
  });
});

describe("twining refuses arguments it does not understand", () => {
  it("a mistyped flag is refused, NOT silently dropped into an argument-free call", () => {
    // The motivating case: an argument-free twining_archive sweeps the board.
    const r = run([
      "twining_archive",
      "--project",
      projectRoot,
      "--jsonn",
      JSON.stringify({ retain: 200 }),
    ]);
    expect(r.status).toBe(2);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("USAGE");
    expect(env.error!.message).toContain("--jsonn");
    expect(r.stderr).toContain("--jsonn");
    // Nothing ran: no store was even created.
    expect(fs.existsSync(path.join(projectRoot, ".twining"))).toBe(false);
  });

  it("a payload passed as a bare positional argument is refused", () => {
    const r = run([
      "post",
      "--project",
      projectRoot,
      JSON.stringify({ entry_type: "finding", summary: "forgot --json" }),
    ]);
    expect(r.status).toBe(2);
    expect(envelope(r.stdout).error!.code).toBe("USAGE");
    expect(envelope(r.stdout).error!.message).toContain("--json");
  });

  it("a flag VALUE may start with a dash", () => {
    const r = run([
      "post",
      "--project",
      projectRoot,
      "--agent-id",
      "-weird-agent",
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "dashed agent id" }),
    ]);
    expect(r.status).toBe(0);
    expect(envelope(r.stdout).ok).toBe(true);
  });

  it("a value flag with no value is refused — a dangling --project must not fall back to the cwd store", () => {
    const r = run(["status", "--project"]);
    expect(r.status).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error!.code).toBe("USAGE");
    expect(env.error!.message).toContain("--project");
    expect(env.error!.message).toContain("needs a value");
  });

  it("capabilities refuses an unknown flag too", () => {
    const r = run(["capabilities", "--project", projectRoot, "--verbose"]);
    expect(r.status).toBe(2);
    expect(envelope(r.stdout).error!.code).toBe("USAGE");
    expect(envelope(r.stdout).error!.message).toContain("--verbose");
  });
});

describe("twining exits cleanly when the ONNX model is cached", () => {
  // Regression guard for the 134/SIGABRT blocker: process.exit() raced
  // onnxruntime-node's thread pool and aborted a call that had ALREADY
  // succeeded and written its envelope. The CLI now sets process.exitCode and
  // lets the loop drain.
  it("takes the cached-model branch (no offline fallback notice) and still exits 0", () => {
    const modelDir = path.join(
      projectRoot,
      ".twining",
      "models",
      "Xenova",
      "all-MiniLM-L6-v2",
    );
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "config.json"), "{}");

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env.VITEST_POOL_ID;

    const r = run(
      [
        "post",
        "--project",
        projectRoot,
        "--json",
        JSON.stringify({ entry_type: "finding", summary: "cached model branch" }),
      ],
      { env },
    );
    expect(r.status).toBe(0);
    const parsed = envelope(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("twining_post");
    // A cached model means the pre-check does NOT short-circuit, so the
    // offline notice must be absent — this is the branch the offline test
    // above cannot reach.
    expect(r.stderr).not.toContain("no download attempted");
  });

  it.skipIf(!REAL_MODEL_CACHE)(
    "exits 0 with a real model cache (the exact shape that aborted with 134)",
    () => {
      // Symlinked, not copied: the cache is ~87 MB.
      fs.mkdirSync(path.join(projectRoot, ".twining"), { recursive: true });
      fs.symlinkSync(REAL_MODEL_CACHE!, path.join(projectRoot, ".twining", "models"));

      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;
      delete env.VITEST_POOL_ID;

      for (let i = 0; i < 3; i++) {
        const r = run(
          [
            "post",
            "--project",
            projectRoot,
            "--json",
            JSON.stringify({ entry_type: "finding", summary: `real model ${i}` }),
          ],
          { env },
        );
        // 134 here means process.exit() is back, racing the ONNX thread pool.
        expect(r.status, `run ${i} stderr: ${r.stderr}`).toBe(0);
        expect(envelope(r.stdout).ok).toBe(true);
        expect(r.stderr).not.toContain("mutex lock failed");
      }
    },
  );
});
