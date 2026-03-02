/**
 * Loads and validates YAML eval scenario files from disk.
 *
 * Scenarios are YAML files validated against ScenarioSchema (Zod).
 * Validation errors include the filename for clear diagnostics.
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ScenarioSchema, type Scenario } from "./scenario-schema.js";

/**
 * Load and validate a single YAML scenario file.
 * @throws Error with filename context if validation fails.
 */
export function loadScenario(filePath: string): Scenario {
  const content = fs.readFileSync(filePath, "utf-8");
  const raw = yaml.load(content);

  try {
    return ScenarioSchema.parse(raw);
  } catch (err) {
    const filename = path.basename(filePath);
    throw new Error(
      `Failed to validate scenario ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Options for loadScenarios. */
export interface LoadScenariosOptions {
  /** Directory to scan. Defaults to test/eval/scenarios/. */
  scenarioDir?: string;
  /** If true, return only holdout scenarios. If false, exclude holdout. If undefined, return all. */
  holdout?: boolean;
}

/**
 * Load all .yaml scenario files from a directory.
 * Validates each file against ScenarioSchema.
 * Returns scenarios sorted alphabetically by name.
 *
 * @param options - Directory path string (backward compat) or options object.
 */
export function loadScenarios(options?: string | LoadScenariosOptions): Scenario[] {
  // Backward compat: string arg = scenarioDir
  const opts: LoadScenariosOptions =
    typeof options === "string" ? { scenarioDir: options } : (options ?? {});

  const dir =
    opts.scenarioDir ?? path.resolve(import.meta.dirname!, "scenarios");

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  let scenarios = files.map((f) => loadScenario(path.join(dir, f)));

  // Apply holdout filter
  if (opts.holdout === true) {
    scenarios = scenarios.filter((s) => s.holdout === true);
  } else if (opts.holdout === false) {
    scenarios = scenarios.filter((s) => s.holdout !== true);
  }
  // opts.holdout === undefined -> return all

  return scenarios.sort((a, b) => a.name.localeCompare(b.name));
}
