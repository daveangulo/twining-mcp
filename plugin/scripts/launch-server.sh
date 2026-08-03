#!/bin/sh
# launch-server.sh — launch the Twining MCP stdio server.
#
# Resolution rungs, probed by EXECUTION (not just `command -v`, so broken
# version-manager shims — asdf/volta/fnm — are cascaded past):
#   0a. override   — TWINING_SERVER_JS (non-empty) names a server entry
#                    point and node works
#                      -> exec node "$TWINING_SERVER_JS"
#   0b. pin        — the project pins the server:
#                    ./node_modules/twining-mcp/dist/index.js exists
#                    (relative to cwd) and node works. A project pin always
#                    outranks the plugin's bundled copy AND the npm rungs.
#                      -> exec node <pin>
#   1. npx         — `npx --version` succeeds
#                      -> exec npx -y $PKG_SPEC
#   2. npm-prefix  — node on PATH and npm's bundled npx CLI exists at
#                    <node bin dir>/../lib/node_modules/npm/bin/npx-cli.js
#                    (Homebrew/nvm layouts; covers npm installed but npx
#                    not linked)
#                      -> exec node <npx-cli.js> -y $PKG_SPEC
#   3. global      — `twining-mcp` on PATH (prior `npm install -g`)
#                      -> exec twining-mcp
#   4. bundled     — the plugin ships a single-file server bundle at
#                    <script dir>/../server/twining-server.mjs; used when
#                    node works and is >= 22 but no npm/npx/global install
#                    exists. One stderr notice line, then exec.
#                      -> exec node <bundle>
#   5. none        — diagnostics to stderr, exit 127 (only reachable with
#                    no node at all, or node too old for the bundle)
#
# "--probe" (first arg) prints EXACTLY one line to stdout:
#     runner=<override|pin|npx|npm-prefix|global|bundled|none> node=<version|none>
# and always exits 0. This line is a parsing contract consumed by
# plugin/hooks/session-start-context.sh — never change its shape.
#
# STDOUT PURITY: in launch mode stdout is the MCP protocol channel. This
# script must never write to stdout itself; all human-facing messages go
# to stderr. Strictly POSIX sh, and no external binaries beyond the probed
# runtimes themselves (no dirname/sed/grep/cat), so it stays functional
# under minimal PATHs.

PKG_SPEC="twining-mcp@^2.0.0"

# Recover the login-shell PATH ourselves instead of being spawned via
# `sh -lc`: a login shell sources /etc/profile and ~/.profile with stdout
# attached to the MCP protocol channel, so any profile echo/motd would
# corrupt the JSON-RPC stream. Here profile stdout lands INSIDE the command
# substitution, ahead of the @P@ marker, and is stripped off. Falls back to
# the inherited PATH when the login shell fails or yields nothing.
# TWINING_LAUNCH_NO_LOGIN_PATH (non-empty) skips recovery — the test suite
# sets it so shim-PATH sandboxes are not escaped by the real login PATH.
if [ -z "${TWINING_LAUNCH_NO_LOGIN_PATH:-}" ]; then
  P="$(sh -lc 'printf "\n@P@%s" "$PATH"' 2>/dev/null)" || P=""
  case "$P" in
    *@P@*) LOGIN_PATH="${P##*@P@}"
           [ -n "$LOGIN_PATH" ] && PATH="$LOGIN_PATH" && export PATH ;;
  esac
fi

MODE=launch
[ "$1" = "--probe" ] && MODE=probe

NODE_VERSION=none
if command -v node >/dev/null 2>&1; then
  V="$(node --version 2>/dev/null)" || V=""
  # Accept only ^v[0-9.]+$ — a noisy shim that prints extra lines/words would
  # otherwise break the one-line --probe contract.
  case "$V" in
    v*[!v0-9.]*|"") ;;
    v*) NODE_VERSION="$V" ;;
  esac
fi

# Major/minor version, parsed with parameter expansion only (NODE_VERSION may
# be "none"); 0 when unparseable so numeric comparisons stay safe.
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ""|*[!0-9]*) NODE_MAJOR=0 ;;
esac
NODE_MINOR="${NODE_VERSION#v}"
NODE_MINOR="${NODE_MINOR#*.}"
NODE_MINOR="${NODE_MINOR%%.*}"
case "$NODE_MINOR" in
  ""|*[!0-9]*) NODE_MINOR=0 ;;
esac

# The bundled server needs node >= 22.13 (node:sqlite backend; matches the
# package engines floor) — a major-only gate would let 22.0-22.12 silently
# fall back to the files backend.
BUNDLE_NODE_OK=0
if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 13 ]; }; then
  BUNDLE_NODE_OK=1
fi

# Plugin-bundled server, located relative to this script ($0 always carries
# a slash here — .mcp.json and the probe callers use a path — but fall back
# to "." for a bare-name invocation).
case "$0" in
  */*) SCRIPT_DIR="${0%/*}" ;;
  *)   SCRIPT_DIR="." ;;
esac
BUNDLE="$SCRIPT_DIR/../server/twining-server.mjs"

# Project-pinned server install, relative to cwd (the project root when
# Claude Code spawns MCP servers).
PIN="./node_modules/twining-mcp/dist/index.js"

RUNNER=none
NPX_CLI=""
resolve_runner() {
  # Rung 0a: explicit override. The file check keeps probe and launch in
  # agreement — a dangling override path cascades instead of probing healthy
  # and then dying at launch.
  if [ -n "${TWINING_SERVER_JS:-}" ] && [ -f "$TWINING_SERVER_JS" ] && [ "$NODE_VERSION" != none ]; then
    RUNNER=override
    return
  fi
  # Rung 0b: project-pinned install wins over everything else.
  if [ -f "$PIN" ] && [ "$NODE_VERSION" != none ]; then
    RUNNER=pin
    return
  fi
  # Rung 1: working npx on PATH.
  if command -v npx >/dev/null 2>&1 && npx --version >/dev/null 2>&1; then
    RUNNER=npx
    return
  fi
  # Rung 2: node on PATH with npm installed at the conventional prefix
  # (<bin dir>/../lib/node_modules/npm) but npx itself not linked.
  NODE_BIN="$(command -v node 2>/dev/null)"
  if [ -n "$NODE_BIN" ]; then
    NPX_CLI="${NODE_BIN%/*}/../lib/node_modules/npm/bin/npx-cli.js"
    if [ -f "$NPX_CLI" ] && node "$NPX_CLI" --version >/dev/null 2>&1; then
      RUNNER=npm-prefix
      return
    fi
  fi
  # Rung 3: a prior global install of the server itself.
  if command -v twining-mcp >/dev/null 2>&1 && node --version >/dev/null 2>&1; then
    RUNNER=global
    return
  fi
  # Rung 4: the plugin-bundled server (needs node >= 22.13; older node falls
  # through to the rung-5 diagnostic).
  if [ -f "$BUNDLE" ] && [ "$BUNDLE_NODE_OK" -eq 1 ]; then
    RUNNER=bundled
    return
  fi
  RUNNER=none
}

resolve_runner

if [ "$MODE" = probe ]; then
  printf 'runner=%s node=%s\n' "$RUNNER" "$NODE_VERSION"
  exit 0
fi

# Rungs 1-3 need the registry: they resolve and download the package at launch.
# `npx --version` succeeding only proves npx runs — it does NOT prove `npx -y
# twining-mcp` can install. A registry policy (npm's minimumReleaseAge / a
# min-package-age rule), an auth failure, a proxy, or being offline all let the
# probe report healthy and then kill the launch. Because these rungs used to
# `exec`, the shell was replaced and the dependency-free bundled server sitting
# one rung below was never reached — a field project lost Twining entirely this
# way, with the probe reporting runner=npx.
#
# So: run them as a child, and if one dies WITHOUT having served, fall through
# to the bundle. "Without having served" is approximated by elapsed time — a
# resolution failure dies in seconds, whereas a server that actually spoke MCP
# must never be silently restarted (its client handshake is already spent).
NETWORK_RUNG_GRACE="${TWINING_LAUNCH_RUNG_GRACE:-20}"

fallback_to_bundle_or_exit() {
  # $1 = exit code, $2 = elapsed seconds, $3 = what was tried
  if [ "$1" -ne 0 ] &&
     [ "$2" -lt "$NETWORK_RUNG_GRACE" ] &&
     [ -f "$BUNDLE" ] &&
     [ "$BUNDLE_NODE_OK" -eq 1 ]; then
    echo "twining-mcp: $3 exited $1 after ${2}s without serving — the package could not be" >&2
    echo "  resolved (registry policy, auth, proxy, or offline). Falling back to the" >&2
    echo "  plugin-bundled server. Semantic search runs in keyword-fallback mode." >&2
    exec node "$BUNDLE"
  fi
  exit "$1"
}

now_secs() { date +%s 2>/dev/null || echo 0; }

case "$RUNNER" in
  override)   exec node "$TWINING_SERVER_JS" ;;
  pin)        exec node "$PIN" ;;
  npx)
    START="$(now_secs)"
    npx -y "$PKG_SPEC"
    CODE=$?
    fallback_to_bundle_or_exit "$CODE" "$(( $(now_secs) - START ))" "npx -y $PKG_SPEC"
    ;;
  npm-prefix)
    START="$(now_secs)"
    node "$NPX_CLI" -y "$PKG_SPEC"
    CODE=$?
    fallback_to_bundle_or_exit "$CODE" "$(( $(now_secs) - START ))" "npx-cli $PKG_SPEC"
    ;;
  global)
    START="$(now_secs)"
    twining-mcp
    CODE=$?
    fallback_to_bundle_or_exit "$CODE" "$(( $(now_secs) - START ))" "global twining-mcp"
    ;;
  bundled)
    echo "twining-mcp: using the plugin-bundled server (npm/npx not found). Semantic search runs in keyword-fallback mode; install npm, then 'npm i -D twining-mcp' in the project to restore full mode." >&2
    exec node "$BUNDLE"
    ;;
esac

# Rung 5: nothing usable — explain to stderr and exit 127. Reachable with no
# node at all, node too old for the bundled server, or the plugin's bundled
# server file missing (broken plugin install).
{
  echo "twining-mcp: cannot launch the MCP server."
  echo ""
  if [ "$NODE_VERSION" != none ]; then
    echo "Node.js $NODE_VERSION was found at: $(command -v node)"
    if [ "$BUNDLE_NODE_OK" -eq 0 ]; then
      echo "but it is too old: Node.js >= 22.13 is required to run the"
      echo "plugin-bundled server, and no npx/npm/global twining-mcp install"
      echo "was found either."
      echo ""
      echo "Upgrade Node.js from https://nodejs.org (or via your version"
      echo "manager: nvm install 22 / volta install node@22)."
    else
      echo "but there is no way to run npm packages: npx is not on PATH, npm is"
      echo "not installed alongside node, and no global twining-mcp install was"
      echo "found."
      echo ""
      echo "Your Node.js distribution ships without npm (common with Debian/Ubuntu"
      echo "'apt install nodejs', Alpine, and Amazon Linux). Fix with one of:"
      echo "  sudo apt install npm"
      echo "  sudo apk add npm"
      echo "  sudo dnf install nodejs-npm"
      echo "or reinstall Node.js from https://nodejs.org"
      echo ""
      echo "Note: the plugin's bundled fallback server is also missing at:"
      echo "  $BUNDLE"
      echo "Reinstalling the twining plugin restores it."
    fi
  else
    echo "Node.js was not found on PATH."
    echo "Install Node.js >= 22.13 from https://nodejs.org (or fix the PATH"
    echo "exported by your shell profile)."
  fi
  echo ""
  echo "Then restart Claude Code or run /mcp to reconnect."
} >&2
exit 127
