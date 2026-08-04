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

interface RunOptions {
  /** Working directory for the spawn (the pin rung resolves against cwd). */
  cwd?: string;
  /** Alternate launcher path (for copies exercising $0-relative lookup). */
  script?: string;
}

function runScript(
  args: string[],
  envPath: string,
  extraEnv: Record<string, string> = {},
  opts: RunOptions = {},
): ScriptResult {
  // Default cwd to the per-test tempdir: the launcher's pin rung checks
  // ./node_modules/twining-mcp relative to cwd, so a repo-root cwd would let
  // a developer's local twining-mcp install (npm link, `npm i -D file:.`)
  // hijack every non-pin assertion in this file.
  const result = spawnSync("sh", [opts.script ?? SCRIPT, ...args], {
    cwd: opts.cwd ?? dir,
    env: {
      PATH: envPath,
      HOME: process.env.HOME ?? "",
      // The launcher recovers PATH by default — login-shell merge AND
      // well-known install-dir probing — either of which would escape the
      // shim-PATH sandbox (macOS /etc/profile restores the real PATH;
      // /opt/homebrew/bin exists on Homebrew hosts). Suppress ALL recovery;
      // the PATH-recovery tests below re-enable it with controlled HOME and
      // TWINING_LAUNCH_RECOVERY_DIRS.
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

/**
 * Copy of the launcher in a temp dir mimicking the plugin layout
 * (scripts/ + optional server/twining-server.mjs), so the $0-relative
 * bundle lookup resolves against a controllable sibling — and so the
 * bundle can be a stub or absent entirely.
 */
function makePluginLayout(bundleContent?: string): string {
  const layout = path.join(dir, "plugin-copy");
  fs.mkdirSync(path.join(layout, "scripts"), { recursive: true });
  const script = path.join(layout, "scripts", "launch-server.sh");
  fs.copyFileSync(SCRIPT, script);
  if (bundleContent !== undefined) {
    fs.mkdirSync(path.join(layout, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(layout, "server", "twining-server.mjs"),
      bundleContent,
    );
  }
  return script;
}

/** Temp cwd containing a project-pinned node_modules/twining-mcp install. */
function makePinCwd(): string {
  const cwd = path.join(dir, "pin-project");
  const dist = path.join(cwd, "node_modules", "twining-mcp", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "index.js"),
    'process.stdout.write("PIN-OK\\n");\n',
  );
  return cwd;
}

/**
 * Fake node executable that only answers --version with the given string —
 * lets tests simulate a node too old for the bundled server.
 */
function fakeNodeInShim(shim: string, version: string): void {
  fs.writeFileSync(
    path.join(shim, "node"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
}

describe("launch-server.sh --probe", () => {
  it("resolves runner=npx on a full inherited PATH", () => {
    const result = runScript(["--probe"], process.env.PATH ?? "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=npx node=v/);
  });

  it("resolves runner=override when TWINING_SERVER_JS is set and node works", () => {
    const stub = path.join(dir, "custom-server.js");
    fs.writeFileSync(stub, 'process.stdout.write("OVERRIDE-OK\\n");\n');
    const shim = makeShim(["sh", "node"]);
    const result = runScript(["--probe"], shim, { TWINING_SERVER_JS: stub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=override node=v/);
  });

  it("resolves runner=pin from a project-local node_modules install", () => {
    const shim = makeShim(["sh", "node"]);
    const result = runScript(["--probe"], shim, {}, { cwd: makePinCwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=pin node=v/);
  });

  it("ranks pin above a working npx in the same shim", () => {
    const shim = makeShim(["sh", "node"]);
    fs.writeFileSync(
      path.join(shim, "npx"),
      "#!/bin/sh\necho 10.0.0\nexit 0\n",
      { mode: 0o755 },
    );
    const result = runScript(["--probe"], shim, {}, { cwd: makePinCwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=pin node=v/);
  });

  it("resolves runner=bundled when only sh+node exist (real bundle ships with the plugin)", () => {
    // Shim dir has no npx / npm tree / twining-mcp, so rungs 1-3 cannot
    // fire; the real launcher finds the real bundle via $0.
    const shim = makeShim(["sh", "node"]);
    const result = runScript(["--probe"], shim);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=bundled node=v\d+\.\d+\.\d+\n$/);
  });

  it("resolves runner=bundled through the $0-relative lookup in a copied plugin layout", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const shim = makeShim(["sh", "node"]);
    const result = runScript(["--probe"], shim, {}, { script });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=bundled node=v/);
  });

  it("resolves runner=none with real node version when the bundle is absent (copied layout without server/)", () => {
    const script = makePluginLayout(); // no server/ sibling
    const shim = makeShim(["sh", "node"]);
    const result = runScript(["--probe"], shim, {}, { script });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=none node=v\d+\.\d+\.\d+\n$/);
  });

  it("ranks global above bundled — bundled is only reached when rungs 1-3 are absent", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const shim = makeShim(["sh", "node"]);
    fs.writeFileSync(
      path.join(shim, "twining-mcp"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const result = runScript(["--probe"], shim, {}, { script });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=global node=v/);
  });

  it("ranks npx above bundled", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const shim = makeShim(["sh", "node"]);
    fs.writeFileSync(
      path.join(shim, "npx"),
      "#!/bin/sh\necho 10.0.0\nexit 0\n",
      { mode: 0o755 },
    );
    const result = runScript(["--probe"], shim, {}, { script });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=npx node=v/);
  });

  it("skips the bundled rung when node is older than 22 (runner=none)", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const shim = makeShim(["sh"]);
    fakeNodeInShim(shim, "v18.19.0");
    const result = runScript(["--probe"], shim, {}, { script });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("runner=none node=v18.19.0\n");
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
      /^runner=(override|pin|npx|npm-prefix|global|bundled|none) node=\S+\n$/,
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

  it("exits 127 with the npm-less-distro hint when node exists but nothing else and the bundle is absent", () => {
    // Copied layout without server/ — with the real launcher the bundled
    // rung would fire here instead.
    const script = makePluginLayout();
    const shim = makeShim(["sh", "node"]);
    const result = runScript([], shim, {}, { script });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe(""); // stdout purity
    expect(result.stderr).toContain("npm");
    expect(result.stderr).toContain("apt install nodejs");
    expect(result.stderr).toContain("restart Claude Code");
  });

  it("exits 127 naming the found version and the >= 22.13 requirement when node is too old for the bundle", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const shim = makeShim(["sh"]);
    fakeNodeInShim(shim, "v18.19.0");
    const result = runScript([], shim, {}, { script });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe(""); // stdout purity
    expect(result.stderr).toContain("v18.19.0");
    expect(result.stderr).toContain(">= 22.13");
  });

  it("execs the bundled server with pure stdout and a one-line stderr notice", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const shim = makeShim(["sh", "node"]);
    const result = runScript([], shim, {}, { script });
    expect(result.exitCode).toBe(0);
    // Exactly the stub bundle's output — the launcher wrote nothing to stdout.
    expect(result.stdout).toBe("BUNDLED-OK\n");
    expect(result.stderr).toContain("plugin-bundled server");
    expect(result.stderr).toContain("keyword-fallback");
  });

  it("execs the TWINING_SERVER_JS override, passing its stdout through untouched", () => {
    const stub = path.join(dir, "custom-server.js");
    fs.writeFileSync(stub, 'process.stdout.write("OVERRIDE-OK\\n");\n');
    const shim = makeShim(["sh", "node"]);
    const result = runScript([], shim, { TWINING_SERVER_JS: stub });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OVERRIDE-OK\n");
  });

  it("execs a project-pinned server, passing its stdout through untouched", () => {
    const shim = makeShim(["sh", "node"]);
    const result = runScript([], shim, {}, { cwd: makePinCwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("PIN-OK\n");
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

/**
 * Regression: a registry that refuses the package (npm's minimumReleaseAge, a
 * proxy, auth, or being offline) lets `npx --version` succeed — so the launcher
 * commits to the npx rung — and then kills the launch. These rungs used to
 * `exec`, replacing the shell, so the dependency-free bundled server one rung
 * below was never reached. A field project lost Twining entirely this way while
 * `--probe` reported runner=npx.
 */
describe("launch-server.sh network-rung fallback", () => {
  /** npx that answers --version but fails any real install, like a blocked registry. */
  function brokenFetchNpx(shim: string): void {
    fs.writeFileSync(
      path.join(shim, "npx"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10.9.0; exit 0; fi\n' +
        'echo "npm error code E403" >&2\nexit 1\n',
      { mode: 0o755 },
    );
  }

  it("still reports runner=npx from --probe — the probe cannot see a fetch failure", () => {
    const shim = makeShim(["sh", "node"]);
    brokenFetchNpx(shim);
    const result = runScript(["--probe"], shim);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=npx /);
  });

  it("falls back to the bundled server when npx cannot fetch the package", () => {
    const shim = makeShim(["sh", "node"]);
    brokenFetchNpx(shim);
    const script = makePluginLayout('process.stdout.write("BUNDLE-OK\\n");\n');
    const result = runScript([], shim, {}, { script });

    expect(result.stdout).toBe("BUNDLE-OK\n"); // stdout purity preserved
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("without serving");
    expect(result.stderr).toContain("Falling back");
  });

  it("does NOT restart a server that ran and then failed — its handshake is spent", () => {
    const shim = makeShim(["sh", "node"]);
    brokenFetchNpx(shim);
    const script = makePluginLayout('process.stdout.write("BUNDLE-OK\\n");\n');
    // Grace 0 makes every failure look like it happened after serving, which is
    // the case that must NOT silently hand a fresh server a used stdin.
    const result = runScript([], shim, { TWINING_LAUNCH_RUNG_GRACE: "0" }, { script });

    expect(result.exitCode).toBe(1); // npx's own code, surfaced
    expect(result.stdout).toBe(""); // the bundle never ran
  });

  it("surfaces the failure when npx fails and no bundle exists", () => {
    const shim = makeShim(["sh", "node"]);
    brokenFetchNpx(shim);
    const script = makePluginLayout(); // no bundle
    const result = runScript([], shim, {}, { script });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("npm error");
  });
});

/**
 * Regression: login-PATH recovery used to REPLACE the inherited PATH with the
 * login-shell PATH. Two field failure modes follow: a ~/.profile that assigns
 * PATH without a `$PATH` passthrough clobbers a workable inherited PATH, and a
 * node that only enters PATH via the interactive rc (~/.zshrc adding
 * ~/.local/bin) is invisible to `sh -lc`, so recovery yields a PATH with no
 * node at all and the launcher dies at rung 5 ("Node.js was not found on
 * PATH") even though node was resolvable the whole time.
 */
describe("launch-server.sh PATH recovery", () => {
  /** Temp HOME whose .profile assigns PATH with no $PATH passthrough. */
  function makeHome(profilePath: string): string {
    const home = path.join(dir, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".profile"), `PATH=${profilePath}\n`);
    return home;
  }

  it("merges the login PATH with the inherited PATH instead of replacing it", () => {
    // Inherited PATH has node; the login shell's .profile clobbers PATH with
    // a node-less value and no $PATH passthrough. Recovery must not lose the
    // inherited node. Recovery dirs point at a nonexistent dir so only the
    // merge can save it.
    const shim = makeShim(["sh", "node"]);
    const home = makeHome("/nowhere-login");
    const result = runScript(["--probe"], shim, {
      TWINING_LAUNCH_NO_LOGIN_PATH: "",
      TWINING_LAUNCH_RECOVERY_DIRS: path.join(dir, "absent"),
      HOME: home,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("node=none");
    expect(result.stdout).toMatch(/^runner=bundled node=v\d+/);
  });

  it("uses login-PATH entries the inherited PATH lacks — the login PATH must actually contribute", () => {
    // Inherited PATH has no node; ~/.profile points at a custom dir (NOT in
    // the well-known recovery list) that holds node. Merging must surface
    // it. Catches a regression where LOGIN_PATH is computed but never
    // merged into PATH.
    const shim = makeShim(["sh"]);
    const customBin = path.join(dir, "custom-bin");
    fs.mkdirSync(customBin);
    fs.symlinkSync(realPathOf("node"), path.join(customBin, "node"));
    const home = makeHome(customBin);
    const result = runScript(["--probe"], shim, {
      TWINING_LAUNCH_NO_LOGIN_PATH: "",
      TWINING_LAUNCH_RECOVERY_DIRS: path.join(dir, "absent"),
      HOME: home,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=bundled node=v\d+/);
  });

  it("resolves through the login PATH ahead of the inherited PATH (continuity with the replace-era ordering)", () => {
    // Both PATHs hold a node; the login one must win, so that every setup
    // that worked under the old replace semantics picks the same node.
    const shim = makeShim(["sh"]);
    fakeNodeInShim(shim, "v22.90.0");
    const loginBin = path.join(dir, "login-bin");
    fs.mkdirSync(loginBin);
    fakeNodeInShim(loginBin, "v22.91.0");
    const home = makeHome(loginBin);
    const result = runScript(["--probe"], shim, {
      TWINING_LAUNCH_NO_LOGIN_PATH: "",
      TWINING_LAUNCH_RECOVERY_DIRS: path.join(dir, "absent"),
      HOME: home,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("runner=bundled node=v22.91.0\n");
  });

  it("recovers node from a well-known install dir the login shell never adds", () => {
    // The field case: node lives only in ~/.local/bin (added by ~/.zshrc,
    // which sh -lc never reads), Claude Code spawns with a minimal PATH, and
    // .profile has no passthrough. Recovery must probe well-known dirs.
    const shim = makeShim(["sh"]); // no node inherited
    const home = makeHome("/nowhere-login");
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(realPathOf("node"), path.join(localBin, "node"));
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const result = runScript(
      ["--probe"],
      shim,
      {
        TWINING_LAUNCH_NO_LOGIN_PATH: "",
        TWINING_LAUNCH_RECOVERY_DIRS: localBin,
        HOME: home,
      },
      { script },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^runner=bundled node=v\d+/);
  });

  it("launches the bundled server instead of exiting 127 when node is only in a well-known dir", () => {
    // Launch-mode replay of the 2026-08-04 13:50 field log: before the fix
    // this exited 127 with "Node.js was not found on PATH".
    const shim = makeShim(["sh"]);
    const home = makeHome("/nowhere-login");
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(realPathOf("node"), path.join(localBin, "node"));
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const result = runScript(
      [],
      shim,
      {
        TWINING_LAUNCH_NO_LOGIN_PATH: "",
        TWINING_LAUNCH_RECOVERY_DIRS: localBin,
        HOME: home,
      },
      { script },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("BUNDLED-OK\n");
    expect(result.stderr).not.toContain("Node.js was not found");
  });
});

/**
 * Regression: Claude Code expands plugin config strings BEFORE sh sees them,
 * through two documented mechanisms that compose badly
 * (https://code.claude.com/docs/en/mcp.md): plugin configs substitute bare
 * ${CLAUDE_PLUGIN_ROOT} DIRECTLY — it is not an environment variable at
 * expansion time — while ${VAR:-default} forms go through general env
 * expansion, where the absent CLAUDE_PLUGIN_ROOT correctly yields the
 * default. So on plugin 1.24.0 (field, 2026-08-04) the guard's `[ -z
 * "${CLAUDE_PLUGIN_ROOT:-}" ]` became `[ -z "" ]` and exited 78 on every
 * session, in the same string where the exec's bare form substituted to the
 * full path. Only the bare form is safe in plugin .mcp.json.
 */
describe("plugin/.mcp.json launch command", () => {
  const MCP_JSON = path.resolve(__dirname, "..", "..", "plugin", ".mcp.json");

  function launchCommand(): { command: string; shellArg: string } {
    const config = JSON.parse(fs.readFileSync(MCP_JSON, "utf8"));
    const server = config.mcpServers.twining;
    expect(server.command).toBe("sh");
    expect(server.args[0]).toBe("-c");
    return { command: server.command, shellArg: server.args[1] };
  }

  /**
   * Model of Claude Code's plugin-config expansion, per docs + field
   * observation: bare ${CLAUDE_PLUGIN_ROOT} is substituted directly;
   * ${VAR:-default} yields the default (CLAUDE_PLUGIN_ROOT is not an env
   * var at expansion time); other bare ${VAR} forms are left literal.
   */
  function interpolateLikeClaudeCode(cmd: string, pluginRoot: string): string {
    return cmd.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
      (match, name, defaultPart, defaultText) => {
        if (name === "CLAUDE_PLUGIN_ROOT" && defaultPart === undefined) {
          return pluginRoot;
        }
        return defaultPart === undefined ? match : (defaultText ?? "");
      },
    );
  }

  it("uses only the bare ${CLAUDE_PLUGIN_ROOT} form the interpolator understands", () => {
    const raw = fs.readFileSync(MCP_JSON, "utf8");
    const expansions = raw.match(/\$\{[^}]*\}/g) ?? [];
    expect(expansions.length).toBeGreaterThan(0);
    for (const expansion of expansions) {
      expect(expansion).toBe("${CLAUDE_PLUGIN_ROOT}");
    }
  });

  it("reaches the launcher when Claude Code interpolates the command", () => {
    const script = makePluginLayout('process.stdout.write("BUNDLED-OK\\n");\n');
    const pluginRoot = path.dirname(path.dirname(script));
    const { shellArg } = launchCommand();
    const shim = makeShim(["sh", "node"]);
    const result = spawnSync(
      "sh",
      ["-c", interpolateLikeClaudeCode(shellArg, pluginRoot)],
      {
        cwd: dir, // pin-rung isolation, same as runScript's default
        env: {
          PATH: shim,
          HOME: process.env.HOME ?? "",
          TWINING_LAUNCH_NO_LOGIN_PATH: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.stderr).not.toContain("CLAUDE_PLUGIN_ROOT is unset");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("BUNDLED-OK\n");
  });

  it("still exits 78 with the named diagnostic outside a plugin context", () => {
    // Uninterpolated command (Claude Code never saw it — e.g. copied into a
    // project .mcp.json) with no CLAUDE_PLUGIN_ROOT in the environment: sh
    // expands the unset variable to empty and the guard must name the cause.
    const { shellArg } = launchCommand();
    const shim = makeShim(["sh"]);
    const result = spawnSync("sh", ["-c", shellArg], {
      cwd: dir, // pin-rung isolation, same as runScript's default
      env: { PATH: shim, HOME: process.env.HOME ?? "" },
      encoding: "utf8",
    });
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CLAUDE_PLUGIN_ROOT is unset");
  });
});
