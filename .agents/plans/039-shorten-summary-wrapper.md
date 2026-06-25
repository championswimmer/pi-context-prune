---
name: 039-shorten-summary-wrapper
description: Reduce the internal pruner summary wrapper text so it consumes fewer tokens while preserving internal-context behavior.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current summary wrapper and display unwrapping logic"
      - "- [x] step 2: run the existing validation baseline"
  - phase: implementation
    steps:
      - "- [x] step 1: shorten the persisted wrapper notice text with minimal code changes"
      - "- [x] step 2: keep wrapper parsing and display unwrapping aligned with the shorter notice"
  - phase: validation
    steps:
      - "- [x] step 1: run targeted repository validation after the change"
      - "- [x] step 2: review the final diff and reply on the PR comment"
---

# 039-shorten-summary-wrapper

## Phase 1 — Discovery
- [x] step 1: inspect the current summary wrapper and display unwrapping logic
- [x] step 2: run the existing validation baseline

## Phase 2 — Implementation
- [x] step 1: shorten the persisted wrapper notice text with minimal code changes
- [x] step 2: keep wrapper parsing and display unwrapping aligned with the shorter notice

## Phase 3 — Validation
- [x] step 1: run targeted repository validation after the change
- [x] step 2: review the final diff and reply on the PR comment
