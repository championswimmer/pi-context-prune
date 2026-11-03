---
name: 050-nerd-font-status-icons
description: Add an opt-in Nerd Font scissors/turn icon setting, verify, and ship both status improvements.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect status helpers, queued notifications, settings, and tests"
  - phase: implementation
    steps:
      - "- [x] step 1: add the labs toggle and shared Unicode/Nerd Font icons"
      - "- [x] step 2: update pending-count rendering, documentation, and regression tests"
  - phase: validation
    steps:
      - "- [x] step 1: validate, review, commit, and push main"
---

# 050-nerd-font-status-icons

## Discovery
- [x] step 1: inspect status helpers, queued notifications, settings, and tests

## Implementation
- [x] step 1: add the labs toggle and shared Unicode/Nerd Font icons
- [x] step 2: update pending-count rendering, documentation, and regression tests

Use `useNerdFontIcons: false` by default so existing terminals retain Unicode support. Unicode scissors U+2702 and clockwise arrow U+21BB; Nerd Font nf-fa-scissors U+F0C4 and nf-fa-refresh U+F021. Render pending counts with a turn icon in both footer paths and queued notices. No change to pruning/count semantics or command names.

## Validation

Verified: `npm run check` passes build, package validation, and all 14 tests. `git diff --check` passes. Changes ship with plan 049's three-way status setting.
- [x] step 1: validate, review, commit, and push main
