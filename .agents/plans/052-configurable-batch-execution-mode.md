---
name: 052-configurable-batch-execution-mode
description: Add a batchExecution setting ("parallel" | "serial", default "parallel") so multi-batch summarization runs concurrently by default and can be switched to serial in /pruner settings.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect issue #33, config, summarizer, flushPending, commands, docs, and tests"
  - phase: implementation
    steps:
      - "- [x] step 1: add BatchExecutionMode type, BATCH_EXECUTION_MODES constant, and batchExecution config field defaulting to parallel"
      - "- [x] step 2: update summarizeBatches and flushPending to honor config.batchExecution and support onProgress in both modes"
      - "- [x] step 3: expose Batch calls in /pruner settings, /pruner status, and help text"
      - "- [x] step 4: update README.md and AGENTS.md documentation"
  - phase: validation
    steps:
      - "- [x] step 1: add regression tests for config persistence/validation and serial vs parallel batch execution"
      - "- [x] step 2: run npm run check and verify git diff"
---

# 052-configurable-batch-execution-mode

## Discovery
- [x] step 1: inspect issue #33, config, summarizer, flushPending, commands, docs, and tests

## Implementation
- [x] step 1: add BatchExecutionMode type, BATCH_EXECUTION_MODES constant, and batchExecution config field defaulting to parallel
- [x] step 2: update summarizeBatches and flushPending to honor config.batchExecution and support onProgress in both modes
- [x] step 3: expose Batch calls in /pruner settings, /pruner status, and help text
- [x] step 4: update README.md and AGENTS.md documentation

## Validation
- [x] step 1: add regression tests for config persistence/validation and serial vs parallel batch execution
- [x] step 2: run npm run check and verify git diff

Verified: `npm run check` passes build, package validation, and all 18 tests; `git diff --check` is clean.
