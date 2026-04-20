#!/bin/bash
# Release script for the dapp3 extension.
# Usage: bash scripts/release.sh <patch|minor|major>
#
# Bumps version in extension/package.json (manifest.json picks it up
# automatically via @crxjs/vite-plugin on the next build), commits from
# the repo root, tags v<version>, and pushes. The release.yml workflow
# builds and attaches the CWS zip when the tag lands.

set -euo pipefail

BUMP_TYPE="${1:-}"
if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: bash scripts/release.sh <patch|minor|major>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXT_DIR/.." && pwd)"

if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

CURRENT_VERSION=$(node -p "require('$EXT_DIR/package.json').version")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

echo "Bumping version: $CURRENT_VERSION → $NEW_VERSION"

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$EXT_DIR/package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('$EXT_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

cd "$REPO_ROOT"
git add extension/package.json
git commit -m "chore: release v$NEW_VERSION"

git tag "v$NEW_VERSION"
git push origin main --tags

echo ""
echo "Released v$NEW_VERSION"
echo "GitHub Actions will build and publish the release."
