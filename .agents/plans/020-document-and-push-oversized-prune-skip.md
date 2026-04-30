---
name: 020-document-and-push-oversized-prune-skip
description: Document the oversized-summary skip behavior in the README, then commit and push the completed pruning changes to main.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the README sections that describe pruning behavior and architecture so the new note lands in the right place"
      - "- [x] step 2: confirm the current git branch and working tree state before documenting and committing"
  - phase: implementation
    steps:
      - "- [x] step 1: add a README note explaining that oversized summaries are skipped, original tool results remain, and the prune frontier still advances"
      - "- [x] step 2: update any nearby architecture notes that should mention the prune frontier persistence"
  - phase: validation
    steps:
      - "- [x] step 1: review the README diff together with the code changes for consistency"
      - "- [x] step 2: commit the pruning and README changes with a focused commit message"
      - "- [x] step 3: push the commit to the main branch"
---

# 020-document-and-push-oversized-prune-skip

## Phase 1 — Discovery
- [x] step 1: inspect the README sections that describe pruning behavior and architecture so the new note lands in the right place
- [x] step 2: confirm the current git branch and working tree state before documenting and committing

## Phase 2 — Implementation
- [x] step 1: add a README note explaining that oversized summaries are skipped, original tool results remain, and the prune frontier still advances
- [x] step 2: update any nearby architecture notes that should mention the prune frontier persistence

## Phase 3 — Validation
- [x] step 1: review the README diff together with the code changes for consistency
- [x] step 2: commit the pruning and README changes with a focused commit message
- [x] step 3: push the commit to the main branch
