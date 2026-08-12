---
name: 038-fix-summarizer-api
description: Update the summarizer to use the current @earendil-works/pi-ai streaming API, then re-run validation and a smoke test.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current summarizer implementation and identify the broken import/API usage"
      - "- [x] step 2: inspect the installed pi-ai type definitions to find the supported streaming entry point"
  - phase: implementation
    steps:
      - "- [x] step 1: refactor src/summarizer.ts to use the supported pi-ai streaming API"
      - "- [x] step 2: keep progress reporting, abort handling, and usage extraction working after the refactor"
  - phase: validation
    steps:
      - "- [x] step 1: rerun TypeScript validation"
      - "- [x] step 2: run a minimal smoke test to confirm the extension still loads"
---

# 038-fix-summarizer-api

## Phase 1 — Discovery
- [x] step 1: inspect the current summarizer implementation and identify the broken import/API usage
- [x] step 2: inspect the installed pi-ai type definitions to find the supported streaming entry point

## Phase 2 — Implementation
- [x] step 1: refactor src/summarizer.ts to use the supported pi-ai streaming API
- [x] step 2: keep progress reporting, abort handling, and usage extraction working after the refactor

## Phase 3 — Validation
- [x] step 1: rerun TypeScript validation
- [x] step 2: run a minimal smoke test to confirm the extension still loads
