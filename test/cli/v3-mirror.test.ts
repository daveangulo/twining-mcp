/**
 * The v3 write mirror: every existing write command also appends its event.
 *
 * Two properties, and the second matters more than the first:
 *   1. on a v3 store, a `twining post` (or decide, resolve, …) produces the
 *      corresponding event with the class its INGRESS allows;
 *   2. on a 2.x store, nothing changes at all — same envelope, same files, no
 *      events directory. Behavior neutrality is the whole compatibility story
 *      for an un-migrated field checkout, so it is asserted directly rather
 *      than inferred from "the code has an if".
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundleCli } from "./bundle-cli.js";
import { buildMirrorPayload } from "../../src/core/commands/v3-mirror-wrap.js";
import { COMMAND_EVENT_MAP, currentIngress, normaliseScopePath } from "../../src/adapters/v3-mirror.js";
import { ensureStoreDescriptor } from "../../src/adapters/identity.js";
import { openRuntime } from "../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../src/contracts/index.js";

let cli: string;
let root: string;
let projectRoot: string;
let identityHome: string;

beforeAll(async () => {
  cli = await bundleCli();
}, 120_000);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twining-mirror-")));
  projectRoot = path.join(root, "project");
  identityHome = path.join(root, "identity");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(identityHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [cli, ...args, "--project", projectRoot], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TWINING_IDENTITY_HOME: identityHome,
      // The CLI would set this itself; making it explicit keeps the test
      // honest about which ingress it is asserting.
      TWINING_INGRESS: "cli",
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("the mapping", () => {
  it("covers the write verbs and nothing else", () => {
    for (const write of ["twining_post", "twining_decide", "twining_record", "twining_resolve", "twining_promote", "twining_override"]) {
      expect(COMMAND_EVENT_MAP, `${write} must have a v3 twin`).toHaveProperty(write);
    }
    // Reads must NOT produce events — a query is not a thing that happened.
    for (const read of ["twining_assemble", "twining_why", "twining_status", "twining_read", "twining_graph_query"]) {
      expect(COMMAND_EVENT_MAP).not.toHaveProperty(read);
    }
  });

  it("refuses to build a body it cannot make valid, rather than guessing", () => {
    // No summary — a post body without one would be rejected at ingress.
    expect(buildMirrorPayload("twining_post", {}, {})).toBeNull();
    // A lifecycle event with no resolvable ULID target: a lifecycle event
    // pointing at the wrong record is worse than a missing one.
    expect(buildMirrorPayload("twining_resolve", { id: "not-a-ulid" }, {})).toBeNull();
    // A short commit hash cannot become a v3 `commit_linked` (full sha only).
    expect(
      buildMirrorPayload("twining_link_commit", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", commit_hash: "abc1234" }, {}),
    ).toBeNull();
  });

  it("carries the 2.x scope string across only when it can be a repo-relative path", () => {
    expect(normaliseScopePath("src/auth/")).toBe("src/auth");
    expect(normaliseScopePath("./src/auth")).toBe("src/auth");
    expect(normaliseScopePath("/etc/passwd")).toBeUndefined();
    expect(normaliseScopePath("../outside")).toBeUndefined();
    expect(normaliseScopePath("  ")).toBeUndefined();
  });

  it("reads the ingress from the environment, never from the caller's input", () => {
    expect(currentIngress({ TWINING_INGRESS: "cli" } as NodeJS.ProcessEnv)).toBe("cli");
    expect(currentIngress({} as NodeJS.ProcessEnv)).toBe("mcp");
    // An input field named `ingress` is not consulted anywhere — the signature
    // does not even accept one.
    expect(currentIngress({ TWINING_INGRESS: "ceremony" } as NodeJS.ProcessEnv)).toBe("mcp");
  });
});

describe("on a 2.x store: nothing changes", () => {
  it("a post writes no events and creates no events directory", () => {
    const r = run(["post", "--json", JSON.stringify({ entry_type: "finding", summary: "a 2.x post", scope: "src/auth/" })]);
    expect(r.status).toBe(0);
    const envelope = JSON.parse(r.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".twining", "events"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".twining", "store.json"))).toBe(false);
  }, 90_000);
});

describe("on a v3 store: the twin event appears", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(projectRoot, ".twining"), { recursive: true });
    ensureStoreDescriptor(path.join(projectRoot, ".twining"), { format: STORE_FORMAT_VERSION });
  });

  it("a post produces a `created` post event with the CLI ingress's class", async () => {
    const r = run([
      "post",
      "--json",
      JSON.stringify({ entry_type: "warning", summary: "the mirror wrote this too", scope: "src/auth/" }),
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(true);

    const runtime = openRuntime({
      projectRoot,
      env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
    });
    try {
      await runtime.store!.admit();
      const events = await runtime.store!.events({});
      const post = events.find((e) => e.record?.type === "post");
      expect(post, "the mirror must have written a post event").toBeTruthy();
      expect((post!.payload as Record<string, unknown>).summary).toBe("the mirror wrote this too");
      // The class comes from the INGRESS. The cli ingress tops out at proposal;
      // there is no input that could have raised it.
      expect(post!.evidence_class).toBe("proposal");
      // The 2.x scope string became a v3 scope path.
      expect(post!.scope.path).toBe("src/auth");
      // The producer is the host key; agent_id is asserted_actor only.
      expect(post!.producer.principal).toBe(runtime.identity.principal_id);
    } finally {
      runtime.close();
    }
  }, 90_000);

  it("carries the caller's agent_id into producer.asserted_actor — recorded, never authoritative", async () => {
    const r = run([
      "post",
      "--json",
      JSON.stringify({ entry_type: "finding", summary: "who said this?", agent_id: "lane-03-runtime" }),
    ]);
    expect(r.status).toBe(0);

    const runtime = openRuntime({
      projectRoot,
      env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
    });
    try {
      await runtime.store!.admit();
      const post = (await runtime.store!.events({})).find((e) => e.record?.type === "post")!;
      // The label the caller supplied is preserved...
      expect(post.producer.asserted_actor).toBe("lane-03-runtime");
      // ...and confers nothing: the authenticated producer is still the host
      // key, so a caller cannot become another principal by naming one.
      expect(post.producer.principal).toBe(runtime.identity.principal_id);
      expect(post.producer.kind).toBe("agent");
    } finally {
      runtime.close();
    }
  }, 90_000);

  it("the 2.x result envelope is unchanged by the mirror", () => {
    const v3 = run(["post", "--json", JSON.stringify({ entry_type: "finding", summary: "shape check" })]);
    const envelope = JSON.parse(v3.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope).toHaveProperty("schema_version");
    expect(envelope).toHaveProperty("server_version");
    expect(envelope).toHaveProperty("project_root");
    expect(envelope).toHaveProperty("store_dir");
    expect(envelope.command).toBe("twining_post");
    // Exactly one envelope on stdout, as the CLI contract promises.
    expect(v3.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  }, 90_000);

  it("a read command produces no event", async () => {
    run(["post", "--json", JSON.stringify({ entry_type: "finding", summary: "seed" })]);
    const runtime = openRuntime({
      projectRoot,
      env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
    });
    let before: number;
    try {
      await runtime.store!.admit();
      before = (await runtime.store!.events({})).length;
    } finally {
      runtime.close();
    }

    const r = run(["assemble", "--json", JSON.stringify({ task: "look around", scope: "src/auth/" })]);
    expect(r.status).toBe(0);

    const after = openRuntime({
      projectRoot,
      env: { ...process.env, HOME: root, TWINING_IDENTITY_HOME: identityHome },
    });
    try {
      await after.store!.admit();
      expect((await after.store!.events({})).length).toBe(before);
    } finally {
      after.close();
    }
  }, 120_000);
});
