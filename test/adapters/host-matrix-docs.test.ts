/**
 * The host capability docs are GENERATED, and this test is what makes that
 * true rather than aspirational.
 *
 * A capability matrix that lives only in prose drifts from the code that
 * depends on it, and the drift is invisible: nobody notices "PreCompact can
 * inject" is wrong until a re-seed silently stops happening. Here the table in
 * each doc must equal `renderMatrixTable(<the matrix the adapter actually
 * uses>)` byte for byte.
 *
 * If this fails: regenerate the block between the BEGIN/END GENERATED markers
 * from the matrix — do not hand-edit the doc to match.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { renderMatrixTable } from "../../src/adapters/host-capability.js";
import { CLAUDE_CODE_MATRIX } from "../../src/adapters/claude-code.js";
import { CODEX_MATRIX } from "../../src/adapters/codex.js";

const DOCS = path.resolve(__dirname, "..", "..", "docs", "operations");

const cases = [
  { file: "hosts-claude-code-capabilities.md", matrix: CLAUDE_CODE_MATRIX },
  { file: "hosts-codex-capabilities.md", matrix: CODEX_MATRIX },
];

describe("published host matrices match the adapters", () => {
  for (const { file, matrix } of cases) {
    it(`${file} contains the generated ${matrix.host} table verbatim`, () => {
      const doc = fs.readFileSync(path.join(DOCS, file), "utf8");
      const rendered = renderMatrixTable(matrix);
      // POSITIVE CONTROL — the instrument is reading a real, non-empty doc
      // that carries the generated markers.
      expect(doc.length).toBeGreaterThan(1000);
      expect(doc).toContain("<!-- BEGIN GENERATED:");
      expect(doc).toContain("<!-- END GENERATED -->");
      // THE ASSERTION.
      expect(doc).toContain(rendered);
    });

    it(`${file} states every non-injecting event as such`, () => {
      const doc = fs.readFileSync(path.join(DOCS, file), "utf8");
      for (const row of matrix.events.filter((e) => !e.injects)) {
        // The rendered row marks it **no**; the doc must carry that row.
        expect(doc, `${row.event} must be published as non-injecting`).toContain(`| \`${row.event}\` |`);
      }
      // And the prose limits section must exist, not just the table.
      expect(doc).toContain("Honest limits on this host");
    });
  }

  it("neither host claims it can inject from a compaction hook", () => {
    for (const matrix of [CLAUDE_CODE_MATRIX, CODEX_MATRIX]) {
      for (const row of matrix.events.filter((e) => e.event.includes("Compact"))) {
        expect(row.injects, `${matrix.host} ${row.event} must not claim injection`).toBe(false);
      }
    }
  });
});
