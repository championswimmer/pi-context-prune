---
name: 019-skip-oversized-prune-summaries
description: Reject prune summaries that are larger than the raw tool-call content they would replace, while still advancing the prune frontier so later prune attempts only consider newer tool calls.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current flushPending flow, summary persistence path, and pending-batch lifecycle in index.ts"
      - "- [x] step 2: identify where to measure raw prunable character counts versus rendered summary character counts and define the exact comparison rule"
      - "- [x] step 3: design how to persist a prune frontier/last-attempted cutoff so tool calls 1-22 are considered already processed even when a prune attempt is rejected"
  - phase: implementation
    steps:
      - "- [x] step 1: add state and persistence types for the prune frontier so successful and rejected prune attempts both advance the attempted range"
      - "- [x] step 2: update flushPending to compare summary size against the original tool-call payload, skip summary/index writes when the summary is larger, and keep those original tool results unpruned"
      - "- [x] step 3: change capture/queue logic so a later prune request only includes tool calls after the last attempted cutoff instead of retrying the rejected range"
      - "- [x] step 4: add concise user-visible feedback for accepted versus rejected prune attempts so the session state is understandable"
  - phase: validation
    steps:
      - "- [x] step 1: verify a prune attempt with an oversized summary leaves tool results in context but advances the prune frontier"
      - "- [x] step 2: verify the next prune attempt starts after the rejected range and can still prune newer tool calls successfully"
      - "- [x] step 3: run the project build or typecheck and review the diff to confirm the change stays focused"
---

# 019-skip-oversized-prune-summaries

## Phase 1 — Discovery
- [x] step 1: inspect the current flushPending flow, summary persistence path, and pending-batch lifecycle in index.ts
- [x] step 2: identify where to measure raw prunable character counts versus rendered summary character counts and define the exact comparison rule
- [x] step 3: design how to persist a prune frontier/last-attempted cutoff so tool calls 1-22 are considered already processed even when a prune attempt is rejected

## Phase 2 — Implementation
- [x] step 1: add state and persistence types for the prune frontier so successful and rejected prune attempts both advance the attempted range
- [x] step 2: update flushPending to compare summary size against the original tool-call payload, skip summary/index writes when the summary is larger, and keep those original tool results unpruned
- [x] step 3: change capture/queue logic so a later prune request only includes tool calls after the last attempted cutoff instead of retrying the rejected range
- [x] step 4: add concise user-visible feedback for accepted versus rejected prune attempts so the session state is understandable

## Phase 3 — Validation
- [x] step 1: verify a prune attempt with an oversized summary leaves tool results in context but advances the prune frontier
- [x] step 2: verify the next prune attempt starts after the rejected range and can still prune newer tool calls successfully
- [x] step 3: run the project build or typecheck and review the diff to confirm the change stays focused
