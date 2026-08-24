---
name: 036-toggle-pruner-notices
description: Add a config setting to enable or disable pruner startup/status notices, wire it through the settings UI, and update docs.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect where pruner notices are emitted and how config/settings are modeled"
      - "- [x] step 2: identify the user-facing docs and status output that should mention the new notice toggle"
  - phase: implementation
    steps:
      - "- [x] step 1: add a persisted config flag for pruner notices with a sensible default"
      - "- [x] step 2: gate startup notices on the new flag and expose the toggle in /pruner settings and status output"
      - "- [x] step 3: update README guidance and config examples for the new setting"
  - phase: validation
    steps:
      - "- [x] step 1: review the diff for consistency across code and docs"
      - "- [x] step 2: run a reproducible verification command for the changed files"
---

# 036-toggle-pruner-notices

## Phase 1 — Discovery
- [x] step 1: inspect where pruner notices are emitted and how config/settings are modeled
- [x] step 2: identify the user-facing docs and status output that should mention the new notice toggle

## Phase 2 — Implementation
- [x] step 1: add a persisted config flag for pruner notices with a sensible default
- [x] step 2: gate startup notices on the new flag and expose the toggle in /pruner settings and status output
- [x] step 3: update README guidance and config examples for the new setting

## Phase 3 — Validation
- [x] step 1: review the diff for consistency across code and docs
- [x] step 2: run a reproducible verification command for the changed files
