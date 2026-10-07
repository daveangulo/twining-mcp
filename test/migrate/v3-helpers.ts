/**
 * Shared scaffolding for the v3 migration suites (lane 02c).
 *
 * Every run works on a COPY of a committed fixture store in a temp directory.
 * No test ever migrates a real `.twining/`, and the fixtures themselves are
 * read-only inputs: if a test mutated one, the next test would be measuring
 * the previous test's output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, "..", "fixtures", "legacy-stores");
export const V1_FIXTURE = path.join(FIXTURES, "v1-file-store");
export const V2_FIXTURE = path.join(FIXTURES, "v2-records-tree");

const roots: string[] = [];

/** A scratch copy of a fixture store. Removed by cleanupStores(). */
export function copyStore(fixture: string, label = "v3mig"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-${label}-`));
  const dst = path.join(dir, "project");
  fs.cpSync(fixture, dst, { recursive: true });
  roots.push(dir);
  return dst;
}

/** An empty scratch project (for the clean-control comparison). */
export function scratchDir(label = "v3mig"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-${label}-`));
  roots.push(dir);
  return dir;
}

export function cleanupStores(): void {
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export const twiningDirOf = (projectRoot: string): string => path.join(projectRoot, ".twining");

/** Every file under a directory, relative and sorted — for byte snapshots. */
export function snapshotBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel);
      else out[childRel] = fs.readFileSync(childAbs).toString("base64");
    }
  };
  walk(dir, "");
  return out;
}

/** The legacy record files a migration must never modify. */
export function legacySnapshot(twiningDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ["decisions", "graph", "handoffs", "archive"]) {
    for (const [rel, bytes] of Object.entries(snapshotBytes(path.join(twiningDir, sub)))) out[`${sub}/${rel}`] = bytes;
  }
  const bb = path.join(twiningDir, "blackboard.jsonl");
  if (fs.existsSync(bb)) out["blackboard.jsonl"] = fs.readFileSync(bb).toString("base64");
  return out;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
