---
name: 037-install-peer-deps-and-verify
description: Install the missing peer dependencies needed for local validation, then rerun type checking and a minimal runtime verification command.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current dependency state and identify the missing peer packages"
      - "- [x] step 2: choose the least invasive install approach for local verification"
  - phase: implementation
    steps:
      - "- [x] step 1: install the missing peer dependencies into the local repo"
      - "- [x] step 2: confirm the dependency tree is in a sane state for validation"
  - phase: validation
    steps:
      - "- [x] step 1: rerun TypeScript validation with the installed peers"
      - "- [x] step 2: run a minimal runtime smoke check and capture the result"
---

# 037-install-peer-deps-and-verify

## Phase 1 — Discovery
- [x] step 1: inspect the current dependency state and identify the missing peer packages
- [x] step 2: choose the least invasive install approach for local verification

## Phase 2 — Implementation
- [x] step 1: install the missing peer dependencies into the local repo
- [x] step 2: confirm the dependency tree is in a sane state for validation

## Phase 3 — Validation
- [x] step 1: rerun TypeScript validation with the installed peers
- [x] step 2: run a minimal runtime smoke check and capture the result
