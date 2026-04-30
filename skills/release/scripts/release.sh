#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  release.sh [--dry-run] <major|minor|patch>

Examples:
  release.sh patch
  release.sh --dry-run minor
EOF
}

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

BUMP_TYPE="${1:-}"
if [[ -z "$BUMP_TYPE" ]]; then
  usage
  exit 1
fi

case "$BUMP_TYPE" in
  major|minor|patch) ;;
  *)
    echo "error: bump type must be one of: major, minor, patch" >&2
    usage >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is not clean; commit or stash changes before releasing" >&2
    git status --short >&2 || true
    exit 1
  fi
}

if [[ ! -f package.json ]]; then
  echo "error: package.json not found at repo root: $REPO_ROOT" >&2
  exit 1
fi

if [[ ! -f .github/workflows/release.yml ]]; then
  echo "error: expected release workflow .github/workflows/release.yml is missing" >&2
  exit 1
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$DRY_RUN" -eq 0 ]]; then
  require_clean_tree
fi

run git fetch origin

if [[ "$CURRENT_BRANCH" != "main" ]]; then
  run git checkout main
fi

run git pull --ff-only origin main

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Dry run note: working tree is not clean right now; a real release would stop here until it is clean."
  fi
  echo "Current version: $OLD_VERSION"
  echo "Current branch: $CURRENT_BRANCH"
  echo "Dry run only: would run npm run build --if-present"
  echo "Dry run only: would run npm run check --if-present"
  echo "Dry run only: would run npm version $BUMP_TYPE -m 'Release %s'"
  echo "Dry run only: would push main and the generated tag to origin"
  exit 0
fi

run npm run build --if-present
run npm run check --if-present

NEW_TAG="$(npm version "$BUMP_TYPE" -m "Release %s")"
NEW_VERSION="${NEW_TAG#v}"

run git push origin main
run git push origin "$NEW_TAG"

cat <<EOF
Release complete.
Old version: $OLD_VERSION
New version: $NEW_VERSION
Tag: $NEW_TAG
Pushed: origin/main and $NEW_TAG
npm publish: triggered via .github/workflows/release.yml after tag push
EOF
