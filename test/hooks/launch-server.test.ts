// test/hooks/launch-server.test.ts
//
// Tests for plugin/scripts/launch-server.sh — the rung-cascading launcher
// behind plugin/.mcp.json. Uses the established shim-PATH pattern (see
// session-start-context.test.ts): symlink real binaries into a temp shim
// dir and spawn with PATH=shimdir to simulate constrained environments.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "plugin",
  "scripts",
  "launch-server.sh",
);

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(
  args: string[],
  envPath: string,
  extraEnv: Record<string, string> = {},
): ScriptResult {
  const result = spawnSync("sh", [SCRIPT, ...args], {
    env: {
      PATH: envPath,
      HOME: process.env.HOME ?? "",
      // The launcher recovers the login-shell PATH by default, which would
      // escape the shim-PATH sandbox (macOS /etc/profile restores the real
      // PATH). Suppress it; the login-PATH test below re-enables it.
      TWINING_LAUNCH_NO_LOGIN_PATH: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function realPathOf(util: string): string {
  // node's own binary is known without a PATH lookup — and command -v could
  // return a version-manager shim that breaks under a restricted PATH.
  if (util === "node") return process.execPath;
  return spawnSync("sh", ["-c", `command -v ${util}`], { encoding: "utf8" })
    .stdout.trim();
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-launch-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Shim dir holding symlinks to only the named real binaries. */
function makeShim(utils: string[]): string {
  const shim = path.join(dir, "shim-bin");
  fs.mkdirSync(shim);
  for (const util of utils) {
    fs.symlinkSync(realPathOf(util), path.join(shim, util));
  }
  return shim;
}

describe("launch-server.sh --probe", () => {
  it("resolves runner=npx on a full inherited PATH", () => {
    const result = runScript(["--probe"], process.env.PATH ?? "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=npx node=v/);
  });

  it("resolves runner=none with real node version when only sh+node exist", () => {
    // Shim dir has no ../lib/node_modules tree, so the npm-prefix rung
    // must not fire; npx and twining-mcp are absent.
    const shim = makeShim(["sh", "node"]);
    const result = runScript(["--probe"], shim);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=none node=v\d+\.\d+\.\d+\n$/);
  });

  it("resolves runner=npm-prefix from a <prefix>/bin + <prefix>/lib/node_modules layout", () => {
    const prefix = path.join(dir, "prefix");
    const binDir = path.join(prefix, "bin");
    const npmBinDir = path.join(prefix, "lib", "node_modules", "npm", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(npmBinDir, { recursive: true });
    fs.symlinkSync(realPathOf("node"), path.join(binDir, "node"));
    fs.symlinkSync(realPathOf("sh"), path.join(binDir, "sh"));
    fs.writeFileSync(path.join(npmBinDir, "npx-cli.js"), "process.exit(0)\n");
    const result = runScript(["--probe"], binDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=npm-prefix node=v/);
  });

  it("resolves runner=global when a twining-mcp executable and node are on PATH", () => {
    // Plain shim (no lib/ tree) so the higher-ranked npm-prefix rung
    // cannot fire and the global rung is reached.
    const shim = makeShim(["sh", "node"]);
    fs.writeFileSync(
      path.join(shim, "twining-mcp"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const result = runScript(["--probe"], shim);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=global node=v/);
  });

  it("resolves runner=none node=none on an empty shim (sh only)", () => {
    const shim = makeShim(["sh"]);
    const result = runScript(["--probe"], shim);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("runner=none node=none\n");
  });

  it("confines login-profile stdout noise during login-PATH recovery", () => {
    // With recovery enabled, a ~/.profile that echoes to stdout must not
    // leak into the probe output (in launch mode the same leak would
    // corrupt the MCP JSON-RPC stream).
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, ".profile"), 'echo "welcome from profile"\n');
    const result = runScript(["--probe"], process.env.PATH ?? "", {
      TWINING_LAUNCH_NO_LOGIN_PATH: "",
      HOME: home,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("welcome");
    expect(result.stdout).toMatch(
      /^runner=(npx|npm-prefix|global|none) node=\S+\n$/,
    );
  });
});

describe("launch-server.sh launch mode", () => {
  it("exits 127 with node-install diagnostics on stderr and NOTHING on stdout when PATH is empty", () => {
    const shim = makeShim(["sh"]);
    const result = runScript([], shim);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe(""); // stdout purity: MCP protocol channel
    expect(result.stderr).toContain("Node.js");
    expect(result.stderr).toContain("restart Claude Code");
  });

  it("exits 127 with the npm-less-distro hint when node exists but nothing else", () => {
    const shim = makeShim(["sh", "node"]);
    const result = runScript([], shim);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe(""); // stdout purity
    expect(result.stderr).toContain("npm");
    expect(result.stderr).toContain("apt install nodejs");
    expect(result.stderr).toContain("restart Claude Code");
  });

  it("execs a global twining-mcp, passing its stdout through untouched", () => {
    const shim = makeShim(["sh", "node"]);
    fs.writeFileSync(
      path.join(shim, "twining-mcp"),
      "#!/bin/sh\necho LAUNCHED\nexit 0\n",
      { mode: 0o755 },
    );
    const result = runScript([], shim);
    expect(result.exitCode).toBe(0);
    // Exactly the fake server's output — the launcher added nothing.
    expect(result.stdout).toBe("LAUNCHED\n");
  });
});
