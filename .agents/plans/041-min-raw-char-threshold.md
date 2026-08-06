---
name: 041-min-raw-char-threshold
description: Add an opt-in minimum raw tool-output character threshold so batches too small to prune skip the summarizer LLM call entirely.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect flushPending, config, commands, frontier, and tool flows"
      - "- [x] step 2: decide threshold semantics (inclusive, default 0 disabled) and result/progress accounting"
  - phase: implementation
    steps:
      - "- [x] step 1: add minRawCharThreshold config + pre-LLM skip in flushPending"
      - "- [x] step 2: extend FlushResult / frontier outcome and surface in commands, tool, status, help, README/PRUNING/AGENTS"
      - "- [x] step 3: add focused node:test unit tests for the threshold helper"
  - phase: validation
    steps:
      - "- [x] step 1: run check + tests; review full diff for backward compatibility"
      - "- [ ] step 2: open contribution PR once reviewed"
---

# 041-min-raw-char-threshold

## Phase 1 — Discovery
- [x] step 1: inspect flushPending, config, commands, frontier, and tool flows
- [x] step 2: decide threshold semantics (inclusive, default 0 disabled) and result/progress accounting

## Phase 2 — Implementation
- [x] step 1: add minRawCharThreshold config + pre-LLM skip in flushPending
- [x] step 2: extend FlushResult / frontier outcome and surface in commands, tool, status, help, README/PRUNING/AGENTS
- [x] step 3: add focused node:test unit tests for the threshold helper

## Phase 3 — Validation
- [x] step 1: run check + tests; review full diff for backward compatibility
- [ ] step 2: open contribution PR once reviewed
