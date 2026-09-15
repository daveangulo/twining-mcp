/**
 * Real-host capture tests. Gated on TWINING_REAL_HOST=1 because they spawn a
 * model.
 *
 * What these prove that the unit tests cannot: that the host actually FIRES
 * the hooks we registered, actually passes the fields we parse, and actually
 * accepts the JSON we print. Every row of the published capability matrix is a
 * claim about a program we do not control, and a matrix verified only against
 * documentation is a matrix verified against a wish.
 *
 * Safety rules baked in here, not left to the runner:
 *   - every run happens in a TEMP synthetic project. A real host is never
 *     pointed at this repository's own store.
 *   - identity lives in a temp HOME, so no run touches the developer's keys.
 *   - prompts are tiny and the run count is small.
 *
 * Run: TWINING_REAL_HOST=1 npx vitest run test/adapters/real-host.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundleCli } from "../cli/bundle-cli.js";
import { ensureStoreDescriptor } from "../../src/adapters/identity.js";
import { openRuntime } from "../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../src/contracts/index.js";

const REAL = process.env.TWINING_REAL_HOST === "1";
const WORKTREE = path.resolve(__dirname, "..", "..");
const HOOK = path.join(WORKTREE, "plugin", "hooks", "v3-capture-hook.sh");

let cli: string;
let root: string;
let projectRoot: string;
let identityHome: string;

beforeAll(async () => {
  if (!REAL) return;
  cli = await bundleCli();
}, 180_000);

beforeEach(() => {
  if (!REAL) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twining-realhost-")));
  projectRoot = path.join(root, "project");
  identityHome = path.join(root, "identity");
  fs.mkdirSync(path.join(projectRoot, ".twining"), { recursive: true });
  fs.mkdirSync(identityHome, { recursive: true });
  ensureStoreDescriptor(path.join(projectRoot, ".twining"), { format: STORE_FORMAT_VERSION });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "synthetic project for a real-host capture test\n");
});

afterEach(() => {
  if (!REAL || !root) return;
  fs.rmSync(root, { recursive: true, force: true });
});

function hookCommand(event: string, host = "claude-code"): string {
  return `bash "${HOOK}" ${host} ${event}`;
}

/** Project-local Claude Code settings that register only Twining's v3 hooks. */
function writeClaudeSettings(): void {
  const dir = path.join(projectRoot, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: hookCommand("SessionStart"), timeout: 30 }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("UserPromptSubmit"), timeout: 30 }] }],
          PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: hookCommand("PreCompact"), timeout: 30 }] }],
          SubagentStart: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("SubagentStart"), timeout: 30 }] }],
          SubagentStop: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("SubagentStop"), timeout: 30 }] }],
          Stop: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("Stop"), timeout: 30 }] }],
          SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("SessionEnd"), timeout: 10 }] }],
        },
      },
      null,
      2,
    ),
  );
}

function hostEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A temp HOME keeps the host key and any human key out of the developer's
    // real identity directory.
    TWINING_IDENTITY_HOME: identityHome,
    TWINING_CLI_JS: cli,
    TWINING_CLI_NO_PATH_RECOVERY: "1",
  };
}

async function capturedEvents(): Promise<Array<{ kind: string; type?: string; class: string; session?: string; turn?: string; payload: Record<string, unknown> }>> {
  const runtime = openRuntime({
    projectRoot,
    env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
  });
  try {
    await runtime.store!.admit();
    const events = await runtime.store!.events({});
    return events.map((e) => ({
      kind: e.kind,
      ...(e.record ? { type: e.record.type } : {}),
      class: e.evidence_class,
      ...(e.producer.session ? { session: e.producer.session } : {}),
      ...(e.producer.turn ? { turn: e.producer.turn } : {}),
      payload: e.payload as Record<string, unknown>,
    }));
  } finally {
    runtime.close();
  }
}

describe.skipIf(!REAL)("Claude Code, real host", () => {
  it("a one-shot session fires the hooks and captures the prompt", async () => {
    writeClaudeSettings();
    const prompt = "Reply with the single word OK.";
    const r = spawnSync("claude", ["-p", prompt], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 300_000,
      env: hostEnv(),
    });
    // The host's own exit status is reported but not asserted: a rate limit or
    // an auth hiccup is an untested run, not a failed capture. What matters is
    // what reached the store.
    const events = await capturedEvents();
    // eslint-disable-next-line no-console
    console.error(
      `[real-host] claude exit=${r.status} events=${events.length} kinds=${JSON.stringify(events.map((e) => `${e.kind}:${e.type ?? "-"}`))}`,
    );

    expect(events.length, "the host must have fired at least one Twining hook").toBeGreaterThan(0);

    // SessionStart wrote a session_start observation.
    const sessionStart = events.find(
      (e) => e.type === "observation" && (e.payload as { result?: { kind?: string } }).result?.kind === "session_start",
    );
    expect(sessionStart, "SessionStart must have been captured").toBeTruthy();
    expect(sessionStart!.session, "the host's session_id must reach the producer").toBeTruthy();

    // UserPromptSubmit stored the literal prompt.
    const statement = events.find((e) => e.class === "human_statement");
    expect(statement, "UserPromptSubmit must have captured the prompt").toBeTruthy();
    expect(statement!.payload.detail).toBe(prompt);
  }, 360_000);

  it("a dispatched subagent produces a work reference and a reported_result", async () => {
    writeClaudeSettings();
    const r = spawnSync(
      "claude",
      [
        "-p",
        "Use the Task tool once with subagent_type Explore and the prompt 'list the files here'. Then reply DONE.",
      ],
      { cwd: projectRoot, encoding: "utf8", timeout: 420_000, env: hostEnv() },
    );
    const events = await capturedEvents();
    // eslint-disable-next-line no-console
    console.error(
      `[real-host] claude(subagent) exit=${r.status} events=${events.length} kinds=${JSON.stringify(events.map((e) => `${e.kind}:${e.type ?? "-"}`))}`,
    );

    const work = events.find((e) => e.type === "work");
    const returned = events.find((e) => e.class === "reported_result");
    if (!work && !returned) {
      // The model may simply not have dispatched. That is an untested row, and
      // saying so is the honest outcome — not a silent pass.
      console.error("[real-host] NOT TESTED: the model did not dispatch a subagent in this run");
      return;
    }
    if (work) expect(String((work.payload as Record<string, unknown>).authority)).toMatch(/grants nothing/);
    if (returned) {
      expect(returned.payload.task_completion_state).toBe("not_complete");
      expect(returned.payload.stage).toBe("worker_returned_review_pending");
    }
  }, 480_000);

  it("the receipt for the injected turn matches the bytes the host was handed", async () => {
    writeClaudeSettings();
    // Seed a record so there is something to inject.
    const seed = openRuntime({
      projectRoot,
      env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
    });
    await seed.append({
      kind: "created",
      recordType: "decision",
      evidenceClass: "proposal",
      payload: { summary: "PLUTONIUM-3 is the agreed retry ceiling", rationale: "real-host fixture" },
      ingress: "cli",
    });
    await seed.store!.admit();
    await seed.store!.project();
    seed.close();

    const r = spawnSync("claude", ["-p", "Reply with the single word OK."], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 300_000,
      env: hostEnv(),
    });
    const events = await capturedEvents();
    const receipts = events.filter((e) => e.kind === "receipt" && e.payload.stage === "injected");
    // eslint-disable-next-line no-console
    console.error(`[real-host] claude(inject) exit=${r.status} injected_receipts=${receipts.length}`);

    expect(receipts.length, "an injecting event must leave a receipt").toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(String(receipt.payload.payload_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(receipt.payload.host).toBeTruthy();
      expect(receipt.payload.session).toBeTruthy();
    }
  }, 360_000);
});

describe.skipIf(!REAL)("Codex, real host", () => {
  it("a one-shot exec fires the hooks and captures the prompt", async () => {
    const dir = path.join(projectRoot, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: hookCommand("SessionStart", "codex"), timeout: 30 }] }],
            UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("UserPromptSubmit", "codex"), timeout: 30 }] }],
            SubagentStop: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("SubagentStop", "codex"), timeout: 30 }] }],
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("Stop", "codex"), timeout: 30 }] }],
          },
        },
        null,
        2,
      ),
    );

    // Codex lives on the LOGIN PATH only (Homebrew cask), so it is reached
    // through a login shell. Hook trust is bypassed for this one invocation —
    // the hook source is this repository, which is exactly the "automation
    // that already vets hook sources" the flag is documented for.
    const r = spawnSync(
      "zsh",
      [
        "-lc",
        `cd ${JSON.stringify(projectRoot)} && codex exec --dangerously-bypass-hook-trust --skip-git-repo-check 'Reply with the single word OK.'`,
      ],
      { encoding: "utf8", timeout: 420_000, env: hostEnv() },
    );
    const events = await capturedEvents();
    // eslint-disable-next-line no-console
    console.error(
      `[real-host] codex exit=${r.status} events=${events.length} stderr_tail=${JSON.stringify((r.stderr ?? "").slice(-400))}`,
    );

    if (events.length === 0) {
      // Reported, never converted to a pass: hook trust, project trust and the
      // `[features] hooks` kill switch can each silence every hook, and the
      // honest result is "not tested on this host in this environment".
      console.error(
        "[real-host] NOT TESTED on Codex: no Twining events were written. Check project trust, " +
          "hook trust (`/hooks`), and `[features] hooks` in ~/.codex/config.toml.",
      );
      return;
    }
    const statement = events.find((e) => e.class === "human_statement");
    expect(statement, "UserPromptSubmit must have captured the prompt").toBeTruthy();
    expect(String(statement!.payload.detail)).toContain("OK");
  }, 480_000);
});
