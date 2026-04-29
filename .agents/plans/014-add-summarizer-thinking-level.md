---
name: 014-add-summarizer-thinking-level
description: Add a configurable thinking level for pruning summarizer calls while preserving existing defaults.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: clone upstream main into an independent worktree and create the feature branch"
      - "- [x] step 2: inspect repo guidance, current config, command, summarizer, and pi-ai reasoning option behavior"
  - phase: implementation
    steps:
      - "- [x] step 1: add summarizer thinking types, defaults, and config validation"
      - "- [x] step 2: pass configured thinking options to summarizer LLM calls"
      - "- [x] step 3: expose the setting through /pruner status, commands, help, and settings overlay"
      - "- [x] step 4: support /pruner model <id>:<thinking> shorthand"
      - "- [x] step 5: document the setting and provider caveats in README"
  - phase: validation
    steps:
      - "- [x] step 1: run TypeScript/static checks and diff whitespace checks"
      - "- [x] step 2: run feasible live Pi checks for default/minimal/invalid settings"
      - "- [x] step 3: review the final diff and update the plan"
---

# 014-add-summarizer-thinking-level

## Phase 1 — Discovery
- [x] step 1: clone upstream main into an independent worktree and create the feature branch
- [x] step 2: inspect repo guidance, current config, command, summarizer, and pi-ai reasoning option behavior

## Phase 2 — Implementation
- [x] step 1: add summarizer thinking types, defaults, and config validation
- [x] step 2: pass configured thinking options to summarizer LLM calls
- [x] step 3: expose the setting through /pruner status, commands, help, and settings overlay
- [x] step 4: support /pruner model <id>:<thinking> shorthand
- [x] step 5: document the setting and provider caveats in README

## Phase 3 — Validation
- [x] step 1: run TypeScript/static checks and diff whitespace checks
- [x] step 2: run feasible live Pi checks for default/minimal/invalid settings
- [x] step 3: review the final diff and update the plan
