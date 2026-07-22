#!/bin/sh
# launch-server.sh — launch the Twining MCP stdio server.
#
# Resolution rungs, probed by EXECUTION (not just `command -v`, so broken
# version-manager shims — asdf/volta/fnm — are cascaded past):
#   1. npx        — `npx --version` succeeds
#                     -> exec npx -y $PKG_SPEC
#   2. npm-prefix — node on PATH and npm's bundled npx CLI exists at
#                   <node bin dir>/../lib/node_modules/npm/bin/npx-cli.js
#                   (Homebrew/nvm layouts; covers npm installed but npx
#                   not linked)
#                     -> exec node <npx-cli.js> -y $PKG_SPEC
#   3. global     — `twining-mcp` on PATH (prior `npm install -g`)
#                     -> exec twining-mcp
#   4. none       — diagnostics to stderr, exit 127
#
# "--probe" (first arg) prints EXACTLY one line to stdout:
#     runner=<npx|npm-prefix|global|none> node=<version|none>
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

RUNNER=none
NPX_CLI=""
resolve_runner() {
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
  RUNNER=none
}

resolve_runner

if [ "$MODE" = probe ]; then
  printf 'runner=%s node=%s\n' "$RUNNER" "$NODE_VERSION"
  exit 0
fi

case "$RUNNER" in
  npx)        exec npx -y "$PKG_SPEC" ;;
  npm-prefix) exec node "$NPX_CLI" -y "$PKG_SPEC" ;;
  global)     exec twining-mcp ;;
esac

# Rung 4: nothing usable — explain to stderr and exit 127.
{
  echo "twining-mcp: cannot launch the MCP server."
  echo ""
  if [ "$NODE_VERSION" != none ]; then
    echo "Node.js $NODE_VERSION was found at: $(command -v node)"
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
  else
    echo "Node.js was not found on PATH."
    echo "Install Node.js >= 22.13 from https://nodejs.org (or fix the PATH"
    echo "exported by your shell profile)."
  fi
  echo ""
  echo "Then restart Claude Code or run /mcp to reconnect."
} >&2
exit 127
