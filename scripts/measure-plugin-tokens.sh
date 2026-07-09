#!/bin/bash
# Measures token budget of plugin artifacts that load into model context:
# skills and agents. Hook scripts are excluded — their context cost is the
# stdout they emit, not their source bytes (counting source falsely charged
# shell comments as prompt tokens and exhausted the cap while the real
# context footprint stayed flat; rescoped 2026-07-09).
# Baseline is skills+agents at the v1.4 tuning snapshot (cd0497b).
# Usage: ./scripts/measure-plugin-tokens.sh [--ci]
# With --ci flag, exits non-zero if total exceeds 120% cap.

set -euo pipefail

PRE_TUNING_BYTES=30514
CAP=$((PRE_TUNING_BYTES * 120 / 100))  # 36616

TOTAL=0
echo "Plugin Token Budget Report"
echo "=========================="
echo ""

for f in plugin/skills/*/SKILL.md plugin/agents/*.md; do
  if [ -f "$f" ]; then
    SIZE=$(wc -c < "$f" | tr -d ' ')
    TOKENS=$((SIZE / 4))
    printf "%-55s %6d bytes  ~%5d tokens\n" "$f" "$SIZE" "$TOKENS"
    TOTAL=$((TOTAL + SIZE))
  fi
done

echo ""
echo "---"
TOTAL_TOKENS=$((TOTAL / 4))
GROWTH_PCT=$((TOTAL * 100 / PRE_TUNING_BYTES - 100))
printf "Total:         %6d bytes (~%5d tokens)\n" "$TOTAL" "$TOTAL_TOKENS"
printf "Pre-tuning:    %6d bytes (~%5d tokens)\n" "$PRE_TUNING_BYTES" "$((PRE_TUNING_BYTES / 4))"
printf "Growth:        %+d%% (cap: +20%%)\n" "$GROWTH_PCT"
printf "Budget cap:    %6d bytes (~%5d tokens)\n" "$CAP" "$((CAP / 4))"
printf "Headroom:      %6d bytes\n" "$((CAP - TOTAL))"

if [ "${1:-}" = "--ci" ]; then
  if [ "$TOTAL" -gt "$CAP" ]; then
    echo ""
    echo "FAIL: Token budget exceeded ($TOTAL > $CAP)"
    exit 1
  else
    echo ""
    echo "PASS: Within budget"
  fi
fi
