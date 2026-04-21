---
name: 008-add-settings-mode-guidance
description: Show cache-aware prune mode guidance inside the /pruner settings overlay when choosing the prune trigger.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current settings overlay implementation in src/commands.ts"
      - "- [x] step 2: identify how prune mode guidance is currently expressed in README/help text"
  - phase: implementation
    steps:
      - "- [x] step 1: add reusable prune mode guidance text in src/commands.ts"
      - "- [x] step 2: surface per-mode guidance while cycling prune trigger values in the settings overlay"
      - "- [x] step 3: keep the top-level prune trigger description aligned with the selected mode"
  - phase: validation
    steps:
      - "- [x] step 1: review the updated settings flow for correctness"
      - "- [x] step 2: run a lightweight verification command if available"
---

# 008-add-settings-mode-guidance

## Phase 1 — Discovery
- [x] step 1: inspect the current settings overlay implementation in src/commands.ts
- [x] step 2: identify how prune mode guidance is currently expressed in README/help text

## Phase 2 — Implementation
- [x] step 1: add reusable prune mode guidance text in src/commands.ts
- [x] step 2: surface per-mode guidance while cycling prune trigger values in the settings overlay
- [x] step 3: keep the top-level prune trigger description aligned with the selected mode

## Phase 3 — Validation
- [x] step 1: review the updated settings flow for correctness
- [x] step 2: run a lightweight verification command if available
