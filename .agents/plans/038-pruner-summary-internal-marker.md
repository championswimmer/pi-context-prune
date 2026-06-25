---
name: 038-pruner-summary-internal-marker
description: Mark pruner summaries as internal context so the agent does not treat them as user requests.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: confirm existing summary emission paths and current display handling"
      - "- [x] step 2: run the existing validation baseline"
  - phase: implementation
    steps:
      - "- [ ] step 1: wrap persisted summary content in an explicit internal context marker"
      - "- [ ] step 2: keep renderer and tree display readable if wrapped summaries are expanded"
  - phase: validation
    steps:
      - "- [ ] step 1: run targeted repository validation"
      - "- [ ] step 2: review the final diff for minimal scope"
---

# 038-pruner-summary-internal-marker

## Phase 1 — Discovery
- [x] step 1: confirm existing summary emission paths and current display handling
- [x] step 2: run the existing validation baseline

## Phase 2 — Implementation
- [ ] step 1: wrap persisted summary content in an explicit internal context marker
- [ ] step 2: keep renderer and tree display readable if wrapped summaries are expanded

## Phase 3 — Validation
- [ ] step 1: run targeted repository validation
- [ ] step 2: review the final diff for minimal scope
