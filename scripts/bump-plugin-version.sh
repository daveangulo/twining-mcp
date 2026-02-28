#!/usr/bin/env bash
set -euo pipefail

# Bump the plugin version in both marketplace.json and plugin.json
# Usage: bump-plugin-version.sh <version|patch|minor|major>

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
PLUGIN_JSON="$REPO_ROOT/plugin/.claude-plugin/plugin.json"

usage() {
  echo "Usage: $0 <version|patch|minor|major>"
  echo ""
  echo "Examples:"
  echo "  $0 1.2.0    # Set exact version"
  echo "  $0 patch    # 1.0.0 -> 1.0.1"
  echo "  $0 minor    # 1.0.0 -> 1.1.0"
  echo "  $0 major    # 1.0.0 -> 2.0.0"
  exit 1
}

[[ $# -eq 1 ]] || usage

# Read current version from plugin.json (source of truth)
CURRENT=$(grep '"version"' "$PLUGIN_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

if [[ -z "$CURRENT" ]]; then
  echo "Error: could not read current version from $PLUGIN_JSON"
  exit 1
fi

IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT"

case "$1" in
  patch)
    NEW_VERSION="$CUR_MAJOR.$CUR_MINOR.$((CUR_PATCH + 1))"
    ;;
  minor)
    NEW_VERSION="$CUR_MAJOR.$((CUR_MINOR + 1)).0"
    ;;
  major)
    NEW_VERSION="$((CUR_MAJOR + 1)).0.0"
    ;;
  *)
    # Validate semver format
    if [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Error: '$1' is not a valid semver version (expected X.Y.Z)"
      exit 1
    fi
    NEW_VERSION="$1"
    ;;
esac

if [[ "$CURRENT" == "$NEW_VERSION" ]]; then
  echo "Version is already $CURRENT — nothing to do."
  exit 0
fi

# Update both files using sed (works on both macOS and Linux)
sed -i.bak "s/\"version\": *\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$MARKETPLACE_JSON"
sed -i.bak "s/\"version\": *\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$PLUGIN_JSON"

# Clean up backup files
rm -f "$MARKETPLACE_JSON.bak" "$PLUGIN_JSON.bak"

echo "Plugin version bumped: $CURRENT -> $NEW_VERSION"
echo ""
echo "Updated files:"
echo "  .claude-plugin/marketplace.json"
echo "  plugin/.claude-plugin/plugin.json"
