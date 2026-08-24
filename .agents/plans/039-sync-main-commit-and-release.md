---
name: 039-sync-main-commit-and-release
description: Sync local work with origin/main, commit the pruner notice and summarizer fixes, push to main, and create the next minor release tag from the latest tagged release.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect repo state, current branch, remotes, release workflow, and latest tags"
      - "- [ ] step 2: determine the correct next release version from the latest tagged release"
  - phase: implementation
    steps:
      - "- [ ] step 1: sync local work onto the latest origin/main state without losing the fixes"
      - "- [ ] step 2: commit the code and doc changes on main and push them"
      - "- [ ] step 3: bump to the next minor version, create the tag, and push the release"
  - phase: validation
    steps:
      - "- [ ] step 1: verify the branch, commit history, and pushed tag"
      - "- [ ] step 2: confirm the working tree is clean after release"
---

# 039-sync-main-commit-and-release

## Phase 1 — Discovery
- [x] step 1: inspect repo state, current branch, remotes, release workflow, and latest tags
- [ ] step 2: determine the correct next release version from the latest tagged release

## Phase 2 — Implementation
- [ ] step 1: sync local work onto the latest origin/main state without losing the fixes
- [ ] step 2: commit the code and doc changes on main and push them
- [ ] step 3: bump to the next minor version, create the tag, and push the release

## Phase 3 — Validation
- [ ] step 1: verify the branch, commit history, and pushed tag
- [ ] step 2: confirm the working tree is clean after release
