---
name: 014-fix-stale-context-flush
description: Fix stale extension context errors when pending prune batches flush near the end of an agent run.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: reproduce stale context errors in live Pi print-mode runs"
      - "- [x] step 2: inspect flushPending callers and Pi session persistence boundaries"
      - "- [x] step 3: identify which prune modes need runtime delivery versus session delivery"
  - phase: implementation
    steps:
      - "- [x] step 1: make flushPending return structured success and failure results"
      - "- [x] step 2: guard concurrent flushes and restore pending batches on retry-safe failures"
      - "- [x] step 3: use runtime delivery for active tool-loop flushes"
      - "- [x] step 4: use captured session persistence for final-message flushes"
      - "- [x] step 5: avoid queuing context_prune housekeeping results"
      - "- [x] step 6: preserve captured tool arguments from input, args, or arguments fields"
  - phase: validation
    steps:
      - "- [x] step 1: run TypeScript and diff hygiene checks"
      - "- [x] step 2: verify agentic-auto pruning in live Pi"
      - "- [x] step 3: verify agent-message pruning in live Pi"
      - "- [x] step 4: verify every-turn pruning in live Pi"
      - "- [x] step 5: verify context_tree_query recovers pruned output"
---

# 014-fix-stale-context-flush

## Phase 1 — Discovery
- [x] step 1: reproduce stale context errors in live Pi print-mode runs
- [x] step 2: inspect `flushPending` callers and Pi session persistence boundaries
- [x] step 3: identify which prune modes need runtime delivery versus session delivery

## Phase 2 — Implementation
- [x] step 1: make `flushPending` return structured success and failure results
- [x] step 2: guard concurrent flushes and restore pending batches on retry-safe failures
- [x] step 3: use runtime delivery for active tool-loop flushes
- [x] step 4: use captured session persistence for final-message flushes
- [x] step 5: avoid queuing `context_prune` housekeeping results
- [x] step 6: preserve captured tool arguments from `input`, `args`, or `arguments` fields

## Phase 3 — Validation
- [x] step 1: run TypeScript and diff hygiene checks
- [x] step 2: verify `agentic-auto` pruning in live Pi
- [x] step 3: verify `agent-message` pruning in live Pi
- [x] step 4: verify `every-turn` pruning in live Pi
- [x] step 5: verify `context_tree_query` recovers pruned output
