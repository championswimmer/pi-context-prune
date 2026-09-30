---
name: 047-simplify-pi-stats-usage-reporting
description: Remove the pruner's redundant pi-stats sidecar usage writer now that pi-stats reads Pi usage entries directly without double counting, then verify, commit, and release a new minor version.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the extension's current usage-reporting code and find every sidecar-related reference"
      - "- [x] step 2: inspect the commit that introduced the sidecar writer and the installed pi-stats changelog/README for the new de-duplication behavior"
  - phase: implementation
    steps:
      - "- [x] step 1: remove src/usage-log.ts and simplify src/usage-report.ts to record only Pi usage entries via appendUsage"
      - "- [x] step 2: remove or update all docs, comments, and tests that still describe the sidecar writer or old double-counting caveats"
      - "- [x] step 3: keep the implementation and public docs aligned with the new single-channel accounting model"
  - phase: validation
    steps:
      - "- [x] step 1: run the test/build/check suite and fix any regressions"
      - "- [x] step 2: review the final diff for consistency and ensure the working tree is clean except for intended changes"
  - phase: release
    steps:
      - "- [x] step 1: commit the simplification with a clear message and push main"
      - "- [x] step 2: run the repository release flow for a minor version bump and push the new tag"
---

# 047-simplify-pi-stats-usage-reporting

## Phase 1 — Discovery
- [x] step 1: inspect the extension's current usage-reporting code and find every sidecar-related reference
- [x] step 2: inspect the commit that introduced the sidecar writer and the installed pi-stats changelog/README for the new de-duplication behavior

## Phase 2 — Implementation
- [x] step 1: remove src/usage-log.ts and simplify src/usage-report.ts to record only Pi usage entries via appendUsage
- [x] step 2: remove or update all docs, comments, and tests that still describe the sidecar writer or old double-counting caveats
- [x] step 3: keep the implementation and public docs aligned with the new single-channel accounting model

## Phase 3 — Validation
- [x] step 1: run the test/build/check suite and fix any regressions
- [x] step 2: review the final diff for consistency and ensure the working tree is clean except for intended changes

## Phase 4 — Release
- [x] step 1: commit the simplification with a clear message and push main
- [x] step 2: run the repository release flow for a minor version bump and push the new tag
