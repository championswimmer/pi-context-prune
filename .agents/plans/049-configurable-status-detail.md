---
name: 049-configurable-status-detail
description: Add hidden, status-only, and status-plus-cost footer choices with a scissors label while preserving existing settings.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect config, settings overlay, footer lifecycle, and extension API"
  - phase: implementation
    steps:
      - "- [x] step 1: add backward-compatible cost visibility, three-way selector, and scissors footer"
      - "- [x] step 2: add regression coverage and update documentation"
  - phase: validation
    steps:
      - "- [x] step 1: run npm run check and review the diff"
---

# 049-configurable-status-detail

## Discovery
- [x] step 1: inspect config, settings overlay, footer lifecycle, and extension API

## Implementation
- [x] step 1: add backward-compatible cost visibility, three-way selector, and scissors footer
- [x] step 2: add regression coverage and update documentation

Keep `showPruneStatusLine` for existing hidden/visible settings; add `showPruneStatusCost` (default true) for optional token/cost detail. The overlay exposes Hidden, Status only, and Status + cost. Queued notifications retain their existing visibility gating. Explicit `/pruner stats` remains unaffected.

## Validation

Verified: `npm run check` passes (build, package check, 12 tests); `git diff --check` passes. Regression tests cover idle/pending/summarizing states, all display modes, settings persistence, and legacy/invalid config defaults.
- [x] step 1: run npm run check and review the diff
