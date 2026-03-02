# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.4 — Agent Behavior Quality

**Shipped:** 2026-03-02
**Phases:** 5 | **Plans:** 12 | **Sessions:** ~12 (one per plan)

### What Was Built
- Machine-parseable behavioral specification (plugin/BEHAVIORS.md) covering all 32 MCP tools with MUST/SHOULD/MUST_NOT rules, 8 workflow scenarios, anti-pattern catalog
- Eval harness with 7 deterministic category scorers, 22 YAML scenarios, matrix testing (154 tests)
- Transcript analysis pipeline parsing real JSONL sessions with same scorer pipeline (16 tests)
- LLM-as-judge integration with 2 semantic scorers (rationale quality, scope appropriateness) behind env-var gate
- Plugin tuning infrastructure with per-scorer thresholds, holdout eval set (6 scenarios, 42 tests), and regression baseline

### What Worked
- **TDD for eval infrastructure** — writing failing tests first caught scorer edge cases before they propagated
- **Single-day milestone** — 12 plans executed in ~72 minutes total with near-zero rework
- **Category-aware scorer filtering** — solved 6 false positives by fixing scorers instead of modifying plugin, keeping token budget at 0% growth
- **Holdout eval set** — 97.6% holdout pass rate validated that tuning generalized and didn't overfit
- **State machine parser** — simple format-specific extraction worked perfectly; no markdown AST library needed

### What Was Inefficient
- **Missing SUMMARY.md one-liners** — SUMMARY files lacked structured frontmatter fields, making automated accomplishment extraction impossible at milestone completion
- **eval:baseline ordering fragility** — crashes if eval:synthetic hasn't been run first; could have added readOptionalJson from the start
- **Holdout console leakage** — vitest pattern matching is too broad, showing holdout scores during tuning runs (data isolation correct but console output undermines isolation intent)

### Patterns Established
- **Behavioral spec as single document** — one authoritative BEHAVIORS.md parsed into typed objects by state machine
- **Matrix testing** — scenarios x scorers produces thorough coverage without combinatorial test file explosion
- **Expected negatives** — violation scenarios explicitly declare expected_scores: false for scenario-scorer pairs that should fail
- **Effective pass rate** — counts both score>=threshold and expected=false matches as eval passes
- **Env-var gated LLM scorers** — TWINING_EVAL_JUDGE=1 keeps CI fast and deterministic

### Key Lessons
1. **Fix scorers, not instructions** — when eval failures appeared, the root cause was always scorer false positives, never plugin instruction gaps. Resist the urge to add more instructions.
2. **Token budget as constraint** — the 20% cap enforced discipline: any plugin modification must justify its token cost. v1.4 achieved 0% growth.
3. **Holdout sets matter** — even with only 6 holdout scenarios, the gap between synthetic and holdout pass rates (100% vs 97.6%) provided meaningful signal about generalization.
4. **Real transcripts expose different patterns** — synthetic scenarios test ideal behavior; real sessions have inherent scorer variance requiring lower thresholds (0.6 vs 0.8).

### Cost Observations
- Model mix: 100% opus (quality profile)
- Sessions: ~12 (one per plan execution)
- Notable: entire v1.4 milestone (5 phases, 12 plans) completed in single day with ~72 min total execution time

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Plans | Key Change |
|-----------|----------|--------|-------|------------|
| v1 | ~6 | 3 | 6 | Initial TDD + GSD workflow |
| v1.1 | ~6 | 3 | 6 | Integration testing patterns |
| v1.2 | ~10 | 4 | 10 | Dashboard + frontend testing |
| v1.3 | ~10 | 4 | 10 | Agent coordination patterns |
| v1.4 | ~12 | 5 | 12 | Eval infrastructure + behavioral spec |

### Cumulative Quality

| Milestone | Tests | LOC (prod) | MCP Tools |
|-----------|-------|------------|-----------|
| v1 | 221 | ~3,936 | 18 |
| v1.1 | 274 | ~5,204 | 22 |
| v1.2 | 312 | ~5,673 | 22 |
| v1.3 | 444 | ~6,943 | 23 |
| post-v1.3 | 614 | ~9,674 | 32 |
| v1.4 | 723 + 212 eval | ~9,674 | 32 |

### Top Lessons (Verified Across Milestones)

1. **TDD prevents rework** — consistently faster across all milestones when tests are written first
2. **Single-document specs reduce context switching** — BEHAVIORS.md, TWINING-DESIGN-SPEC.md both validate the pattern
3. **Fix the right layer** — v1.4 confirmed: scorer fixes > plugin instruction changes; similarly, v1.3 showed engine fixes > tool workarounds
4. **Constraint-driven design** — token budget cap (v1.4), file-native storage (v1), read-only dashboard (v1.2) all prevented scope creep
