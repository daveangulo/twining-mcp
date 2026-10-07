/**
 * Oracle + fixture loading for the acceptance harness (lane 05).
 *
 * The oracles under `test/acceptance/oracles/` are implementation-blind: they
 * were written against an abstract memory store before any v3 code existed,
 * each in its own vocabulary. Nothing in this module interprets an
 * expectation — it only *locates* oracles, parses their fixtures and
 * inventories their assertion ids so a test file can declare which ids it
 * discharges and the index can show what is still unowned.
 *
 * Reading rule (non-negotiable, from 05-verification-and-operations.md):
 * an expected outcome is never edited to match observed behaviour. This module
 * is read-only over the oracle corpus.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ORACLES_DIR = path.resolve(HERE, "..", "oracles");

export type Variant = "development" | "heldout";

export interface OracleFile {
  caseId: string;
  variant: Variant;
  /** Absolute path to the markdown oracle. */
  oraclePath: string;
  /** Absolute path to the JSON fixture set. */
  fixturesPath: string;
}

/** Every C## that has at least a development oracle, in numeric order. */
export function caseIds(): string[] {
  const ids = new Set<string>();
  for (const f of fs.readdirSync(ORACLES_DIR)) {
    const m = /^(C\d{2})\.oracle\.md$/.exec(f);
    if (m?.[1]) ids.add(m[1]);
  }
  return [...ids].sort();
}

export function oracleFile(caseId: string, variant: Variant = "development"): OracleFile {
  const infix = variant === "heldout" ? ".heldout" : "";
  return {
    caseId,
    variant,
    oraclePath: path.join(ORACLES_DIR, `${caseId}${infix}.oracle.md`),
    fixturesPath: path.join(ORACLES_DIR, `${caseId}${infix}.fixtures.json`),
  };
}

export function hasVariant(caseId: string, variant: Variant): boolean {
  const f = oracleFile(caseId, variant);
  return fs.existsSync(f.oraclePath) && fs.existsSync(f.fixturesPath);
}

export function readOracleText(caseId: string, variant: Variant = "development"): string {
  return fs.readFileSync(oracleFile(caseId, variant).oraclePath, "utf8");
}

/** Parse a fixture set. Throws (loudly) if the JSON is malformed — that is a defect, not a skip. */
export function readFixtures<T = Record<string, unknown>>(caseId: string, variant: Variant = "development"): T {
  const p = oracleFile(caseId, variant).fixturesPath;
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

// --------------------------------------------------------------- assertions

/**
 * FINDING F-IDS (reported to the lead, scope test/acceptance/): the corpus has
 * NO common assertion-id convention. Five grammars are in use —
 *
 *   `A1` / `N1` / `P1` / `G1`        C02, C05, C09, C18, C23 (POS-A1), …
 *   `A01` … `A18`                     C01 (in prose, not in bullets)
 *   `A-REC-01`, `A-CUR-03`            C21
 *   `C26-A01`                         C26
 *   `INV-1` … `INV-14`                C19
 *   `X-A4` / `H-7` / `W2`             held-out variants
 *
 * — and C01 states its ids only in a prose paragraph, so a bullet-anchored
 * extractor finds none. The index therefore records HOW each case's ids were
 * obtained (`structured` from a bullet/bold/table lead, `scan` from a
 * document-wide token sweep) so a reader can see where precision drops.
 * Normalizing the ids themselves would edit the oracles and is NOT done here.
 */
const GRAMMARS = [
  // Longest / most specific first: alternation is ordered, and `A1` would
  // otherwise shadow `A1-CAP-COVERAGE`.
  "[A-Z]\\d{1,2}-[A-Z][A-Z0-9-]{2,}",
  "INV-\\d+",
  "(?:POS|NEG)-A\\d+[a-z]?",
  "A-[A-Z]{2,5}-\\d+[a-z]?",
  "C\\d{2}-[ANPGI]\\d+[a-z]?",
  "X-[A-Z]\\d+[a-z]?",
  "[A-Z]{1,3}-\\d+[a-z]?",
  "[ANPGIQ]\\d{1,2}[a-z]?",
];
const ID_BODY = `(?:${GRAMMARS.join("|")})`;

/** Bullet lead: `- **A1** …`, `- **A-REC-01 [+] …**`, `- \`INV-3\` …`. */
const BULLET = new RegExp(`^\\s*[-*]\\s*\\**\\s*\`?(${ID_BODY})\`?(?![\\w-])`, "gm");
/** Bold lead at line start: `**A1 (N) — dense path.**`, `**C26-A01 (budget…)**`. */
const BOLD_LEAD = new RegExp(`^\\*\\*\\s*\`?(${ID_BODY})\`?(?![\\w-])`, "gm");
/** Table row whose FIRST cell is an assertion id. */
const TABLE = new RegExp(`^\\|\\s*\\**\\s*\`?(${ID_BODY})\`?\\**\\s*\\|`, "gm");
/** Whole-document sweep, used only when the anchored passes find nothing. */
const SWEEP = new RegExp(`(?<![\\w-])(${ID_BODY})(?![\\w-])`, "g");

/**
 * In sweep mode the letters G/I/Q are dropped: they only ever appear as
 * structured leads, and in free prose `G1`/`I2`/`Q1` are far more often a
 * group, an identity or a query label than an assertion.
 */
const SWEEP_STOPWORDS = /^[GIQ]-?\d{1,2}[a-z]?$/;

export type ExtractionMode = "fixtures" | "fixtures+markdown" | "structured" | "scan" | "none";

/**
 * Ids from the fixture set's own machine-readable assertion list, where the
 * case has one (`assertions[]`, `negative_assertions[]`, …). This is the
 * highest-fidelity source: the validation owner wrote the ids there, so no
 * markdown grammar has to be guessed. 18 of the 28 cases carry one.
 */
export function fixtureAssertionIds(caseId: string, variant: Variant = "development"): string[] {
  let fx: unknown;
  try {
    fx = readFixtures(caseId, variant);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const collectIds = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) collectIds(v);
    } else if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (typeof rec.id === "string" && rec.id.length <= 40) out.add(rec.id);
      for (const v of Object.values(rec)) collectIds(v);
    }
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (/assert/i.test(k)) collectIds(v);
        else walk(v);
      }
    }
  };
  walk(fx);
  return [...out];
}

export interface AssertionInventory {
  caseId: string;
  variant: Variant;
  ids: string[];
  /** How `ids` was obtained — see F-IDS above. */
  mode: ExtractionMode;
  /** Bullets under "## Invariants (structured list…)", verbatim. */
  invariants: string[];
  /** Bullets under "## Instrument-can-fail controls", verbatim. */
  controls: string[];
}

function section(text: string, heading: RegExp): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  let buf = "";
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\s*-\s/.test(line)) {
      if (buf) out.push(buf.trim());
      buf = line.replace(/^\s*-\s/, "");
    } else if (buf && line.trim()) {
      buf += " " + line.trim();
    } else if (buf && !line.trim()) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf) out.push(buf.trim());
  return out;
}

export function inventory(caseId: string, variant: Variant = "development"): AssertionInventory {
  const text = readOracleText(caseId, variant);
  const fromFixtures = fixtureAssertionIds(caseId, variant);
  const anchored = new Set<string>();
  for (const re of [BULLET, BOLD_LEAD, TABLE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (m[1]) anchored.add(m[1]);
    }
  }
  let ids = [...new Set([...fromFixtures, ...anchored])];
  let mode: ExtractionMode =
    fromFixtures.length > 0 ? (anchored.size > 0 ? "fixtures+markdown" : "fixtures") : anchored.size > 0 ? "structured" : "none";
  if (ids.length === 0) {
    const swept = new Set<string>();
    SWEEP.lastIndex = 0;
    for (const m of text.matchAll(SWEEP)) {
      const id = m[1];
      if (id && !SWEEP_STOPWORDS.test(id)) swept.add(id);
    }
    ids = [...swept];
    if (ids.length > 0) mode = "scan";
  }
  return {
    caseId,
    variant,
    ids: ids.sort(compareAssertionIds),
    mode,
    invariants: section(text, /^##\s+Invariants\b/),
    controls: section(text, /^##\s+Instrument-can-fail controls\b/),
  };
}

export function compareAssertionIds(a: string, b: string): number {
  const split = (s: string): [string, number, string] => {
    const m = /^(.*?)-?(\d+)([a-z]?)$/.exec(s);
    return m ? [m[1] ?? "", Number(m[2] ?? 0), m[3] ?? ""] : [s, 0, ""];
  };
  const [pa, na, sa] = split(a);
  const [pb, nb, sb] = split(b);
  return pa === pb ? (na === nb ? sa.localeCompare(sb) : na - nb) : pa.localeCompare(pb);
}

/**
 * Identity-shaped string VALUES in a fixture set (`u.rowan.mbele`,
 * `svc.forge-writer@anvil`, `host-anvil-01`, `repo-quarry-service`). Used to
 * check that a held-out set really uses different names, users, hosts and
 * revisions rather than reusing the development set's vocabulary.
 */
const IDENTITY_SHAPE =
  /^(?:u|usr|user|svc|agt|agent|human|host|hst|store|repo|rid|tnt|tenant|chan|sess|team|cred|key|pr|wt|ws)[.\-:][A-Za-z0-9._@:\-]{2,}$|^[A-Za-z0-9._\-]+@[A-Za-z0-9._\-]+$/;

export function identityValues(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) identityValues(v, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) identityValues(v, out);
  } else if (typeof node === "string" && IDENTITY_SHAPE.test(node)) {
    out.add(node);
  }
  return out;
}

/** Fraction of the held-out set's identities that also appear in the development set. */
export function identityOverlap(caseId: string): number {
  const dev = identityValues(readFixtures(caseId));
  const held = identityValues(readFixtures(caseId, "heldout"));
  if (held.size === 0) return 0;
  let shared = 0;
  for (const v of held) if (dev.has(v)) shared++;
  return shared / held.size;
}
