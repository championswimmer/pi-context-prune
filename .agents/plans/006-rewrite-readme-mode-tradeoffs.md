---
name: 006-rewrite-readme-mode-tradeoffs
description: Read the extension, research prompt cache invalidation from context edits, and rewrite README mode guidance with cache-aware tradeoffs and pi-context note.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the repo structure and current README"
      - "- [x] step 2: read the extension entry point and mode-related source files"
  - phase: research
    steps:
      - "- [x] step 1: research prompt/context cache invalidation when earlier context changes between requests"
      - "- [x] step 2: find the pi-context extension reference for context_tag"
  - phase: implementation
    steps:
      - "- [x] step 1: rewrite README prune mode guidance with cache-aware pros and cons"
      - "- [x] step 2: explain why agent-message is the default and why every-turn is mainly for debugging"
      - "- [x] step 3: document that on-context-tag depends on the pi-context extension and link it"
  - phase: validation
    steps:
      - "- [x] step 1: review README for accuracy against the code"
      - "- [x] step 2: summarize the changes and research-backed rationale"
---

# 006-rewrite-readme-mode-tradeoffs

## Phase 1 — Discovery
- [x] step 1: inspect the repo structure and current README
- [x] step 2: read the extension entry point and mode-related source files

## Phase 2 — Research
- [x] step 1: research prompt/context cache invalidation when earlier context changes between requests
- [x] step 2: find the pi-context extension reference for context_tag

## Phase 3 — Implementation
- [x] step 1: rewrite README prune mode guidance with cache-aware pros and cons
- [x] step 2: explain why agent-message is the default and why every-turn is mainly for debugging
- [x] step 3: document that on-context-tag depends on the pi-context extension and link it

## Phase 4 — Validation
- [x] step 1: review README for accuracy against the code
- [x] step 2: summarize the changes and research-backed rationale
