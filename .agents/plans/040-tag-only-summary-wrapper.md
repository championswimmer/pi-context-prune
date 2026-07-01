---
name: 040-tag-only-summary-wrapper
description: Simplify pruner summary wrapping to use only the context-prune-summary tag while preserving tolerant display unwrapping for older stored summaries.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current wrapper logic and recent wrapper follow-up commits"
      - "- [x] step 2: run the existing validation baseline"
  - phase: implementation
    steps:
      - "- [x] step 1: change persisted summary wrapping to tag-only output"
      - "- [x] step 2: keep display unwrapping compatible with older wrapped summaries"
  - phase: validation
    steps:
      - "- [x] step 1: run targeted repository validation after the change"
      - "- [ ] step 2: review the final diff and reply on the PR comment"
---

# 040-tag-only-summary-wrapper

## Phase 1 — Discovery
- [x] step 1: inspect the current wrapper logic and recent wrapper follow-up commits
- [x] step 2: run the existing validation baseline

## Phase 2 — Implementation
- [x] step 1: change persisted summary wrapping to tag-only output
- [x] step 2: keep display unwrapping compatible with older wrapped summaries

## Phase 3 — Validation
- [x] step 1: run targeted repository validation after the change
- [ ] step 2: review the final diff and reply on the PR comment
