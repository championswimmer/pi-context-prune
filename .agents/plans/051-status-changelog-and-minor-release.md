---
name: 051-status-changelog-and-minor-release
description: Record already-landed status improvements through a PR and release version 2.2.0.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: verify clean main, current version, and tag-driven release workflow"
  - phase: changelog
    steps:
      - "- [x] step 1: create and merge a changelog PR referencing the existing feature commit"
  - phase: release
    steps:
      - "- [ ] step 1: run the minor release helper and verify publication"
---

# 051-status-changelog-and-minor-release

## Discovery
- [x] step 1: verify clean main, current version, and tag-driven release workflow

## Changelog
- [x] step 1: create and merge a changelog PR referencing the existing feature commit

Feature commit `af4321f` is already on main. Preserve history: create a documentation PR describing its changes rather than reverting and reapplying code. Include the PR in generated GitHub release notes.

## Release
- [ ] step 1: run the minor release helper and verify publication

Use `.agents/skills/release/scripts/release.sh minor` (2.1.0 → 2.2.0). The tag-driven GitHub Actions workflow publishes to npm; do not publish locally.
