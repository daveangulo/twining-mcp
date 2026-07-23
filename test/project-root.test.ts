/**
 * Project-root resolution (#46): --project arg > TWINING_PROJECT env > cwd.
 * Lets the plugin-contributed server target a shared store via one
 * version-agnostic env line instead of a per-repo .mcp.json override plus a
 * brittle exact-command deniedMcpServers block.
 *
 * Worktree cases (blackboard finding 01KY66434W): the cwd default redirects
 * linked git worktrees to the main checkout root so cmux --worktree
 * teammates share one .twining instead of forking the store. Uses real git
 * repos in mkdtemp dirs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectRoot, resolveWorktreeMain } from "../src/utils/project-root.js";

const CWD = "/repos/wfos-registry";

describe("resolveProjectRoot", () => {
  it("defaults to cwd with no arg and no env", () => {
    expect(resolveProjectRoot([], {}, CWD)).toBe(CWD);
  });

  it("uses TWINING_PROJECT when no --project arg is given", () => {
    expect(
      resolveProjectRoot([], { TWINING_PROJECT: "/shared/wfos-chassis" }, CWD),
    ).toBe("/shared/wfos-chassis");
  });

  it("resolves a relative TWINING_PROJECT against cwd", () => {
    expect(
      resolveProjectRoot([], { TWINING_PROJECT: "../wfos-chassis" }, CWD),
    ).toBe(path.resolve(CWD, "../wfos-chassis"));
  });

  it("--project overrides TWINING_PROJECT", () => {
    expect(
      resolveProjectRoot(
        ["--project", "/explicit/path"],
        { TWINING_PROJECT: "/shared/wfos-chassis" },
        CWD,
      ),
    ).toBe("/explicit/path");
  });

  it("empty TWINING_PROJECT is ignored (falls back to cwd)", () => {
    expect(resolveProjectRoot([], { TWINING_PROJECT: "" }, CWD)).toBe(CWD);
  });

  it("--project without a following value falls back to env then cwd", () => {
    expect(
      resolveProjectRoot(
        ["--project"],
        { TWINING_PROJECT: "/shared/wfos-chassis" },
        CWD,
      ),
    ).toBe("/shared/wfos-chassis");
  });

  it("relative --project is preserved as-is (existing behavior, no regression)", () => {
    // The 1.x server passed relative --project values straight through;
    // keep that contract for arg users.
    expect(resolveProjectRoot(["--project", "."], {}, CWD)).toBe(".");
  });
});

describe("resolveProjectRoot — linked git worktrees", () => {
  let tmpDir: string;

  function git(args: string[], cwd: string): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }

  /** Create a real repo with one commit and a linked worktree beside it. */
  function makeRepoWithWorktree(): { main: string; worktree: string } {
    const main = path.join(tmpDir, "main");
    const worktree = path.join(tmpDir, "wt");
    fs.mkdirSync(main);
    git(["init"], main);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], main);
    git(["worktree", "add", worktree], main);
    return { main, worktree };
  }

  beforeEach(() => {
    // realpath: on darwin os.tmpdir() is /var/... which symlinks to
    // /private/var/... — git resolves symlinks, so match it up front.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "twining-worktree-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cwd inside a linked worktree resolves to the main checkout root", () => {
    const { main, worktree } = makeRepoWithWorktree();
    expect(resolveProjectRoot([], {}, worktree)).toBe(main);
  });

  it("explicit --project pointing at the worktree is returned verbatim", () => {
    const { worktree } = makeRepoWithWorktree();
    expect(resolveProjectRoot(["--project", worktree], {}, "/elsewhere")).toBe(
      worktree,
    );
  });

  it("TWINING_PROJECT pointing at the worktree is not redirected", () => {
    const { worktree } = makeRepoWithWorktree();
    expect(
      resolveProjectRoot([], { TWINING_PROJECT: worktree }, "/elsewhere"),
    ).toBe(path.resolve("/elsewhere", worktree));
  });

  it("TWINING_WORKTREE_LOCAL=true keeps the worktree-local cwd", () => {
    const { worktree } = makeRepoWithWorktree();
    expect(
      resolveProjectRoot([], { TWINING_WORKTREE_LOCAL: "true" }, worktree),
    ).toBe(worktree);
  });

  it("submodule-style .git file does not redirect", () => {
    const sub = path.join(tmpDir, "parent", "sub");
    fs.mkdirSync(path.join(tmpDir, "parent", ".git", "modules", "sub"), {
      recursive: true,
    });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(resolveProjectRoot([], {}, sub)).toBe(sub);
    expect(resolveWorktreeMain(sub)).toBeNull();
  });

  it("relative gitdir in the .git file resolves against the worktree dir", () => {
    const main = path.join(tmpDir, "main");
    const worktree = path.join(tmpDir, "wt");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), {
      recursive: true,
    });
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(worktree, ".git"),
      "gitdir: ../main/.git/worktrees/wt\n",
    );
    expect(resolveProjectRoot([], {}, worktree)).toBe(main);
  });

  it("garbage .git file falls back to cwd", () => {
    const dir = path.join(tmpDir, "garbage");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".git"), "not a gitdir pointer\n");
    expect(resolveProjectRoot([], {}, dir)).toBe(dir);
    expect(resolveWorktreeMain(dir)).toBeNull();
  });

  it("main root deleted after worktree creation falls back to cwd", () => {
    const { main, worktree } = makeRepoWithWorktree();
    fs.rmSync(main, { recursive: true, force: true });
    expect(resolveProjectRoot([], {}, worktree)).toBe(worktree);
  });
});
