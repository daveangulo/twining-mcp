import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ENTRY = path.resolve(__dirname, "..", "..", "dist", "cli", "twining.js");
const PKG_VERSION = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

interface Envelope {
  ok: boolean;
  schema_version: string;
  server_version: string;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

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

beforeAll(() => {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(
      `dist/cli/twining.js missing — run \`npm run build\` before this test`,
    );
  }
});

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
