---
name: 020-prune-frontier-and-per-turn-batches
description: Investigate why a second `/pruner now` reports `empty` after a prior successful prune, and ensure each turn's tool calls become its own independent summary when many turns are pruned in one go.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: dry-run the capture → trim → flush flow for a session that has already been pruned once"
      - "- [x] step 2: identify why `flushPending` returns `empty` on the second call"
      - "- [x] step 3: confirm how multi-turn batches are currently merged into a single summary"
  - phase: design
    steps:
      - "- [x] step 1: decide on a stable turn identifier that survives prior prunes"
      - "- [x] step 2: decide how to keep one summary per turn while still using a single LLM call"
      - "- [x] step 3: spell out frontier-comparison and persistence changes"
  - phase: implementation
    steps:
      - "- [x] step 1 (Bug A): fix `captureUnindexedBatchesFromSession` — stable `turnIndex` via unconditional counter"
      - "- [x] step 2a (Bug B): rewrite `summarizeBatches` to run one LLM call per batch in parallel"
      - "- [x] step 2b (Bug B): rewrite `flushPending` to loop over per-batch results and write one summary message per turn"
  - phase: validation-plan
    steps:
      - "- [x] step 1: define manual repro steps for the empty-flush bug"
      - "- [x] step 2: define the expected per-turn summary layout for a multi-turn prune"
---

# 020 — Prune frontier mismatch and per-turn batch separation

## Phase 1 — Discovery ✅

### Bug A — `empty` on subsequent `/pruner now`

**Root cause identified:** `captureUnindexedBatchesFromSession` assigned `turnIndex` via a local
counter that only incremented for assistant messages with *currently-prunable* tool calls.
After a first prune, already-summarized turns no longer incremented the counter, so the next
new turn always got `turnIndex = 0`. When the persisted frontier's `lastAttemptedTurnIndex ≥ 1`
(any multi-turn first prune), `trimBatchToPendingRange` saw `0 < frontier` and discarded every
new batch → `{ ok: false, reason: "empty" }`.

### Bug B — Multi-turn prune produces merged summary

**Root cause identified:** `summarizeBatches` concatenated all batches into one prompt →
one `summaryText` → one `context-prune-summary` message. Tool calls from different turns were
bundled under a single `details.turnIndex = batches[0].turnIndex`.

### Phase 1 checklist
- [x] step 1: dry-run the capture → trim → flush flow for a session that has already been pruned once
- [x] step 2: identify why `flushPending` returns `empty` on the second call
- [x] step 3: confirm how multi-turn batches are currently merged into a single summary

## Phase 2 — Design ✅

### D1. Stable turn identifier → **unconditional counter**

`captureUnindexedBatchesFromSession` now increments `turnCounter` for **every** assistant
message in the branch (pruned or not), storing it as `currentTurnIndex` before the prunable
filter. This matches Pi's own `event.turnIndex` numbering and survives prior prunes.

### D2. Per-turn summary messages → **parallel-per-batch calls**

`summarizeBatches` runs one `summarizeBatch()` call per batch via `Promise.all`, returning
`Array<SummarizeResult | null>`. No delimiter parsing required; each result is an independent
summary. `flushPending` loops over results in order, writing one `context-prune-summary`
message per turn with its own `details.turnIndex` and `details.toolCallIds`.

### D3. Frontier → **advance to last processed batch**

Frontier advances after the processing loop to the last batch that was successfully
persisted (or skipped-oversized). Stop-at-first-failure ensures frontier never jumps
past an unprocessed batch.

### Phase 2 checklist
- [x] step 1: decide on a stable turn identifier that survives prior prunes
- [x] step 2: decide how to keep one summary per turn while still using a single LLM call
- [x] step 3: spell out frontier-comparison and persistence changes

## Phase 3 — Implementation ✅

### Commits on `arnav/fix-prune`

| Commit | Change |
|--------|--------|
| `6e14c5e` | plan: add investigation plan |
| `6848542` | fix(bug-a): stable turnIndex — `turnCounter++` now unconditional |
| `dbc52ea` | fix(bug-b): per-turn summaries — parallel calls + per-batch loop in flushPending |

### Phase 3 checklist
- [x] step 1 (Bug A): fix `captureUnindexedBatchesFromSession` — stable `turnIndex` via unconditional counter
- [x] step 2a (Bug B): rewrite `summarizeBatches` to run one LLM call per batch in parallel
- [x] step 2b (Bug B): rewrite `flushPending` to loop over per-batch results and write one summary message per turn

## Phase 4 — Validation plan

### V1. Repro for Bug A
1. Start a fresh Pi session, `/pruner on`, `/pruner prune-on on-demand`.
2. Have the agent run two distinct multi-tool turns (turn A: 3 tool calls, turn B: 3 tool calls).
3. `/pruner now` → expect 2 summary messages (one per turn), frontier at turn B.
4. Have the agent run two more multi-tool turns C and D.
5. `/pruner now` → **before fix**: `empty`. **After fix**: 2 more summary messages for C and D.

### V2. Per-turn summary layout
After step 5 above, inspect via `/pruner tree`:
- Expect 4 top-level summary nodes, one per turn (A, B, C, D).
- Each parent node lists only its own turn's tool calls.
- No node mixes tool calls from multiple turns.
- `context_tree_query` with any individual id still resolves to the full original output.

### Phase 4 checklist
- [x] step 1: define manual repro steps for the empty-flush bug
- [x] step 2: define the expected per-turn summary layout for a multi-turn prune

## Summary of changes

| Bug | Root cause | Fix | Files |
|-----|-----------|-----|-------|
| A — `empty` on 2nd prune | `turnCounter` only counted unpruned turns → indices reset to 0 after prune → frontier check discarded all new batches | Increment `turnCounter` for every assistant message unconditionally | `src/batch-capture.ts` |
| B — merged multi-turn summary | `summarizeBatches` used one merged prompt → one summary message for all turns | Parallel `summarizeBatch` calls; per-batch loop in `flushPending` writes one message per turn | `src/summarizer.ts`, `index.ts` |
