---
name: 031-min-raw-threshold-setting-and-skip-flow
description: Add a configurable minimum raw character threshold for pruning batches, using presets Disabled (0), Default (700), and Large (1000), and skip undersized batches before summarization while preserving existing oversized-summary behavior.
steps:
  - phase: implementation
    steps:
      - "- [x] step 1: add minRawCharsToPrune to shared types and default config with values persisted through settings.json"
      - "- [x] step 2: wire the setting into /pruner settings using the agreed presets Disabled (0), Default (700), and Large (1000)"
      - "- [x] step 3: surface the configured threshold in /pruner status and any other existing user-facing config summaries"
      - "- [x] step 4: add the pre-summarization raw-character guard in flushPending after final batch grouping and before summarizer calls"
      - "- [x] step 5: implement the disabled path as an explicit gate so value 0 bypasses the guard entirely"
      - "- [x] step 6: route undersized batches through the existing skip bookkeeping with a distinct reason while preserving frontier advancement and leaving raw tool results in context"
      - "- [x] step 7: update help text and docs to explain the threshold setting, its presets, its motivation, and how it interacts with existing skip-oversized behavior"
  - phase: validation
    steps:
      - "- [ ] step 1: add or update tests covering Disabled (0), Default/Large threshold skips, and normal prune behavior above the threshold"
      - "- [ ] step 2: verify existing oversized-summary skip behavior still works unchanged alongside the new pre-summarization guard"
      - "- [ ] step 3: verify /pruner now and agentic-auto flows report sensible results when batches are skipped as undersized"
      - "- [ ] step 4: run a reproducible verification command and record the outcome in the final report"
---

# 031-min-raw-threshold-setting-and-skip-flow

## Threshold rationale
- **Default = 700 chars:** chosen because the typical summary size we observed for small tool-call batches was roughly **600–700 chars**, so a lower threshold would still send many poor compression candidates to the summarizer.
- **Large = 1000 chars:** offered as a more conservative preset for users who want to prune only clearly larger raw-output batches.
- **Disabled = 0 chars:** keeps the old behavior for users who want the existing post-summary oversized check to be the only guard.

## Alternatives considered
- **Deferred coalescing of tiny batches for later pruning:** rejected for this change because it would alter current batching/frontier semantics and create ambiguity around when previously skipped small batches should be retried.
- **Relying only on the existing skip-oversized check:** rejected because it still pays summarizer cost for obviously tiny batches that are predictably poor candidates for compression.
- **Token-count threshold instead of raw character count:** rejected because token estimation adds extra complexity and precision we do not need for this approximate guard.

## Phase 1 — Implementation
- [x] step 1: add minRawCharsToPrune to shared types and default config with values persisted through settings.json
- [x] step 2: wire the setting into /pruner settings using the agreed presets Disabled (0), Default (700), and Large (1000)
- [x] step 3: surface the configured threshold in /pruner status and any other existing user-facing config summaries
- [x] step 4: add the pre-summarization raw-character guard in flushPending after final batch grouping and before summarizer calls
- [x] step 5: implement the disabled path as an explicit gate so value 0 bypasses the guard entirely
- [x] step 6: route undersized batches through the existing skip bookkeeping with a distinct reason while preserving frontier advancement and leaving raw tool results in context
- [x] step 7: update help text and docs to explain the threshold setting, its presets, its motivation, and how it interacts with existing skip-oversized behavior

## Phase 2 — Validation
- [ ] step 1: add or update tests covering Disabled (0), Default/Large threshold skips, and normal prune behavior above the threshold
- [ ] step 2: verify existing oversized-summary skip behavior still works unchanged alongside the new pre-summarization guard
- [ ] step 3: verify /pruner now and agentic-auto flows report sensible results when batches are skipped as undersized
- [ ] step 4: run a reproducible verification command and record the outcome in the final report
