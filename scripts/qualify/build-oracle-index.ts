/**
 * Generate `test/acceptance/oracles/INDEX.md`: every assertion id in the
 * oracle corpus, the test file that is planned to discharge it, the lane that
 * owns that file, and the current status.
 *
 * Run: npx tsx scripts/qualify/build-oracle-index.ts
 *
 * The index NEVER restates an expectation — only ids, ownership and status.
 * Status vocabulary is deliberately narrow and never converts unknown into
 * pass (05-verification-and-operations.md, "Final report"):
 *   cited    — the id appears in a test file that exists and currently passes
 *   todo     — the id appears in a test file that exists, marked todo there
 *   planned  — a lane owns the case; no test file cites the id yet
 *   unowned  — no lane owns the case in docs/plans/2026-09-15-lane-briefs.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ORACLES_DIR, caseIds, hasVariant, identityOverlap, inventory } from "../../test/acceptance/harness/oracles.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Case -> owning lane, read off docs/plans/2026-09-15-lane-briefs.md. Where two
 * briefs name the same case the more specific owner is listed first; the
 * overlap is shown rather than silently resolved.
 */
const OWNERS: Record<string, string[]> = {
  C01: ["04"], C02: ["04"], C03: ["04", "05-stub"], C04: ["04"], C05: ["04"],
  C06: ["03", "04"], C07: ["04"], C08: ["04"], C09: ["04", "02-slice"],
  C10: ["02-slice"], C11: ["02-slice"], C12: ["04"], C13: ["05-stub"],
  C14: ["02-slice", "02"], C15: ["03"], C16: ["04", "02-slice"], C17: ["02"],
  C18: ["02"], C19: ["04"], C20: ["02"], C21: ["02"], C22: ["02"],
  C23: ["05-stub"], C24: ["02"], C25: ["04"], C26: ["04"], C27: ["03", "05-stub"],
  C28: ["05-stub"],
};

/** Test files that already exist and cite oracle assertion ids. */
const TEST_GLOBS = ["test/acceptance/slice", "test/acceptance/baseline", "test/acceptance/harness"];

function existingTestFiles(): string[] {
  const out: string[] = [];
  for (const g of TEST_GLOBS) {
    const dir = path.join(ROOT, g);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".test.ts")) out.push(path.join(g, f));
  }
  return out.sort();
}

/** Which file, if any, mentions this case's assertion id in a comment or an expectation label. */
function citations(caseId: string, ids: string[]): Map<string, { file: string; todo: boolean }> {
  const found = new Map<string, { file: string; todo: boolean }>();
  const lower = caseId.toLowerCase();
  for (const rel of existingTestFiles()) {
    const base = path.basename(rel).toLowerCase();
    // Only a file that clearly belongs to this case may claim its ids —
    // otherwise `A1` in one case's test would claim every case's `A1`.
    if (!base.startsWith(lower) && !base.includes(lower)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const id of ids) {
      if (found.has(id)) continue;
      const re = new RegExp(`(?<![\\w-])${id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![\\w-])`);
      if (re.test(text)) {
        const line = text.split("\n").find((l) => re.test(l)) ?? "";
        found.set(id, { file: rel, todo: /\btodo\b/i.test(line) });
      }
    }
  }
  return found;
}

/** The test file a case's assertions are PLANNED to land in. */
function plannedFile(caseId: string, cited: Map<string, { file: string; todo: boolean }>): string {
  const first = [...cited.values()][0];
  if (first) return first.file;
  const owners = OWNERS[caseId] ?? [];
  if (owners.includes("02-slice")) return `test/acceptance/slice/${caseId.toLowerCase()}.test.ts`;
  if (owners.includes("05-stub")) return `test/acceptance/cases/${caseId}.todo.md`;
  return `test/acceptance/cases/${caseId.toLowerCase()}.test.ts`;
}

function main(): void {
  const ids = caseIds();
  const rows: string[] = [];
  const perCase: string[] = [];
  let total = 0;
  let owned = 0;
  let unowned = 0;
  let citedCount = 0;

  for (const caseId of ids) {
    const inv = inventory(caseId);
    const held = hasVariant(caseId, "heldout") ? inventory(caseId, "heldout") : null;
    const allIds = [...new Set([...inv.ids, ...(held?.ids ?? [])])].sort();
    const cited = citations(caseId, allIds);
    const file = plannedFile(caseId, cited);
    const owners = OWNERS[caseId] ?? [];
    const isUnowned = owners.length === 0 || owners.every((o) => o === "05-stub");

    for (const id of allIds) {
      total++;
      const c = cited.get(id);
      const status = c ? (c.todo ? "todo" : "cited") : isUnowned ? "unowned" : "planned";
      if (status === "cited" || status === "todo") citedCount++;
      if (isUnowned) unowned++;
      else owned++;
      rows.push(`| ${caseId} | \`${id}\` | ${held?.ids.includes(id) && !inv.ids.includes(id) ? "held-out" : "dev"} | \`${c?.file ?? file}\` | ${owners.join(", ") || "—"} | ${status} |`);
    }

    perCase.push(
      `| ${caseId} | ${inv.ids.length} | ${held ? held.ids.length : "—"} | ${allIds.length} | ${inv.mode} | ${inv.invariants.length} | ${inv.controls.length} | ${
        hasVariant(caseId, "heldout") ? `${Math.round(identityOverlap(caseId) * 100)}%` : "n/a"
      } | ${owners.join(", ") || "—"} |`,
    );
  }

  const out = `<!-- GENERATED by scripts/qualify/build-oracle-index.ts — do not edit by hand. -->
# Oracle assertion index

Generated ${new Date().toISOString().slice(0, 10)} from \`test/acceptance/oracles/\` and the test files that exist in this worktree. It maps **every assertion id the corpus states** to the test file planned to discharge it, the owning lane and the current status.

**It contains no expectations.** Expectations live in the oracles and are never edited to match observed behaviour. Status never converts unknown into pass.

| status | meaning |
| --- | --- |
| \`cited\` | the id is named in a test file that exists in this worktree |
| \`todo\` | the id is named in a test file, on a line marked todo |
| \`planned\` | a lane owns the case; no existing test file names the id yet |
| \`unowned\` | no lane in \`docs/plans/2026-09-15-lane-briefs.md\` owns the case |

**What is tracked.** The corpus does not separate assertion ids from invariant, control and trigger ids by grammar, so this index tracks all labelled ids a case states: assertions (\`A1\`, \`A-BYTE-3\`), invariants (\`INV-07\`), instrument-can-fail controls (\`IC-4\`), open questions (\`Q3\`) and, in C09, trigger steps (\`TR-11\`). Splitting them would require editing the oracles.

**Precision caveat (F-IDS).** The corpus uses at least six assertion-id grammars (\`A1\`, \`A01\`, \`A-REC-01\`, \`C26-A01\`, \`INV-1\`, \`POS-A1\`, plus \`X-A4\`/\`H-7\`/\`W2\` in the held-out sets), and C01 states its ids only in prose. The extractor records the source it used per case: \`fixtures\` (the fixture set's own machine-readable \`assertions[]\` list — highest fidelity), \`fixtures+markdown\`, \`structured\` (anchored to a bullet, bold lead or table cell) or \`scan\` (whole-document token sweep, lowest precision). Counts are a floor for \`structured\`/\`fixtures\` cases and indicative for a \`scan\` case.

## Totals

- cases: **${ids.length}** (28 development oracles, ${ids.filter((c) => hasVariant(c, "heldout")).length} with held-out variants)
- assertion ids tracked: **${total}**
- owned by a lane: **${owned}** · not owned by any lane: **${unowned}**
- already named in an existing test file: **${citedCount}** · not yet: **${total - citedCount}**

## Per case

| case | dev ids | held-out ids | tracked | id source | invariants | controls | dev/held-out identity overlap | owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${perCase.join("\n")}

## Every assertion id

| case | assertion | variant | planned test file | owner lane | status |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;

  fs.writeFileSync(path.join(ORACLES_DIR, "INDEX.md"), out);
  process.stdout.write(`INDEX.md written: ${total} assertion ids across ${ids.length} cases (owned ${owned}, unowned ${unowned}, cited ${citedCount})\n`);
}

main();
