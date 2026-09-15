#!/bin/sh
# launch-cli.sh — run the `twining` CLI from a hook.
#
# Sibling of launch-server.sh, and deliberately a SEPARATE script: the server
# launcher's stdout is the MCP protocol channel and must stay pure, while this
# one's stdout is the HOST'S HOOK CHANNEL and must carry exactly the CLI's hook
# JSON. Same resolution idea, different contract, so they do not share a file.
#
# Resolution rungs, probed by existence + execution:
#   0a. override  — TWINING_CLI_JS names a CLI entry point   -> node "$TWINING_CLI_JS"
#   0b. pin       — ./node_modules/twining-mcp/dist/cli/twining.js (relative to cwd)
#   1.  bundled   — <script dir>/../server/twining-cli.mjs   (shipped with the plugin)
#   2.  global    — `twining` on PATH (prior npm install -g)
#   3.  none      — EXIT 0 SILENTLY
#
# There is deliberately NO npx rung. `twining-mcp@^2.0.0` is the published
# range, and no published version in it carries the `twining` bin or the `hook`
# verb — so an npx rung could only ever fail, after a network round trip, on
# every single hook event. A rung that cannot succeed is not a fallback, it is
# a latency tax with a failure attached. Restore it (as
# `npx -y -p twining-mcp@<version> twining`) once a release ships the CLI.
#
# Rung 4 is the whole safety story. A capture hook that cannot find its own
# binary must behave exactly like a hook that is not installed: no stdout, no
# stderr noise on every single event, exit 0. Breaking a user's session because
# our memory layer could not resolve node is a worse failure than not capturing.
#
# "--probe" prints ONE line and exits 0:
#     runner=<override|pin|bundled|global|none> node=<version|none>

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || SCRIPT_DIR=""
MODE=run
[ "${1:-}" = "--probe" ] && MODE=probe && shift

# Merge the login-shell PATH AHEAD of the inherited one (never replace it):
# GUI-launched hosts get a minimal PATH, and a ~/.profile that assigns PATH
# without a $PATH passthrough must not clobber a PATH that already works.
if [ -z "${TWINING_CLI_NO_PATH_RECOVERY:-}" ]; then
  LOGIN_PATH=$(sh -lc 'printf "@P@%s" "$PATH"' 2>/dev/null) || LOGIN_PATH=""
  LOGIN_PATH=${LOGIN_PATH##*@P@}
  [ -n "$LOGIN_PATH" ] && PATH="$LOGIN_PATH:$PATH"
  export PATH
fi

NODE_V=none
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node --version 2>/dev/null) || NODE_V=none
  case "$NODE_V" in v*) : ;; *) NODE_V=none ;; esac
fi

RUNNER=none
ENTRY=""

if [ -n "${TWINING_CLI_JS:-}" ] && [ -f "${TWINING_CLI_JS}" ] && [ "$NODE_V" != none ]; then
  RUNNER=override
  ENTRY="$TWINING_CLI_JS"
elif [ -f "./node_modules/twining-mcp/dist/cli/twining.js" ] && [ "$NODE_V" != none ]; then
  RUNNER=pin
  ENTRY="./node_modules/twining-mcp/dist/cli/twining.js"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../server/twining-cli.mjs" ] && [ "$NODE_V" != none ]; then
  # TODO(lane 03 follow-up): scripts/build-plugin-bundle.mjs does not yet emit
  # twining-cli.mjs. Until it does this rung never fires for plugin users, and
  # the npx rung carries them. Adding the bundle target is a one-line change to
  # a file this lane does not own.
  RUNNER=bundled
  ENTRY="$SCRIPT_DIR/../server/twining-cli.mjs"
elif command -v twining >/dev/null 2>&1; then
  RUNNER=global
fi

if [ "$MODE" = probe ]; then
  printf 'runner=%s node=%s\n' "$RUNNER" "$NODE_V"
  exit 0
fi

case "$RUNNER" in
  override|pin|bundled) exec node "$ENTRY" "$@" ;;
  global)               exec twining "$@" ;;
  none)                 exit 0 ;;
esac
