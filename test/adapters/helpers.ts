/**
 * Shared fixtures for the adapter tests.
 *
 * Every helper here keys identity off a TEMP identity home. A test that minted
 * a host key into the developer's real ~/.twining/identity would sign the
 * repo's own events with a throwaway key, so the override is not optional
 * hygiene — it is the isolation boundary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureStoreDescriptor } from "../../src/adapters/identity.js";
import { openRuntime, type V3Runtime } from "../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../src/contracts/index.js";

export interface Fixture {
  projectRoot: string;
  twiningDir: string;
  identityHome: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** A temp project with a .twining dir. `v3: false` leaves it on the 2.x shape. */
export function makeFixture(prefix: string, opts: { v3?: boolean } = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const projectRoot = path.join(root, "project");
  const identityHome = path.join(root, "identity");
  const twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(identityHome, { recursive: true });

  if (opts.v3 !== false) {
    ensureStoreDescriptor(twiningDir, { format: STORE_FORMAT_VERSION });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    TWINING_IDENTITY_HOME: identityHome,
    TWINING_SESSION_ID: undefined,
    TWINING_TURN_ID: undefined,
  };
  delete env.TWINING_SESSION_ID;
  delete env.TWINING_TURN_ID;

  return {
    projectRoot,
    twiningDir,
    identityHome,
    env,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function runtimeFor(fx: Fixture, sourceCwd?: string): V3Runtime {
  return openRuntime({
    projectRoot: fx.projectRoot,
    env: fx.env,
    ...(sourceCwd ? { sourceCwd } : {}),
  });
}

/** Seed one admitted decision so the working set has something to render. */
export async function seedDecision(
  runtime: V3Runtime,
  summary: string,
  rationale = "seeded by the adapter test fixture",
): Promise<string> {
  const ev = await runtime.append({
    kind: "created",
    recordType: "decision",
    evidenceClass: "proposal",
    payload: { summary, rationale },
    ingress: "cli",
  });
  if (!ev) throw new Error("fixture could not append a decision");
  await runtime.store?.admit();
  await runtime.store?.project();
  return ev.id;
}
