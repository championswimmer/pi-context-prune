---
name: 004-add-summarizer-usage-tracking
description: Track token usage and cost of the pruner's summarization LLM calls and display them alongside the existing status widget, similar to how Pi's main footer shows session token/cost stats.
steps:
  - phase: investigation-and-design
    steps:
      - "- [x] step 1: Investigate Pi's AssistantMessage.usage type (input, output, cacheRead, cacheWrite, totalTokens, cost)"
      - "- [x] step 2: Investigate Pi's ctx.ui.setStatus and custom-footer APIs for displaying stats"
      - "- [x] step 3: Verify that complete() from @mariozechner/pi-ai returns usage data"
      - "- [x] step 4: Design the stats accumulator and display approach"
  - phase: types-and-stats-module
    steps:
      - "- [x] step 1: Add SummarizerStats and related types to types.ts"
      - "- [x] step 2: Create src/stats.ts with a StatsAccumulator class for cumulative tracking"
      - "- [x] step 3: Add CUSTOM_TYPE_STATS constant for session persistence"
  - phase: summarizer-integration
    steps:
      - "- [x] step 1: Update summarizeBatch and summarizeBatches to return usage data alongside summary text"
      - "- [x] step 2: Create a SummarizeResult type that carries both text and usage"
  - phase: index-ts-wiring
    steps:
      - "- [x] step 1: Instantiate StatsAccumulator alongside indexer in index.ts"
      - "- [x] step 2: After summarizeBatches call, accumulate usage into StatsAccumulator"
      - "- [x] step 3: Persist stats via pi.appendEntry(CUSTOM_TYPE_STATS, ...) after each flush"
      - "- [x] step 4: Reconstruct stats from session entries in session_start and session_tree handlers"
      - "- [x] step 5: Update status widget text to include token/cost stats"
  - phase: commands-and-display
    steps:
      - "- [x] step 1: Add /pruner stats subcommand to show detailed cumulative stats"
      - "- [x] step 2: Update /pruner status output to include summarizer cost line"
      - "- [x] step 3: Update HELP_TEXT with new subcommand docs"
  - phase: validation
    steps:
      - "- [x] step 1: Verify TypeScript compiles cleanly"
      - "- [x] step 2: Verify existing functionality is not broken"
---

# 004-add-summarizer-usage-tracking ✅ COMPLETE

## Implementation Summary

All 6 phases have been implemented:

### Phase 2 — Types and Stats Module
- Added `SummarizerStats`, `SummarizeResult`, and `CUSTOM_TYPE_STATS` to `types.ts`
- Created `src/stats.ts` with `StatsAccumulator` class (add, getStats, reset, persist, reconstructFromSession) and formatting helpers (`formatTokens`, `formatCost`, `statsSuffix`)

### Phase 3 — Summarizer Integration
- Updated `summarizeBatch` and `summarizeBatches` to return `SummarizeResult | null` instead of `string | null`
- `SummarizeResult` carries both `summaryText` and `usage` from the LLM response

### Phase 4 — Index.ts Wiring
- Instantiated `StatsAccumulator` in `index.ts`
- After `summarizeBatches` call: `statsAccum.add(result.usage)` + `statsAccum.persist(pi)`
- Reconstructed stats from session in `session_start` and `session_tree` handlers
- Status widget now shows: `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003`

### Phase 5 — Commands and Display
- Added `/pruner stats` subcommand for detailed cumulative stats
- Updated `/pruner status` to include summarizer stats section
- Updated `pruneStatusText()` to accept optional `SummarizerStats` and append stats suffix
- Updated `HELP_TEXT` and `SUBCOMMANDS` with new stats command

### Phase 6 — Validation
- Brace balance checks pass for all modified files
- Import chains verified (all imports resolve correctly)
- AGENTS.md updated with new `stats.ts` module documentation