---
name: 015-test-context-prune-with-batch-tool-calls
description: Exercise the extension with a representative batch of tool calls, then prune and verify recovery.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the repository files relevant to the pruning flow"
      - "- [x] step 2: identify a small set of safe read-only checks to generate tool activity"
  - phase: execution
    steps:
      - "- [x] step 1: perform a batch of read-only tool calls across the project"
      - "- [x] step 2: call context_prune after the batch"
      - "- [x] step 3: recover at least one pruned tool result with context_tree_query"
  - phase: validation
    steps:
      - "- [x] step 1: summarize what was pruned and what was recovered"
---

# 015-test-context-prune-with-batch-tool-calls

## Phase 1 — Discovery
- [x] step 1: inspect the repository files relevant to the pruning flow
- [x] step 2: identify a small set of safe read-only checks to generate tool activity

## Phase 2 — Execution
- [x] step 1: perform a batch of read-only tool calls across the project
- [x] step 2: call context_prune after the batch
- [x] step 3: recover at least one pruned tool result with context_tree_query

## Phase 3 — Validation
- [x] step 1: summarize what was pruned and what was recovered
