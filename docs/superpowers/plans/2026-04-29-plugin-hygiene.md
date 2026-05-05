# Plugin Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship plugin patch covering issues #8 (SessionStart resume crash), #9 (CLAUDE.md re-stomping), #10 (`TWINING_DISABLED` env var) as one coordinated release.

**Architecture:** Bash hook scripts gain a uniform `TWINING_DISABLED` early-exit; the SessionStart prompt-type hook becomes a command-type hook emitting `additionalContext`; `ensure-claude-md-gates.sh` broadens marker search across 4 locations and adds an opt-out flag; `src/index.ts` exits cleanly before tool registration when disabled. No data-shape changes.

**Tech Stack:** TypeScript / Node.js (MCP server), bash (hooks), Vitest (testing), `child_process.spawnSync` for shell-script integration tests.

**Spec:** `docs/superpowers/specs/2026-04-29-plugin-hygiene-design.md`

---

## File Structure

**Created:**
- `plugin/hooks/session-start-context.sh` — emits `additionalContext` JSON envelope; replaces the prompt-type SessionStart entry from `hooks.json`. Single responsibility: print one JSON line at session start (including resume), gated by `TWINING_DISABLED`.
- `test/hooks/run-hook.ts` — small shared test helper that spawns a hook script with controlled env + stdin and returns `{ exitCode, stdout, stderr }`. Used by every hook test.
- `test/hooks/session-start-context.test.ts`
- `test/hooks/ensure-claude-md-gates.test.ts`
- `test/hooks/pre-commit-hook.test.ts`
- `test/hooks/stop-hook.test.ts`
- `test/hooks/subagent-stop-hook.test.ts`
- `test/server-startup.test.ts` — tests the `TWINING_DISABLED` gate in `src/index.ts`.

**Modified:**
- `plugin/hooks/hooks.json` — replace the `prompt`-type SessionStart entry with a `command`-type entry pointing at `session-start-context.sh`.
- `plugin/hooks/ensure-claude-md-gates.sh` — add `TWINING_DISABLED` guard; add `.no-claude-md-gates` flag check; broaden marker search to 4 paths.
- `plugin/hooks/pre-commit-hook.sh` — add `TWINING_DISABLED` guard.
- `plugin/hooks/stop-hook.sh` — add `TWINING_DISABLED` guard.
- `plugin/hooks/subagent-stop-hook.sh` — add `TWINING_DISABLED` guard.
- `src/index.ts` — add `TWINING_DISABLED` early-exit in `main()`.
- `package.json` — version bump `1.18.0` → `1.19.0`.
- `plugin/.claude-plugin/plugin.json` — version bump `1.8.0` → `1.9.0`.
- `.claude-plugin/marketplace.json` — version bump `1.8.0` → `1.9.0` (lockstep with plugin.json).
- `CHANGELOG.md` — add entries for `1.19.0`.

---

## Phase 0 — Verification (close open assumptions before writing code)

These three tasks resolve the V1/V2/V3 verification items from the spec. They're research, not code. If any of them disconfirms an assumption, halt and update the spec before continuing.

### Task 1: V1 — verify Claude Code prompt-hook semantics on session resume

**Files:** none (research only — outcome documented in commit message)

- [ ] **Step 1: Search Claude Code hook docs**

Run: search Claude Code documentation for "SessionStart" + "prompt" hook type, and for "ToolUseContext is required for prompt hooks".

Use the `WebFetch` tool to fetch `https://docs.claude.com/en/docs/claude-code/hooks` (and any `/plugins` reference), or invoke the `claude-code-guide` agent with prompt: "Does Claude Code support `prompt`-type hooks on SessionStart for `resume` events? The reported error is `ToolUseContext is required for prompt hooks. This is a bug.` — is this an upstream limitation, and what's the recommended workaround?"

- [ ] **Step 2: Record finding**

Expected outcomes:
- **Confirmed**: prompt hooks need a tool-use context the resume flow doesn't supply → proceed with the spec design (convert to command hook).
- **Disconfirmed (prompt hooks should work on resume)**: the bug is upstream-only, but the command-hook design still works around it. Proceed with the spec design and note in the CHANGELOG that we're working around an upstream issue.
- **Different cause** (e.g., the matcher `*` is wrong for SessionStart, which uses `startup`/`resume`/`compact` subkinds): update the spec before continuing — the fix may be different.

- [ ] **Step 3: If finding contradicts the spec, halt**

If the finding indicates the design in `docs/superpowers/specs/2026-04-29-plugin-hygiene-design.md` is wrong, stop and surface to the user. Otherwise continue.

### Task 2: V2 — verify env var propagation

**Files:** none (research only)

- [ ] **Step 1: Verify `.claude/settings.json` `env` block reaches hooks and MCP servers**

Use the `claude-code-guide` agent: "Does Claude Code propagate environment variables defined in `.claude/settings.json` `env` block into (a) hook script execution, (b) MCP server stdio launch? If yes, are there any caveats?"

Alternative: check the Claude Code docs for `settings.json` env precedence rules.

- [ ] **Step 2: Smoke test (only if docs are unclear)**

Create a temp project with `.claude/settings.json` containing `{"env": {"TWINING_TEST_VAR": "hello"}}`. Add a no-op hook that runs `env | grep TWINING_TEST_VAR > /tmp/twining-env-check.log`. Launch Claude Code, verify the file contains the var.

- [ ] **Step 3: If propagation doesn't work the way the spec assumes, surface and halt**

The spec design depends on the env var reaching hooks and the MCP server. If only one of those works, the design needs revision (e.g., file-flag fallback for the side that doesn't see env).

### Task 3: V3 — verify MCP server can early-exit cleanly

**Files:** read-only access to `src/index.ts`, `src/server.ts`

- [ ] **Step 1: Read `src/index.ts` startup path**

Run: `cat src/index.ts`

Confirm: `main()` executes `createServer()` then `await server.connect(transport)`. An early `process.exit(0)` before `createServer()` should be safe — no transport connected, no JSON-RPC violations, Claude Code sees the process exit and shows no tools.

- [ ] **Step 2: Confirm Claude Code's behavior with a quick-exiting MCP server**

If unclear, use the `claude-code-guide` agent: "If an MCP server (stdio transport) exits with status 0 immediately on startup before any JSON-RPC handshake, does Claude Code surface this as an error to the user, retry, or quietly show no tools?"

- [ ] **Step 3: If exit-without-handshake is treated as an error**

Fall back to: register a `McpServer` with no tools and connect normally. Update Task 4 below to reflect.

---

## Phase 1 — Test infrastructure

### Task 4: Create the shared hook test helper

**Files:**
- Create: `test/hooks/run-hook.ts`

- [ ] **Step 1: Write the helper**

```typescript
// test/hooks/run-hook.ts
import { spawnSync } from "node:child_process";
import path from "node:path";

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunHookOptions {
  /** Hook script filename relative to plugin/hooks/, e.g. "stop-hook.sh" */
  script: string;
  /** JSON to pipe in via stdin. Pass undefined for empty stdin. */
  stdin?: string;
  /** Extra env vars to set. PATH and HOME are inherited. */
  env?: Record<string, string>;
  /** CWD to spawn the hook from. Defaults to a tmp dir created by the caller. */
  cwd?: string;
}

const HOOK_DIR = path.resolve(__dirname, "..", "..", "plugin", "hooks");

export function runHook(opts: RunHookOptions): HookResult {
  const scriptPath = path.join(HOOK_DIR, opts.script);
  const result = spawnSync("bash", [scriptPath], {
    cwd: opts.cwd ?? process.cwd(),
    input: opts.stdin ?? "",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...opts.env },
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
```

- [ ] **Step 2: Verify the helper resolves**

Run: `npx tsc --noEmit test/hooks/run-hook.ts`
Expected: clean (no type errors).

- [ ] **Step 3: Commit**

```bash
git add test/hooks/run-hook.ts
git commit -m "test(hooks): add shared spawn helper for hook integration tests"
```

---

## Phase 2 — MCP server startup gate (#10 server side)

### Task 5: Test for MCP server `TWINING_DISABLED` gate

**Files:**
- Create: `test/server-startup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/server-startup.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ENTRY = path.resolve(__dirname, "..", "dist", "index.js");

describe("MCP server startup gate", () => {
  beforeAll(() => {
    if (!fs.existsSync(ENTRY)) {
      throw new Error(
        `dist/index.js missing — run \`npm run build\` before this test`,
      );
    }
  });

  it("exits 0 immediately when TWINING_DISABLED=true is set", () => {
    const result = spawnSync("node", [ENTRY], {
      env: { ...process.env, TWINING_DISABLED: "true" },
      input: "",
      encoding: "utf8",
      timeout: 3000,
    });
    expect(result.status).toBe(0);
    // No JSON-RPC output — server should bail before connecting transport
    expect(result.stdout.trim()).toBe("");
  });

  it("does NOT exit early when TWINING_DISABLED is unset", () => {
    const result = spawnSync("node", [ENTRY], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TWINING_DISABLED")) },
      input: "",
      encoding: "utf8",
      timeout: 1500,
    });
    // Without stdin, the stdio server hangs waiting for a JSON-RPC frame.
    // spawnSync returns when the timeout kills it: status null, signal SIGTERM.
    expect(result.status).toBe(null);
    expect(result.signal).toBe("SIGTERM");
  });

  it("does NOT exit early when TWINING_DISABLED is set to a non-true value", () => {
    const result = spawnSync("node", [ENTRY], {
      env: { ...process.env, TWINING_DISABLED: "1" },
      input: "",
      encoding: "utf8",
      timeout: 1500,
    });
    expect(result.signal).toBe("SIGTERM");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npx vitest run test/server-startup.test.ts`
Expected: FAIL on the `TWINING_DISABLED=true` case — server hangs (SIGTERM) instead of exiting 0.

### Task 6: Implement the MCP server gate

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the guard at the top of `main()`**

In `src/index.ts`, find `async function main(): Promise<void> {` and add immediately after the opening brace, before any other logic:

```typescript
async function main(): Promise<void> {
  if (process.env.TWINING_DISABLED === "true") {
    process.exit(0);
  }
  // ... existing code ...
```

The exact insertion point is the line right after `async function main(): Promise<void> {`. Do not place it inside the `--version` block above (that's outside `main`).

- [ ] **Step 2: Build and run the test**

Run: `npm run build && npx vitest run test/server-startup.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts test/server-startup.test.ts
git commit -m "feat(server): exit cleanly when TWINING_DISABLED=true (#10)"
```

---

## Phase 3 — Hook scripts: `TWINING_DISABLED` guard (#10 client side)

Each hook gets the same 2-line guard. One task per script — small, atomic commits. The guard form is:

```bash
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
```

It goes immediately after `set -euo pipefail` and before any other logic.

### Task 7: Test for `pre-commit-hook.sh` disabled-mode

**Files:**
- Create: `test/hooks/pre-commit-hook.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/hooks/pre-commit-hook.test.ts
import { describe, it, expect } from "vitest";
import { runHook } from "./run-hook";

const FAKE_HOOK_INPUT = JSON.stringify({
  command: "git commit -m 'test'",
  transcript_path: "/tmp/nonexistent-transcript.jsonl",
});

describe("pre-commit-hook.sh", () => {
  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const result = runHook({
      script: "pre-commit-hook.sh",
      stdin: FAKE_HOOK_INPUT,
      env: { TWINING_DISABLED: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("runs normally when TWINING_DISABLED is unset (no transcript = allow)", () => {
    const result = runHook({
      script: "pre-commit-hook.sh",
      stdin: FAKE_HOOK_INPUT,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(""); // missing transcript path = silent allow
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/hooks/pre-commit-hook.test.ts`
Expected: PASS on case 2 (unset behavior already correct), FAIL on case 1 — without the guard, the hook runs to completion and may produce JSON output for transcript-less commits. *Inspect the actual fail mode before proceeding* — if both cases pass without the guard for innocuous reasons (e.g., the early-exit on missing transcript already gives `exitCode 0` with empty stdout), the test won't fail meaningfully. In that case, strengthen the disabled test by setting up a fake transcript that *would* trigger a deny without the guard:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("exits 0 with no deny JSON when TWINING_DISABLED=true even with a transcript that would otherwise deny", () => {
  const tmpTranscript = path.join(os.tmpdir(), `twining-test-${Date.now()}.jsonl`);
  // A transcript with a git commit but no twining_record after — would normally deny
  fs.writeFileSync(tmpTranscript, '{"toolUse":{"name":"Bash","input":"git commit -m old"}}\n');
  const stdin = JSON.stringify({
    command: "git commit -m new",
    transcript_path: tmpTranscript,
  });
  try {
    const result = runHook({
      script: "pre-commit-hook.sh",
      stdin,
      env: { TWINING_DISABLED: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("permissionDecision");
  } finally {
    fs.unlinkSync(tmpTranscript);
  }
});
```

Use this strengthened version. Expected with no guard: FAIL (output contains `"permissionDecision":"deny"`).

### Task 8: Implement the `pre-commit-hook.sh` guard

**Files:**
- Modify: `plugin/hooks/pre-commit-hook.sh`

- [ ] **Step 1: Add the guard**

Find the line `set -euo pipefail` (line 6) and add immediately after it:

```bash
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/hooks/pre-commit-hook.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugin/hooks/pre-commit-hook.sh test/hooks/pre-commit-hook.test.ts
git commit -m "feat(hooks): TWINING_DISABLED guard in pre-commit hook (#10)"
```

### Task 9: Test for `stop-hook.sh` disabled-mode

**Files:**
- Create: `test/hooks/stop-hook.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/hooks/stop-hook.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

describe("stop-hook.sh", () => {
  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const tmpTranscript = path.join(os.tmpdir(), `twining-stop-test-${Date.now()}.jsonl`);
    // Transcript with an Edit — would normally trigger record-required check
    fs.writeFileSync(tmpTranscript, '{"toolUse":{"name":"Edit","input":{"file_path":"/tmp/x"}}}\n');
    try {
      const result = runHook({
        script: "stop-hook.sh",
        stdin: JSON.stringify({ transcript_path: tmpTranscript }),
        env: { TWINING_DISABLED: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    } finally {
      fs.unlinkSync(tmpTranscript);
    }
  });

  it("runs normally when TWINING_DISABLED is unset", () => {
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/nonexistent.jsonl" }),
    });
    expect(result.exitCode).toBe(0);
    // Existing behavior: missing transcript yields the "Session complete" approve JSON
    expect(result.stdout).toContain('"decision":"approve"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/hooks/stop-hook.test.ts`
Expected: FAIL on disabled case — without the guard, the hook may emit approve/block JSON; we want completely silent exit.

### Task 10: Implement the `stop-hook.sh` guard

**Files:**
- Modify: `plugin/hooks/stop-hook.sh`

- [ ] **Step 1: Add the guard**

Find the line `set -euo pipefail` (line 6) and add immediately after it:

```bash
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/hooks/stop-hook.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add plugin/hooks/stop-hook.sh test/hooks/stop-hook.test.ts
git commit -m "feat(hooks): TWINING_DISABLED guard in stop hook (#10)"
```

### Task 11: Test for `subagent-stop-hook.sh` disabled-mode

**Files:**
- Create: `test/hooks/subagent-stop-hook.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/hooks/subagent-stop-hook.test.ts
import { describe, it, expect } from "vitest";
import { runHook } from "./run-hook";

describe("subagent-stop-hook.sh", () => {
  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/nonexistent.jsonl" }),
      env: { TWINING_DISABLED: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("runs without error when TWINING_DISABLED is unset", () => {
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/nonexistent.jsonl" }),
    });
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/hooks/subagent-stop-hook.test.ts`
Expected: FAIL on disabled case if the hook produces any stdout currently.

### Task 12: Implement the `subagent-stop-hook.sh` guard

**Files:**
- Modify: `plugin/hooks/subagent-stop-hook.sh`

- [ ] **Step 1: Read the file to confirm where to insert**

Run: `head -10 plugin/hooks/subagent-stop-hook.sh`
Find the `set -euo pipefail` line.

- [ ] **Step 2: Add the guard immediately after `set -euo pipefail`**

```bash
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run test/hooks/subagent-stop-hook.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugin/hooks/subagent-stop-hook.sh test/hooks/subagent-stop-hook.test.ts
git commit -m "feat(hooks): TWINING_DISABLED guard in subagent-stop hook (#10)"
```

---

## Phase 4 — `ensure-claude-md-gates.sh` (#9 + #10 in one script)

### Task 13: Test for `ensure-claude-md-gates.sh` — disabled mode

**Files:**
- Create: `test/hooks/ensure-claude-md-gates.test.ts`

- [ ] **Step 1: Write the failing test, disabled-mode case only (additional cases come in Tasks 15 / 17)**

```typescript
// test/hooks/ensure-claude-md-gates.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

describe("ensure-claude-md-gates.sh", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cmd-"));
    fs.mkdirSync(path.join(tmpDir, ".twining"));
    fs.mkdirSync(path.join(tmpDir, ".git"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("TWINING_DISABLED guard", () => {
    it("does not write CLAUDE.md when TWINING_DISABLED=true", () => {
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { TWINING_DISABLED: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/hooks/ensure-claude-md-gates.test.ts`
Expected: FAIL — currently the hook writes CLAUDE.md regardless of env.

### Task 14: Implement the `TWINING_DISABLED` guard in `ensure-claude-md-gates.sh`

**Files:**
- Modify: `plugin/hooks/ensure-claude-md-gates.sh`

- [ ] **Step 1: Add guard immediately after `set -euo pipefail` (line 6)**

```bash
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
```

- [ ] **Step 2: Run the disabled-mode test to verify it passes**

Run: `npx vitest run test/hooks/ensure-claude-md-gates.test.ts`
Expected: PASS.

- [ ] **Step 3: Do NOT commit yet — Task 15 adds the opt-out flag and Task 17 adds broad search; commit them all together as the unified "#9 fix"**

### Task 15: Test for `ensure-claude-md-gates.sh` — opt-out flag

**Files:**
- Modify: `test/hooks/ensure-claude-md-gates.test.ts`

- [ ] **Step 1: Add a new `describe` block to the existing test file**

Append to the existing file, after the `TWINING_DISABLED guard` block (and before the closing `});` of the outer `describe`):

```typescript
  describe("opt-out flag", () => {
    it("skips writing when .twining/.no-claude-md-gates exists", () => {
      fs.writeFileSync(path.join(tmpDir, ".twining", ".no-claude-md-gates"), "");
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("writes CLAUDE.md when flag is absent", () => {
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8")).toContain("Twining Lifecycle Gates");
    });
  });
```

- [ ] **Step 2: Run the test to verify the new case fails**

Run: `npx vitest run test/hooks/ensure-claude-md-gates.test.ts`
Expected: FAIL on "skips writing when .twining/.no-claude-md-gates exists" — hook ignores the flag.

### Task 16: Implement the opt-out flag check in `ensure-claude-md-gates.sh`

**Files:**
- Modify: `plugin/hooks/ensure-claude-md-gates.sh`

- [ ] **Step 1: Add flag check before the marker search**

Find the line `CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"` (around line 21) and add this BEFORE it (after the project-root walk-up but before any CLAUDE.md logic):

```bash
# Opt-out flag — explicit user choice to keep this hook silent for this project
if [[ -f "$PROJECT_ROOT/.twining/.no-claude-md-gates" ]]; then
  exit 0
fi
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/hooks/ensure-claude-md-gates.test.ts`
Expected: PASS — both opt-out cases plus the disabled case.

### Task 17: Test for `ensure-claude-md-gates.sh` — broad marker search

**Files:**
- Modify: `test/hooks/ensure-claude-md-gates.test.ts`

- [ ] **Step 1: Add a `describe` block for broad search**

Append before the final `});`:

```typescript
  describe("broad marker search", () => {
    const MARKER_CONTENT = "## Coordination — Twining Lifecycle Gates\n";

    it("skips when marker is in CLAUDE.md", () => {
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), MARKER_CONTENT);
      const before = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8");
      const result = runHook({ script: "ensure-claude-md-gates.sh", cwd: tmpDir });
      expect(result.exitCode).toBe(0);
      // File unchanged
      expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8")).toBe(before);
    });

    it("skips when marker is in CLAUDE.local.md (project root)", () => {
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.local.md"), MARKER_CONTENT);
      const result = runHook({ script: "ensure-claude-md-gates.sh", cwd: tmpDir });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("skips when marker is in .claude/CLAUDE.local.md", () => {
      fs.mkdirSync(path.join(tmpDir, ".claude"));
      fs.writeFileSync(path.join(tmpDir, ".claude", "CLAUDE.local.md"), MARKER_CONTENT);
      const result = runHook({ script: "ensure-claude-md-gates.sh", cwd: tmpDir });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("skips when marker is in $HOME/.claude/CLAUDE.md", () => {
      // Use a fake HOME to avoid touching the real one
      const fakeHome = path.join(tmpDir, "fake-home");
      fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), MARKER_CONTENT);
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: fakeHome },
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("appends to project CLAUDE.md when marker is nowhere", () => {
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: tmpDir }, // empty fake home — no global marker
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8")).toContain("Twining Lifecycle Gates");
    });
  });
```

- [ ] **Step 2: Run the tests to verify the broad-search cases fail**

Run: `npx vitest run test/hooks/ensure-claude-md-gates.test.ts`
Expected: FAIL on the cases that put the marker in `CLAUDE.local.md`, `.claude/CLAUDE.local.md`, or `$HOME/.claude/CLAUDE.md` — the existing script only checks `$PROJECT_ROOT/CLAUDE.md`.

### Task 18: Implement broad marker search

**Files:**
- Modify: `plugin/hooks/ensure-claude-md-gates.sh`

- [ ] **Step 1: Replace the single-file marker check with a multi-path check**

In `plugin/hooks/ensure-claude-md-gates.sh`, find this block (around lines 21–27):

```bash
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
MARKER="Twining Lifecycle Gates"

# Already present — nothing to do
if [[ -f "$CLAUDE_MD" ]] && grep -q "$MARKER" "$CLAUDE_MD" 2>/dev/null; then
  exit 0
fi
```

Replace with:

```bash
CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
MARKER="Twining Lifecycle Gates"

# Marker may live in any of these locations — check all before deciding to write.
# Order: cheapest first, project files before global file.
SEARCH_PATHS=(
  "$PROJECT_ROOT/CLAUDE.md"
  "$PROJECT_ROOT/CLAUDE.local.md"
  "$PROJECT_ROOT/.claude/CLAUDE.local.md"
  "$HOME/.claude/CLAUDE.md"
)

for candidate in "${SEARCH_PATHS[@]}"; do
  if [[ -f "$candidate" ]] && grep -q "$MARKER" "$candidate" 2>/dev/null; then
    exit 0
  fi
done
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/hooks/ensure-claude-md-gates.test.ts`
Expected: PASS — all broad-search, opt-out, and disabled cases.

- [ ] **Step 3: Commit the unified #9 + #10-portion fix**

```bash
git add plugin/hooks/ensure-claude-md-gates.sh test/hooks/ensure-claude-md-gates.test.ts
git commit -m "fix(hooks): broaden marker search + opt-out flag in ensure-claude-md-gates (#9, #10)"
```

---

## Phase 5 — SessionStart command hook (#8)

### Task 19: Test for the new `session-start-context.sh`

**Files:**
- Create: `test/hooks/session-start-context.test.ts`

- [ ] **Step 1: Write the test (script doesn't exist yet — hook test helper will fail)**

```typescript
// test/hooks/session-start-context.test.ts
import { describe, it, expect } from "vitest";
import { runHook } from "./run-hook";

const EXPECTED_CONTEXT_FRAGMENT = "Twining MCP tools are available";

describe("session-start-context.sh", () => {
  it("emits a JSON envelope with hookSpecificOutput.additionalContext", () => {
    const result = runHook({ script: "session-start-context.sh" });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain(EXPECTED_CONTEXT_FRAGMENT);
    expect(payload.hookSpecificOutput.additionalContext).toContain("twining_assemble");
    expect(payload.hookSpecificOutput.additionalContext).toContain("twining_record");
  });

  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const result = runHook({
      script: "session-start-context.sh",
      env: { TWINING_DISABLED: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/hooks/session-start-context.test.ts`
Expected: FAIL — script doesn't exist (`bash: <path>: No such file or directory`).

### Task 20: Create `session-start-context.sh`

**Files:**
- Create: `plugin/hooks/session-start-context.sh`

- [ ] **Step 1: Write the script**

```bash
#!/bin/bash
# Twining SessionStart Hook (command type)
# Replaces the prompt-type entry that crashed on session resume:
# "ToolUseContext is required for prompt hooks. This is a bug." (issue #8)
#
# Emits a single-line JSON envelope so Claude Code injects the gate reminder
# into context at the start of every session, including resume events.
# No external dependencies.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Twining MCP tools are available. Two gates: (1) `twining_assemble` FIRST — before reading code. (2) `twining_record` LAST — before committing or ending. See CLAUDE.md \"Twining Lifecycle Gates\" for details."}}
JSON
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x plugin/hooks/session-start-context.sh`

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run test/hooks/session-start-context.test.ts`
Expected: PASS.

### Task 21: Wire the new hook into `hooks.json`

**Files:**
- Modify: `plugin/hooks/hooks.json`

- [ ] **Step 1: Replace the `prompt`-type SessionStart entry with a `command`-type entry**

Find this block in `plugin/hooks/hooks.json` (around lines 3–13):

```json
"SessionStart": [{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/hooks/ensure-claude-md-gates.sh",
    "timeout": 5
  }, {
    "type": "prompt",
    "prompt": "Twining MCP tools are available. Two gates: (1) `twining_assemble` FIRST — before reading code. (2) `twining_record` LAST — before committing or ending. See CLAUDE.md \"Twining Lifecycle Gates\" for details."
  }]
}],
```

Replace the second hook entry (the `prompt` one) so the entire `SessionStart` block becomes:

```json
"SessionStart": [{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/hooks/ensure-claude-md-gates.sh",
    "timeout": 5
  }, {
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.sh",
    "timeout": 5
  }]
}],
```

- [ ] **Step 2: Validate the JSON parses**

Run: `cat plugin/hooks/hooks.json | python3 -m json.tool > /dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit the #8 fix**

```bash
git add plugin/hooks/hooks.json plugin/hooks/session-start-context.sh test/hooks/session-start-context.test.ts
git commit -m "fix(hooks): convert SessionStart prompt hook to command hook (#8)"
```

---

## Phase 6 — Version bumps and CHANGELOG

### Task 22: Bump versions in lockstep

**Files:**
- Modify: `plugin/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `package.json`

- [ ] **Step 1: Bump plugin version (lockstep across two files)**

Run: `./scripts/bump-plugin-version.sh minor`

This script bumps both `.claude-plugin/marketplace.json` and `plugin/.claude-plugin/plugin.json` from `1.8.0` to `1.9.0` (per project memory).

- [ ] **Step 2: Bump MCP server version**

Edit `package.json`: change `"version": "1.18.0"` to `"version": "1.19.0"`.

- [ ] **Step 3: Verify the CI version-check job would pass**

Run: `git diff plugin/ | wc -l`
Expected: > 0 lines (otherwise the bump isn't required, and CI would fail differently).

Run: `cat plugin/.claude-plugin/plugin.json | grep version` and `cat .claude-plugin/marketplace.json | grep version | head -1`
Expected: both show `"version": "1.9.0"`.

- [ ] **Step 4: Build and run all tests one more time**

Run: `npm run build && npm test`
Expected: PASS — clean build, all tests green.

### Task 23: Add CHANGELOG entries

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a new release block at the top of the changelog (after the title block)**

Insert immediately after the line `All notable changes to Twining MCP are documented here.` and the blank line that follows it:

```markdown
## [1.19.0] - 2026-04-29

### Added
- `TWINING_DISABLED` env var (#10). Set `TWINING_DISABLED=true` (e.g. in `.claude/settings.json` `env` block) to disable Twining for a project — the MCP server exits cleanly before registering tools, so no Twining tools appear in Claude's list. Use case: per-project opt-out without uninstalling the plugin globally. Restart Claude Code to re-enable.

### Plugin v1.9.0
- Fixed: `SessionStart:resume` hook crash (#8). The `prompt`-type SessionStart hook was failing with "ToolUseContext is required for prompt hooks" on session resume. Replaced with a `command`-type hook (`session-start-context.sh`) that emits the gate reminder via `additionalContext` JSON; works on both startup and resume.
- Fixed: `ensure-claude-md-gates.sh` no longer re-stomps `CLAUDE.md` (#9). The hook now searches for the "Twining Lifecycle Gates" marker in `~/.claude/CLAUDE.md`, project `CLAUDE.md`, project `CLAUDE.local.md`, and `.claude/CLAUDE.local.md`, skipping the append if the marker is found anywhere. An explicit opt-out flag `.twining/.no-claude-md-gates` silences the hook regardless of marker location.
- Added: `TWINING_DISABLED=true` causes all hook scripts (`pre-commit-hook.sh`, `stop-hook.sh`, `subagent-stop-hook.sh`, `ensure-claude-md-gates.sh`, and the new `session-start-context.sh`) to no-op silently. Pairs with the server-side gate above.
```

- [ ] **Step 2: Commit the version bump + changelog together**

```bash
git add package.json plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "chore: bump plugin to 1.9.0 and MCP server to 1.19.0"
```

---

## Phase 7 — Manual smoke test

### Task 24: End-to-end manual verification

This is human-driven verification, not an automated test. The agent should pause and ask the user to walk through it before tagging the release.

- [ ] **Step 1: Build the package locally and link it**

```bash
npm run build
npm link
```

- [ ] **Step 2: Test in a sandbox project**

Create or pick a sandbox project. Configure it to use the linked plugin (`plugin/` directory). Run through the 5-step manual checklist from the spec:

1. Set `TWINING_DISABLED=true` in `.claude/settings.json` `env` block. Launch Claude Code. Confirm: no `twining_*` tools in tool list, no hook output on session start, no PreCommit blocks on `git commit` test.
2. Unset the var (delete the env entry). Relaunch Claude Code. Confirm: tools and hooks restored.
3. Move the gates section from project `CLAUDE.md` to `.claude/CLAUDE.local.md`. Relaunch. Confirm: `CLAUDE.md` is not re-stomped.
4. Add an empty `.twining/.no-claude-md-gates` file. Delete the gates from `CLAUDE.local.md` too. Relaunch. Confirm: `CLAUDE.md` is left alone regardless.
5. Quit Claude Code. Restart it on the same project (resume mode). Confirm: no `ToolUseContext` error message; the gate reminder appears in context.

- [ ] **Step 3: Surface result to user**

Report what passed and what failed. Hold here for user sign-off before Task 25.

### Task 25: Tag and release

**Files:** none (git tag + push)

- [ ] **Step 1: User sign-off**

Wait for the user to confirm the smoke test passed.

- [ ] **Step 2: Tag and push**

```bash
git tag v1.19.0
git push origin main
git push origin v1.19.0
```

This triggers the GitHub Actions `Publish` workflow to release the new version to npm. Per project memory: never publish locally.

- [ ] **Step 3: Verify CI succeeded**

Run: `gh run watch --repo daveangulo/twining-mcp` (or check the Actions tab in GitHub).
Expected: `plugin-version-check` and `Publish` jobs both green.

- [ ] **Step 4: Close the issues**

```bash
gh issue close 8 --repo daveangulo/twining-mcp --comment "Fixed in v1.19.0 / plugin v1.9.0. SessionStart prompt hook converted to command hook."
gh issue close 9 --repo daveangulo/twining-mcp --comment "Fixed in v1.19.0 / plugin v1.9.0. Broad marker search across CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.local.md, and ~/.claude/CLAUDE.md, plus opt-out flag .twining/.no-claude-md-gates."
gh issue close 10 --repo daveangulo/twining-mcp --comment "Fixed in v1.19.0 / plugin v1.9.0. Set TWINING_DISABLED=true (e.g. in .claude/settings.json env block) to disable per-project."
```

---

## Notes on TDD discipline

Every code-change task in this plan follows the TDD loop: write test → verify it fails for the right reason → implement → verify it passes → commit. If a test passes the moment you write it, the test is wrong (it's not exercising the new behavior). Strengthen it before continuing.

The two exceptions are pure configuration changes (Task 21, hooks.json wiring; Task 22, version bumps) — these have no logic to test directly, but Tasks 19/20 already cover the new hook script's behavior, and the build + full test suite re-run in Task 22 catches integration regressions.
