#!/usr/bin/env bash
# C28 remote qualification runner (lane 05).
#
# Run this on a SECOND computer. It clones the repo at a given commit, creates
# two independent stores, exchanges events between them over a disposable bare
# git remote (or a shared directory if git is unavailable), runs the C28
# scenario phases as SEPARATE OS PROCESSES, and writes an artifact tarball the
# lead can verify with verify-bundle.ts.
#
# It never touches an existing checkout and never pushes to a real remote:
# everything lives under a work directory it creates and can delete.
#
# Usage:
#   ./run.sh --repo <git-url-or-path> --commit <sha> [--work <dir>] [--carrier git-fs|fs]
set -euo pipefail

REPO=""
COMMIT=""
WORK="${TMPDIR:-/tmp}/c28-$(date +%Y%m%d-%H%M%S)"
CARRIER="git-fs"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --carrier) CARRIER="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$REPO" ] || { echo "--repo is required" >&2; exit 2; }
[ -n "$COMMIT" ] || { echo "--commit is required" >&2; exit 2; }

say() { printf '[c28-run] %s\n' "$*"; }

mkdir -p "$WORK"
SRC="$WORK/src"
RUNDIR="$WORK/run"
mkdir -p "$RUNDIR"

# --------------------------------------------------------------- 1. clone
say "cloning $REPO at $COMMIT into $SRC"
git clone --no-checkout "$REPO" "$SRC"
git -C "$SRC" checkout --detach "$COMMIT"
say "source commit: $(git -C "$SRC" rev-parse HEAD)"

# --------------------------------------------------------------- 2. deps
say "installing dependencies (npm ci)"
( cd "$SRC" && npm ci --no-audit --no-fund )

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "WARNING: node $(node -v) — the v3 event store needs node:sqlite (>= 22.13). The run will fail."
fi

# --------------------------------------------------- 3. carrier disposition
GIT_TRANSPORT="$SRC/src/exchange/git-transport.ts"
if [ -f "$GIT_TRANSPORT" ]; then
  say "DISPOSITION: src/exchange/git-transport.ts IS present in this commit."
  say "             This runner still drives the fs carrier; the dedicated Git"
  say "             transport (ADR 8.2 exchange ref, dirty-tree guarantee,"
  say "             commit-sha receipts) is NOT exercised here. Report it as"
  say "             untested by this bundle."
else
  say "DISPOSITION: src/exchange/git-transport.ts is ABSENT in this commit."
  say "             The Git carrier of ADR 8.2 does not exist yet, so this run"
  say "             uses the fs carrier. With --carrier git-fs the carrier"
  say "             DIRECTORY is itself a git working tree pushed to a"
  say "             disposable bare remote, so the event bytes really do travel"
  say "             through git objects - but the exchange-ref topology and the"
  say "             commit-sha receipts remain untested."
fi

CARRIER_DIR="$RUNDIR/carrier"
mkdir -p "$CARRIER_DIR"

if [ "$CARRIER" = "git-fs" ]; then
  BARE="$WORK/remote.git"
  say "creating disposable bare remote at $BARE"
  git init --bare --quiet "$BARE"
  git init --quiet "$CARRIER_DIR"
  git -C "$CARRIER_DIR" remote add origin "$BARE"
  git -C "$CARRIER_DIR" config user.email "c28@example.invalid"
  git -C "$CARRIER_DIR" config user.name "C28 Qualification"
  # a second clone stands in for the consuming machine's view of the remote
  CONSUMER_CLONE="$RUNDIR/carrier-consumer"
fi

SCENARIO="$SRC/scripts/qualify/c28-remote/c28-scenario.ts"
runphase() {
  say "phase: $1"
  ( cd "$SRC" && npx tsx "$SCENARIO" "$1" --work "$RUNDIR" --carrier "$CARRIER" )
}

# ------------------------------------------------------------- 4. phases
runphase seed
runphase publish

if [ "$CARRIER" = "git-fs" ]; then
  say "pushing the carrier through the disposable bare remote"
  git -C "$CARRIER_DIR" add -A
  git -C "$CARRIER_DIR" commit --quiet -m "c28 carrier publish"
  git -C "$CARRIER_DIR" push --quiet -u origin HEAD:refs/heads/c28
  rm -rf "$CONSUMER_CLONE"
  git clone --quiet --branch c28 "$BARE" "$CONSUMER_CLONE"
  say "carrier round-tripped through git; consumer clone at $CONSUMER_CLONE"
  # the consumer reads the clone, not the producer's directory
  rm -rf "$CARRIER_DIR.producer"
  mv "$CARRIER_DIR" "$CARRIER_DIR.producer"
  rm -rf "$CARRIER_DIR"
  cp -R "$CONSUMER_CLONE" "$CARRIER_DIR"
  rm -rf "$CARRIER_DIR/.git"
fi

runphase poll
runphase rebuild
runphase assert
runphase bundle

# --------------------------------------------------------------- 5. tarball
STAMP="$(date +%Y%m%d-%H%M%S)"
TAR="$WORK/c28-bundle-$STAMP.tar.gz"
tar -czf "$TAR" -C "$RUNDIR" bundle
say "artifact bundle: $TAR"
say "sha256: $(shasum -a 256 "$TAR" | cut -d' ' -f1)"
say ""
say "Send the tarball back to the lead. Verify it with:"
say "  npx tsx scripts/qualify/c28-remote/verify-bundle.ts $TAR"
say ""
say "REMINDER: read bundle/meta.json topology.declaration before quoting any"
say "result. If both halves did NOT run on two physical machines, C28 is"
say "UNAVAILABLE, not PASSED."
