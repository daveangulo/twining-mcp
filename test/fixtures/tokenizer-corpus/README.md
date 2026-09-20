# Tokenizer calibration corpus

Input to `scripts/calibrate-tokenizer.mjs`. Each file should be DOMINATED by one
character class (>= 80% of its bytes), because a mixed document cannot tighten
any single class's ratio without assuming how its tokens split.

Classes, matching `classifyBytes` in `src/retrieval/tokenizer.ts`:
`ascii_alnum`, `ascii_space`, `ascii_punct`, `latin1_supp`, `multibyte`.

The files here are small, permissively-worded samples written for this purpose.
Add more before running a calibration that will be shipped — a five-document
corpus is enough to exercise the harness, not enough to bound production text.

`src/retrieval/calibration.json` was measured over this corpus on 2026-09-16
(count-tokens API, `claude-sonnet-4-5`). `whitespace.txt` is skipped by the
calibrator because the API refuses a blank text block, so `ascii_space` stayed
at the proven ratio 1.0 in that run; `padded-whitespace.txt` (added 2026-09-16,
84% whitespace, non-blank, indentation-heavy like a rendered briefing) exists
so the next run can measure that class. Re-run with a key:

    ANTHROPIC_API_KEY=... node scripts/calibrate-tokenizer.mjs --out src/retrieval/calibration.json

Caveat on the method: each document's whole token count is attributed to its
dominant class, so a class measured only on an extreme document (very long
space runs) could price mixed prose below its real count. Keep the whitespace
document briefing-shaped rather than pathological, and compare the emitted
table's estimate against every document's measured count before shipping it.
Emitting ratios without a measurement behind them would be exactly the
fabrication the conservative bound exists to prevent; the shipped
`PROVEN_TABLE` is correct (and never undercounts) without any of this.
