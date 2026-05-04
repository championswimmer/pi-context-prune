---
name: 020-prune-frontier-and-per-turn-batches
description: Investigate why a second `/pruner now` reports `empty` after a prior successful prune, and ensure each turn's tool calls become its own independent summary when many turns are pruned in one go.
steps:
  - phase: discovery
    steps:
      - "- [ ] step 1: dry-run the capture → trim → flush flow for a session that has already been pruned once"
      - "- [ ] step 2: identify why `flushPending` returns `empty` on the second call"
      - "- [ ] step 3: confirm how multi-turn batches are currently merged into a single summary"
  - phase: design
    steps:
      - "- [ ] step 1: decide on a stable turn identifier that survives prior prunes"
      - "- [ ] step 2: decide how to keep one summary per turn while still using a single LLM call"
      - "- [ ] step 3: spell out frontier-comparison and persistence changes"
  - phase: validation-plan
    steps:
      - "- [ ] step 1: define manual repro steps for the empty-flush bug"
      - "- [ ] step 2: define the expected per-turn summary layout for a multi-turn prune"
---

# 020 — Prune frontier mismatch and per-turn batch separation

## Context

User report: after `/pruner now` (or any flush) succeeds once, every subsequent
`/pruner now` returns `Context prune did not run: empty.`, even though more
tool-calling turns have happened since.

User requirement: when pruning across many turns, tool calls **within each turn**
must form one summary, and that summary must **not** be merged with summaries from
other turns. Example timeline:

```
01 < user msg
02 > llm think
03 > llm tool call
04 > llm tool call
05 - tool call result
06 - tool call result
07 > llm message (final text)
08 < user msg
09 > llm think
10 > llm tool call
11 - tool call result
...
```

If prune runs after 07, items 03–06 must be one summary. If prune runs later,
03–06 must remain their own summary, not get merged with 10–11.

## Phase 1 — Discovery (dry run)

### Bug A — `empty` on subsequent `/pruner now`

Trace through `flushPending` in `index.ts` after a first successful prune:

1. `captureUnindexedBatchesFromSession(branch, indexer, [CONTEXT_PRUNE_TOOL_NAME])`
   in `src/batch-capture.ts` walks the branch and assigns `turnIndex` via a
   **local** `turnCounter = 0` that increments **only** when an assistant
   message has at least one ready-to-prune tool call (i.e. unsummarized + has a
   matching result).
2. After the first prune, every old tool call id is in the indexer
   (`isSummarized(id) === true`), so those old assistant messages contribute
   **0** to `turnCounter`. The next still-unsummarized assistant message
   therefore gets `turnIndex = 0` — not its true position in the conversation.
3. The frontier persisted by the first prune holds
   `lastAttemptedTurnIndex = N` (where `N` was that first run's local counter,
   typically `≥ 1` if multiple turns were batched, or `0` for a single-turn
   batch).
4. Back in `flushPending`, `trimBatchToPendingRange` runs:
   ```ts
   if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
   if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };
   // equal → look up lastAttemptedToolCallId inside this batch
   ```
   - If the previous prune covered ≥ 2 turns (frontier turnIndex ≥ 1), the new
     batch comes back with `turnIndex = 0`, which is `< 1`, so the helper
     returns `null` and **every new batch is discarded**.
   - If the previous prune covered only one turn (frontier turnIndex `= 0`),
     the new batch also gets `turnIndex = 0` → equal branch → tries to find
     `lastAttemptedToolCallId` in the new (different) batch, doesn't find it,
     and falls through to `return { ...batch, toolCalls }`. So the
     "single-turn first prune" case happens to work, which is consistent with
     the bug being intermittent / dependent on how many turns were batched.

   Net effect: as soon as any prune covers ≥ 2 turns, every subsequent flush
   sees `batches = []` after `trimBatchToPendingRange` and returns
   `{ ok: false, reason: "empty" }`.

Root cause: `captureUnindexedBatchesFromSession` produces a counter that is
**only stable within a single scan of currently-unsummarized turns**, but the
frontier persists it across scans as if it were a stable identifier of a
position in the conversation.

### Bug B — Per-turn batches are merged into one summary

Trace through the multi-turn prune path:

1. `captureUnindexedBatchesFromSession` produces one `CapturedBatch` per
   assistant message (good — per-turn granularity is preserved up to here).
2. `flushPending` calls `summarizeBatches(batches, …)` in `src/summarizer.ts`.
3. `summarizeBatches` concatenates everything via
   `serializeBatchesForSummarizer` (uses `=== Turn N ===` headers but the
   whole thing is one prompt) and produces **one** `summaryText`.
4. `flushPending` writes that as **one** `context-prune-summary` message
   whose `details.toolCallIds` is the flat union of all batches' ids and
   whose `details.turnIndex` is `batches[0].turnIndex` (the first turn only).

Net effect: when a flush covers turns A and B, the user sees a single summary
message; turn A's tool calls and turn B's tool calls are not independently
recoverable as distinct summaries (though `context_tree_query` still works
per-id). This violates the user's stated requirement.

### Phase 1 checklist
- [ ] step 1: dry-run the capture → trim → flush flow for a session that has already been pruned once
- [ ] step 2: identify why `flushPending` returns `empty` on the second call
- [ ] step 3: confirm how multi-turn batches are currently merged into a single summary

## Phase 2 — Design (no implementation yet)

### D1. Stable turn identifier

Replace the local `turnCounter++` in `captureUnindexedBatchesFromSession` with
a stable identifier so the frontier comparison survives intermediate prunes.
Candidates (to be picked at implementation time):

- **Branch index** of the assistant `SessionEntry` (its position in
  `branch[]`). Stable across prunes because prunes do not delete session
  entries — only filter them at `context` time.
- **Assistant message timestamp**. Already captured into `batch.timestamp`;
  monotonically increases; survives prunes. Compare frontiers by
  `lastAttemptedTimestamp` instead of `lastAttemptedTurnIndex`.
- **Assistant message id**, if Pi exposes one on the session entry.

The `turn_end` capture path in `index.ts` already passes `event.turnIndex`
(Pi's own turn counter) into `captureBatch`. That is also stable and is
probably the cleanest unifier — make `captureUnindexedBatchesFromSession`
walk the branch and reuse Pi's own turn boundaries (e.g. derive turnIndex
from session entry order or from a counter that increments on every
assistant message **regardless** of whether its tool calls are pruned).

`trimBatchToPendingRange` then needs to compare on whichever stable field
is chosen, and `PruneFrontier` needs to record that field.

### D2. Per-turn summary messages

Two viable shapes:

1. **One LLM call, multiple summary messages.** Keep the batched prompt
   (cheap, one round-trip) but ask the model to emit a structured response
   (e.g. JSON or a `=== Turn N ===` delimiter contract) and split that into
   one `context-prune-summary` message per turn before persistence. Each
   summary message's `details` then carries only its own turn's
   `toolCallIds` and `turnIndex`.
2. **Multiple LLM calls.** Loop `summarizeBatch` per batch. Simpler code
   (no parser), N× cost / latency.

Default proposal: **shape 1**. Define a strict delimiter contract in
`BATCHED_SYSTEM_PROMPT` (e.g. `=== Turn <id> ===` lines), parse the model
output back into per-turn segments, and write one summary message per turn.
Indexing (`indexer.addBatch` / `persistBatchIndex`) is already per-batch, so
that side already matches the desired granularity — only the summary
message and `details` shape need changing.

### D3. Frontier persistence

`PruneFrontier` currently stores `lastAttemptedTurnIndex` plus the last
tool-call id. Change it to store whichever stable identifier we pick (or
add it alongside). On reconstruction, the persisted value drives
`trimBatchToPendingRange`. When the chosen identifier is the assistant
timestamp, `lastAttemptedTimestamp` is already in the type and just needs
to become the comparison key.

### Phase 2 checklist
- [ ] step 1: decide on a stable turn identifier that survives prior prunes
- [ ] step 2: decide how to keep one summary per turn while still using a single LLM call
- [ ] step 3: spell out frontier-comparison and persistence changes

## Phase 3 — Validation plan

### V1. Repro for Bug A
1. Start a fresh Pi session, `/pruner on`, `/pruner prune-on on-demand`.
2. Have the agent run two distinct multi-tool turns (say turn A: 3 tool
   calls, turn B: 3 tool calls).
3. `/pruner now` → expect both turns to be summarized (and persisted with
   stable turn ids).
4. Have the agent run another two multi-tool turns C and D.
5. `/pruner now` → **before fix**: returns `empty`. **After fix**: produces
   one summary per turn (C and D), both indexed; frontier advances.

### V2. Per-turn summary layout
After step 5 above, inspect via `/pruner tree`:

- Expect 4 top-level summary nodes, one per turn (A, B, C, D).
- Each parent node lists only its own turn's tool calls.
- No node mixes tool calls from multiple turns.
- `context_tree_query` with any individual id still resolves to the
  original full output.

### Phase 3 checklist
- [ ] step 1: define manual repro steps for the empty-flush bug
- [ ] step 2: define the expected per-turn summary layout for a multi-turn prune

## Summary of root causes

| # | Bug                                                                                       | Root cause                                                                                                                                       | File                          |
| - | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| A | Subsequent `/pruner now` returns `empty` after a multi-turn prune                          | `captureUnindexedBatchesFromSession` re-numbers `turnIndex` from 0 over only currently-unsummarized turns; frontier comparison drops new batches | `src/batch-capture.ts` + `index.ts` (`trimBatchToPendingRange`) + `src/frontier.ts` |
| B | Multi-turn prune produces a single merged summary instead of one summary per turn          | `summarizeBatches` collapses all batches into one summary message; `flushPending` writes one `context-prune-summary` for the whole flush         | `src/summarizer.ts` + `index.ts` (`flushPending`) |
