---
name: 045-update-default-pruner-modes
description: Set agentic-auto and agent-message as the default trigger and batching behavior, update user-facing guidance, and open a pull request.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current default config values and related settings/help text"
      - "- [x] step 2: confirm the next available plan filename and identify docs that mention the old defaults"
  - phase: implementation
    steps:
      - "- [x] step 1: update the default prune trigger and batching mode values in the shared config/types"
      - "- [x] step 2: adjust settings and help text to warn that turn batching is only for debugging"
      - "- [x] step 3: refresh README guidance so the documented defaults match the code"
  - phase: validation
    steps:
      - "- [x] step 1: build the package and inspect the final diff"
      - "- [ ] step 2: scan changed files for secrets, run validation, and create the pull request"
---

# 045-update-default-pruner-modes

## Phase 1 — Discovery
- [x] step 1: inspect the current default config values and related settings/help text
- [x] step 2: confirm the next available plan filename and identify docs that mention the old defaults

## Phase 2 — Implementation
- [x] step 1: update the default prune trigger and batching mode values in the shared config/types
- [x] step 2: adjust settings and help text to warn that turn batching is only for debugging
- [x] step 3: refresh README guidance so the documented defaults match the code

## Phase 3 — Validation
- [x] step 1: build the package and inspect the final diff
- [ ] step 2: scan changed files for secrets, run validation, and create the pull request
