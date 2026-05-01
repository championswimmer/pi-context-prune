---
name: 016-token-accounting-utilities
description: Add token accounting infrastructure (estimator + rawTokenCount / summaryTokenCount / tokensSaved / savingsRatio) so future pruning policy decisions can be token-aware. Char-based behavior is preserved; this PR is pure instrumentation. Closes issue #4 (parent #3).
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: re-read issue #4 acceptance criteria and #3 rollout principle to confirm scope is instrumentation-only"
      - "- [x] step 2: catalogue every site that currently uses rawCharCount / summaryCharCount (frontier, flush result, /pruner now notification, status text)"
      - "- [x] step 3: decide on a fallback estimator that is deterministic, dependency-free, and matches widely-used heuristics"
      - "- [x] step 4: decide where token counts plug into PruneFrontier and FlushResult without breaking older persisted entries"
  - phase: implementation
    steps:
      - "- [x] step 1: add `src/tokens.ts` with `estimateTokens(text)` fallback + `countTokens(text, model?)` wrapper"
      - "- [x] step 2: extend `PruneFrontier` and `FlushResult` types with optional rawTokenCount / summaryTokenCount / tokensSaved / savingsRatio fields"
      - "- [x] step 3: compute the new metrics inside `flushPending` and persist them on the frontier"
      - "- [x] step 4: hydrate the new fields in `PruneFrontierTracker.fromJSON` so older sessions load cleanly with safe defaults"
      - "- [x] step 5: surface token metrics in the /pruner now notification (additive, char metrics unchanged)"
      - "- [x] step 6: add tests for fallback estimation (small/medium/empty) and savings calculations (positive, zero, negative)"
      - "- [x] step 7: add a `test` script to package.json so the tests can be run via `npm test`"
  - phase: validation
    steps:
      - "- [x] step 1: run `npm test` locally and confirm all assertions pass"
      - "- [x] step 2: review the diff for behavior parity (no pruning trigger / acceptance changes)"
      - "- [x] step 3: commit on the feature branch and push for PR review"
---

# 016-token-accounting-utilities

## Context

Issue #4 is the first sub-issue of the broader token-/cache-aware pruning policy
tracked in #3. The roadmap is intentionally staged:

> 1. instrumentation and token accounting
> 2. token-aware skip/accept thresholds
> 3. context-pressure triggering
> 4. telemetry/stats
> 5. cache-aware ROI mode

This plan covers **only step 1**. There must be no behavioral change to when
pruning triggers or whether a summary is accepted/skipped. We are purely adding
the numbers that later PRs will consume.

## Acceptance criteria (from #4)

- Existing behavior is unchanged.
- Token metrics are available to later PRs.
- If provider/model token counting is unavailable, the fallback estimator is deterministic.
- Tests cover small, medium, and empty text cases.

## Where char metrics live today

`flushPending` (in `index.ts`) and `PruneFrontier` (in `src/types.ts`) already
track:

- `rawCharCount` — sum of `tc.resultText.length` across the pending batches
- `summaryCharCount` — `result.summaryText.length`

These two numbers also drive:

- the `shouldSkipOversized` decision (must keep this char-based for now per #4),
- the `/pruner now` notification text (in `src/commands.ts`),
- the oversized-skip warning (in `index.ts`).

We will **not** change the skip decision. We will only add parallel token
fields next to the existing char fields.

## Design

### `src/tokens.ts`

A small, dependency-free module:

```ts
/**
 * Deterministic fallback token estimator. Uses the widely-cited
 * "1 token ≈ 4 chars of English/code" heuristic and rounds up so empty
 * strings yield 0, very short strings yield 1, etc.
 *
 * This is intentionally simple. Real provider token counts are preferred
 * when available via `countTokens(text, model)`.
 */
export function estimateTokens(text: string): number;

/**
 * Token count for `text`, using the model's tokenizer when one is available
 * on the supplied model object. Falls back to `estimateTokens` deterministically
 * when no tokenizer is exposed or it throws. This wrapper exists so future
 * pruning policy can call a single function regardless of provider support.
 */
export function countTokens(text: string, model?: unknown): number;

/**
 * Compute tokens-saved and savings-ratio from raw + summary token counts.
 * `savingsRatio` is in [-Infinity, 1]: positive ratios mean we saved tokens,
 * 0 means no change, negative means the summary is bigger than the raw text.
 * Returns `{ tokensSaved: 0, savingsRatio: 0 }` for empty raw input so callers
 * never have to guard against divide-by-zero.
 */
export function computeSavings(rawTokens: number, summaryTokens: number): {
  tokensSaved: number;
  savingsRatio: number;
};
```

Notes:

- The fallback uses `Math.ceil(text.length / 4)` so it is deterministic and
  monotonic. Tests pin the exact outputs for representative inputs.
- `countTokens` is duck-typed against any model that exposes `countTokens` /
  `tokenize` so future provider integrations can light it up without changing
  callers. Errors and missing tokenizers always fall through to `estimateTokens`.

### Type extensions (`src/types.ts`)

Add optional fields to keep older persisted snapshots loadable:

```ts
export interface PruneFrontier {
  // ...existing fields...
  rawTokenCount?: number;
  summaryTokenCount?: number;
  tokensSaved?: number;
  savingsRatio?: number;
}
```

`PruneFrontierTracker.fromJSON` will default missing values to `0` so older
session entries do not crash the tracker.

### `flushPending` wiring (`index.ts`)

Right after computing `rawCharCount`:

```ts
const rawTokenCount = batches.reduce(
  (sum, batch) =>
    sum + batch.toolCalls.reduce(
      (batchSum, tc) => batchSum + estimateTokens(tc.resultText),
      0,
    ),
  0,
);
```

Right after the summarizer returns (and we know `summaryCharCount`):

```ts
const summaryTokenCount = estimateTokens(result.summaryText);
const { tokensSaved, savingsRatio } = computeSavings(rawTokenCount, summaryTokenCount);
```

These four numbers are then included in the `buildFrontier(...)` payload and in
the typed `FlushResult` so they ride along with the existing char metrics.

### Notification

`/pruner now` already prints raw vs summary char counts. We append a token line
after the existing char line so existing tests / scripts that parse the message
still see the char numbers where they are today:

```
pruner: pruned 6 tool calls from 2 batches — summary 1.2k chars vs 4.8k raw chars (≈ 312 vs 1284 tokens, saved 972 / 75.7%)
```

The message stays a single line so the existing `ctx.ui.notify` path is
unchanged structurally.

### Testing

- New file: `src/tokens.test.ts`
- Runner: Node's built-in `node:test` with `node --experimental-strip-types`,
  which is available on the Node 22+ that this repo already targets locally.
  No new runtime deps are added.
- Cases:
  - `estimateTokens("")` → `0`
  - `estimateTokens("hi")` → `1`
  - `estimateTokens("the quick brown fox")` → `5` (length 19, ceil(19/4) = 5)
  - `estimateTokens(<512-char block>)` → `128`
  - `countTokens("abc")` falls back to estimator with no model
  - `countTokens("abc", { countTokens: () => 7 })` returns 7
  - `countTokens("abc", { countTokens: () => { throw new Error() } })` falls back
  - `computeSavings(0, 0)` → `{ tokensSaved: 0, savingsRatio: 0 }`
  - `computeSavings(100, 25)` → `{ tokensSaved: 75, savingsRatio: 0.75 }`
  - `computeSavings(100, 150)` → `{ tokensSaved: -50, savingsRatio: -0.5 }`

## Phase 1 — Discovery
- [x] step 1: re-read issue #4 acceptance criteria and #3 rollout principle to confirm scope is instrumentation-only
- [x] step 2: catalogue every site that currently uses rawCharCount / summaryCharCount (frontier in `src/types.ts`, `flushPending` in `index.ts`, `/pruner now` notification in `src/commands.ts`, oversized-skip warning in `index.ts`)
- [x] step 3: decide on a fallback estimator (Math.ceil(length / 4), deterministic, no deps)
- [x] step 4: decide where token counts plug in (PruneFrontier + FlushResult, both with optional fields for forward/back compat)

## Phase 2 — Implementation
- [x] step 1: add `src/tokens.ts` with `estimateTokens`, `countTokens`, and `computeSavings`
- [x] step 2: extend `PruneFrontier` and `FlushResult` with optional rawTokenCount / summaryTokenCount / tokensSaved / savingsRatio fields
- [x] step 3: compute the new metrics inside `flushPending` and persist them on the frontier
- [x] step 4: hydrate the new fields in `PruneFrontierTracker.fromJSON` with safe defaults
- [x] step 5: surface token metrics in the `/pruner now` notification (additive only)
- [x] step 6: add `src/tokens.test.ts` covering empty/small/medium estimation and savings positive/zero/negative
- [x] step 7: add a `test` script in `package.json` that runs the test file via Node's built-in test runner

## Phase 3 — Validation
- [x] step 1: run `npm test` locally and confirm all assertions pass
- [x] step 2: re-read the diff and confirm no pruning trigger / accept-skip behavior moved
- [x] step 3: commit on `issue-4-token-accounting` and push for PR review

## Out of scope (per #4 non-goals)

- Changing when pruning triggers (no new thresholds, no context-pressure logic).
- Changing the prune accept/skip rule (still char-based).
- Cache-aware policy.
- Persisting token-counter telemetry beyond what naturally lands on the frontier.
