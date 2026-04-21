---
name: 007-update-help-text-cache-guidance
description: Update /pruner help text in src/commands.ts to match the new cache-aware README guidance.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current HELP_TEXT in src/commands.ts"
      - "- [x] step 2: compare it with the updated README guidance"
  - phase: implementation
    steps:
      - "- [x] step 1: update mode descriptions to reflect cache-aware recommendations"
      - "- [x] step 2: note that on-context-tag requires pi-context"
      - "- [x] step 3: mark agent-message as the default and safest cache-wise"
  - phase: validation
    steps:
      - "- [x] step 1: confirm the help text no longer claims every-turn is default"
      - "- [x] step 2: verify links and wording are consistent with README"
---

# 007-update-help-text-cache-guidance

## Phase 1 — Discovery
- [x] step 1: inspect the current HELP_TEXT in src/commands.ts
- [x] step 2: compare it with the updated README guidance

## Phase 2 — Implementation
- [x] step 1: update mode descriptions to reflect cache-aware recommendations
- [x] step 2: note that on-context-tag requires pi-context
- [x] step 3: mark agent-message as the default and safest cache-wise

## Phase 3 — Validation
- [x] step 1: confirm the help text no longer claims every-turn is default
- [x] step 2: verify links and wording are consistent with README
