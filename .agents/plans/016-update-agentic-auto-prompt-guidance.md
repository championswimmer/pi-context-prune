---
name: 016-update-agentic-auto-prompt-guidance
description: Refine the agentic-auto system prompt so it teaches the model to prune cohesive task-local batches at the right cadence without hurting cache behavior.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current agentic-auto prompt and where it is defined"
      - "- [x] step 2: translate the requested pruning heuristics into clearer prompt guidance"
  - phase: implementation
    steps:
      - "- [x] step 1: update the AGENTIC_AUTO_SYSTEM_PROMPT text in src/types.ts"
      - "- [x] step 2: keep the plan checklist in sync with the finished change"
  - phase: validation
    steps:
      - "- [x] step 1: run a build or typecheck to confirm the prompt edit is safe"
      - "- [x] step 2: review the diff for scope and preserve unrelated user changes"
      - "- [x] step 3: commit and push the change to main"
---

# 016-update-agentic-auto-prompt-guidance

## Phase 1 — Discovery
- [x] step 1: inspect the current agentic-auto prompt and where it is defined
- [x] step 2: translate the requested pruning heuristics into clearer prompt guidance

## Phase 2 — Implementation
- [x] step 1: update the AGENTIC_AUTO_SYSTEM_PROMPT text in src/types.ts
- [x] step 2: keep the plan checklist in sync with the finished change

## Phase 3 — Validation
- [x] step 1: run a build or typecheck to confirm the prompt edit is safe
- [x] step 2: review the diff for scope and preserve unrelated user changes
- [x] step 3: commit and push the change to main
