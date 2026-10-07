#!/usr/bin/env bash
# Observe what a synthetic Twining session actually connects to (lane 05).
#
# Records DNS resolutions and TCP connections made by a driven session, so the
# data-flow document rests on observed traffic rather than configuration values
# (C28 A24, R18).
#
# READ docs/operations/data-flow.md section 5 before quoting the output.
# In short: this proves what the EXERCISED path did on THIS machine. It cannot
# prove absence in general, it is not a sandbox, and it records destinations,
# not payloads.
#
# Usage:
#   scripts/measure/observe-traffic.sh [--out <dir>] [--warm] [--duration <sec>]
#
#   --warm      do NOT clear the model cache (observe a warm-cache session)
#   --duration  how long to let the session run (default 45)
set -euo pipefail

OUT="${TMPDIR:-/tmp}/twining-traffic-$(date +%Y%m%d-%H%M%S)"
WARM=0
DURATION=45

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --warm) WARM=1; shift ;;
    --duration) DURATION="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"
REPORT="$OUT/report.md"
say() { printf '[traffic] %s\n' "$*"; }

# ------------------------------------------------------------ capabilities
HAVE_LSOF=0; command -v lsof >/dev/null 2>&1 && HAVE_LSOF=1
HAVE_DTRACE=0; command -v dtruss >/dev/null 2>&1 && HAVE_DTRACE=1
HAVE_TCPDUMP=0; command -v tcpdump >/dev/null 2>&1 && HAVE_TCPDUMP=1
HAVE_NETTOP=0; command -v nettop >/dev/null 2>&1 && HAVE_NETTOP=1

say "capabilities: lsof=$HAVE_LSOF dtruss=$HAVE_DTRACE tcpdump=$HAVE_TCPDUMP nettop=$HAVE_NETTOP"
say "note: dtruss and tcpdump need root and, on macOS, System Integrity Protection"
say "      blocks dtruss against system binaries. lsof polling is the portable,"
say "      unprivileged instrument and is what this script relies on."

# ------------------------------------------------------- synthetic workload
WORKDIR="$OUT/project"
mkdir -p "$WORKDIR/.twining"
if [ "$WARM" -eq 0 ]; then
  rm -rf "$WORKDIR/.twining/models"
  say "model cache cleared - a first-use download, if one is attempted, will be visible"
else
  say "warm mode: the model cache is left as-is"
fi

# Resolve the repo root from this script's own location, not from the work dir.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
say "repo root: $REPO_ROOT"

cat > "$OUT/session.mts" <<JSEOF
// Synthetic session: initialise the embedder the way the MCP server does -
// WITHOUT the offline flag, which is the server default (see F-OFFLINE in
// docs/operations/data-flow.md). If a first-use model download is going to
// happen, this is where it happens.
const projectRoot = process.argv[2];
try {
  const mod = await import("$REPO_ROOT/src/embeddings/embedder.ts");
  const Ctor = mod.Embedder ?? mod.default;
  const e = new Ctor({ twiningDir: projectRoot + "/.twining" });
  if (typeof e.embed === "function") await e.embed("synthetic probe text");
  else if (typeof e.initialize === "function") await e.initialize();
  console.log("[session] embedder path exercised");
} catch (err) {
  console.log("[session] embedder path unavailable:", String(err).slice(0, 300));
}
try {
  const { createTwiningContext } = await import("$REPO_ROOT/src/core/context.ts");
  createTwiningContext(projectRoot);
  console.log("[session] context created (offline flag NOT set - the server default)");
} catch (err) {
  console.log("[session] context path unavailable:", String(err).slice(0, 300));
}
JSEOF

say "starting the synthetic session"
( cd "$REPO_ROOT" && VITEST= npx tsx "$OUT/session.mts" "$WORKDIR" > "$OUT/session.log" 2>&1 ) &
SESSION_PID=$!

# ------------------------------------------------------------- observation
CONNS="$OUT/connections.txt"
: > "$CONNS"
END=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$END" ]; do
  if kill -0 "$SESSION_PID" 2>/dev/null; then
    if [ "$HAVE_LSOF" -eq 1 ]; then
      # every IP socket owned by the session's process tree
      lsof -n -P -i -a -p "$(pgrep -P "$SESSION_PID" -d, 2>/dev/null || echo "$SESSION_PID")" 2>/dev/null >> "$CONNS" || true
      lsof -n -P -i -a -p "$SESSION_PID" 2>/dev/null >> "$CONNS" || true
    fi
  else
    break
  fi
  sleep 0.5
done
wait "$SESSION_PID" 2>/dev/null || true

# -------------------------------------------------------------- summarise
REMOTE=$(grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+|\[[0-9a-f:]+\]:[0-9]+' "$CONNS" 2>/dev/null \
  | grep -vE '^(127\.|\[::1\]|0\.0\.0\.0)' | sort -u || true)
HOSTS=$(grep -oE '\-> *[A-Za-z0-9._-]+:[0-9]+' "$CONNS" 2>/dev/null | sed 's/-> *//' | sort -u || true)

{
  echo "# Observed traffic — synthetic Twining session"
  echo
  echo "- generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- host: $(uname -srm)"
  echo "- node: $(node -v)"
  echo "- mode: $([ "$WARM" -eq 1 ] && echo 'warm model cache' || echo 'cold model cache (download forced if attempted)')"
  echo "- duration: ${DURATION}s"
  echo "- instrument: lsof polling at 2 Hz over the session process tree"
  echo
  echo "## Non-loopback endpoints observed"
  echo
  if [ -n "$REMOTE" ] || [ -n "$HOSTS" ]; then
    echo '```'
    [ -n "$HOSTS" ] && echo "$HOSTS"
    [ -n "$REMOTE" ] && echo "$REMOTE"
    echo '```'
  else
    echo "_none observed during the sampled window_"
  fi
  echo
  echo "## What this does and does not prove"
  echo
  echo "Proves: for the code path this session exercised, on this machine, with this"
  echo "configuration, the process tree held (or did not hold) sockets to the endpoints"
  echo "listed above during the sampled window."
  echo
  echo "Does NOT prove:"
  echo
  echo "1. **Absence in general.** A 2 Hz poll can miss a connection that opens and"
  echo "   closes between samples. An empty list is weak evidence, not proof."
  echo "2. **That other paths are clean.** Only the driven path was observed."
  echo "3. **Payload safety.** Destinations are recorded; contents are not. Showing that"
  echo "   no credential or memory content left the machine needs a TLS intercept proxy,"
  echo "   which is deliberately out of scope because it changes what is measured."
  echo "4. **Enforcement.** This script observes; it does not block. macOS offers no"
  echo "   unprivileged per-process network namespace, so there is no sandbox here."
  echo "5. **Detached subprocesses** and anything a host adapter does on Twining's behalf"
  echo "   are outside the observed process tree."
  echo
  echo "## Session log"
  echo
  echo '```'
  cat "$OUT/session.log" 2>/dev/null || echo "(no session log)"
  echo '```'
  echo
  echo "## Raw lsof samples"
  echo
  echo "\`$CONNS\` ($(wc -l < "$CONNS" | tr -d ' ') lines)"
} > "$REPORT"

say "report: $REPORT"
if [ -n "$REMOTE$HOSTS" ]; then
  say "NON-LOOPBACK ENDPOINTS OBSERVED — see the report"
else
  say "no non-loopback endpoints observed in the sampled window (weak evidence; read the caveats)"
fi
