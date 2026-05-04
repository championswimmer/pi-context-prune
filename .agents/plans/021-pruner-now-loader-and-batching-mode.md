---
name: 021-pruner-now-loader-and-batching-mode
description: Fix `/pruner now` to show a blocking loader (mirroring `context_prune` UX) and add a `batchingMode` setting that lets users choose between per-turn summaries (current behavior) and per-agent-message summaries (one summary per user → final-agent-message span).
steps:
  - phase: discovery
    steps:
      - "- [ ] step 1: confirm current `/pruner now` flow and why it does not block input or render a loader"
      - "- [ ] step 2: confirm how `BorderedLoader` is used in pi (see docs/tui.md Pattern 2 + qna.ts example) and verify overlays prevent the user from sending new messages while open"
      - "- [ ] step 3: re-trace how batches are produced today (one CapturedBatch per assistant turn from `captureUnindexedBatchesFromSession`) and identify where to insert a grouping step"
      - "- [ ] step 4: identify the user-message boundary needed for `agent-message` grouping (walk the session branch and increment a userTurnGroup whenever a `role: \"user\"` SessionEntry is seen)"
  - phase: design
    steps:
      - "- [ ] step 1: spec the loader UX for `/pruner now` — `BorderedLoader` overlay titled `pruner: summarizing N turn(s)…`, opened before awaiting `flushPending`, closed in `finally`"
      - "- [ ] step 2: spec re-entrancy — while the loader overlay is open, a second `/pruner now` invocation is impossible (input is captured by the overlay); also keep the existing `isFlushing` guard as defense in depth"
      - "- [ ] step 3: spec abort behavior — Esc closes the loader and surfaces a notify, but does NOT cancel the in-flight summarizer LLM call (we keep it simple: loader is informational + blocking, not cancellable in v1). Decide: either disable Esc on the loader, or close the overlay and let the LLM call finish writing its result through `pi.sendMessage`/`appendCustomMessageEntry` as today"
      - "- [ ] step 4: spec the new config field `batchingMode: \"turn\" | \"agent-message\"` in `ContextPruneConfig` with default `\"turn\"` (preserves today's behavior)"
      - "- [ ] step 5: spec the grouping function `groupBatchesByMode(batches, mode): CapturedBatch[]` — `turn` returns batches unchanged; `agent-message` merges all consecutive batches that share a `userTurnGroup` into a single CapturedBatch (concatenating `assistantText` and `toolCalls`, keeping the latest `turnIndex` and `timestamp`, preserving original tool-call order)"
      - "- [ ] step 6: spec where grouping happens — inside `flushPending`, after `captureUnindexedBatchesFromSession` + `trimBatchToPendingRange`, before `summarizeBatches`. Frontier advancement still uses the LAST tool call of the LAST processed (post-grouping) batch, so the frontier semantics remain correct"
      - "- [ ] step 7: spec the `userTurnGroup` plumbing — extend `CapturedBatch` with an optional `userTurnGroup: number` field assigned in `captureUnindexedBatchesFromSession`; `captureBatch` (turn_end path) sets `userTurnGroup` to a sentinel that simply uses the assistant's own turn so per-turn behavior is unchanged when the queue is flushed turn-by-turn"
      - "- [ ] step 8: spec settings UX — new `batchingMode` row in `/pruner settings` overlay + `/pruner batching [turn|agent-message]` subcommand with picker for the bare form, completion entry, help-text update"
  - phase: implementation
    steps:
      - "- [ ] step 1 (types): add `BatchingMode` type + `BATCHING_MODES` array + `batchingMode` field to `ContextPruneConfig` and `DEFAULT_CONFIG` in `src/types.ts`; add optional `userTurnGroup?: number` to `CapturedBatch`"
      - "- [ ] step 2 (capture): in `src/batch-capture.ts`, walk the branch and assign `userTurnGroup` (incremented at every user message) to each CapturedBatch produced by `captureUnindexedBatchesFromSession`; keep `captureBatch` signature backwards-compatible (no group on the live `turn_end` path)"
      - "- [ ] step 3 (grouping): add `groupBatchesByMode(batches, mode)` to `src/batch-capture.ts` (or a new `src/batch-grouping.ts`) implementing the merge rules from design step 5"
      - "- [ ] step 4 (flush): in `index.ts` `flushPending`, after the trim filter, call `groupBatchesByMode(batches, currentConfig.value.batchingMode)` before `summarizeBatches`. Verify the per-batch summary loop, frontier advancement, and oversize handling still work with merged batches"
      - "- [ ] step 5 (loader): introduce a helper in `src/commands.ts` (or a new `src/loader.ts`) that opens a `BorderedLoader` overlay via `ctx.ui.custom`, runs `flushPending`, and closes the overlay in finally. Use it from `/pruner now`. Ensure the loader title reflects the pending batch count"
      - "- [ ] step 6 (commands UI): add the `batchingMode` row to the `/pruner settings` overlay (cycling between `turn` / `agent-message`, with a description string explaining the trade-off) and a top-level `/pruner batching [value]` subcommand + completions + HELP_TEXT entry"
      - "- [ ] step 7 (status text): include batching mode in `/pruner status` output"
      - "- [ ] step 8 (AGENTS.md): update the project-context section to describe the new field, grouping function, and loader helper"
  - phase: validation-plan
    steps:
      - "- [ ] step 1: manual repro — `/pruner prune-on on-demand`, run an agent task that produces 2 user→agent spans (first span: 2 tool calls; second span: 2 tool calls). With `batchingMode: turn` expect 4 summary messages; with `batchingMode: agent-message` expect 2 summary messages"
      - "- [ ] step 2: manual repro — invoke `/pruner now` while a flush is already in progress (e.g. by triggering it twice quickly via the CLI input). Confirm the second invocation cannot start because the BorderedLoader overlay is on screen blocking the editor"
      - "- [ ] step 3: confirm loader closes on success, on summarizer failure, on stale-context, and on `empty` with the correct notify"
      - "- [ ] step 4: confirm `/pruner status` and `/pruner settings` reflect the new field and that it persists in `~/.pi/agent/context-prune/settings.json`"
      - "- [ ] step 5: confirm frontier still advances correctly after a merged-batch flush by running a follow-up `/pruner now` and seeing `empty`"
---

# 021 — `/pruner now` loader and configurable batching mode

## Outcome
Make `/pruner now` feel like a real synchronous operation with a visible spinner that blocks further user input, and let users decide whether each pruner summary covers a single agent turn (today's behavior) or an entire user → final-agent-message span.

---

## Phase 1 — Discovery

### 1.1 Today's `/pruner now`
`src/commands.ts` `case "now":` simply does `await flushPending(ctx)` and then notifies. While `flushPending` is awaiting the summarizer LLM call, the prune footer changes to `prune: summarizing…` (good) but:
- no overlay is shown,
- the editor remains active so the user can submit a new prompt or run another command,
- a second `/pruner now` keystroke is only stopped by the in-process `isFlushing` boolean, which gives the user a nondescript notify after the fact.

This contrasts with `context_prune` (the agentic-auto tool path) which, because it goes through the model loop, naturally blocks the agent until the tool returns.

### 1.2 BorderedLoader is the right primitive
`docs/tui.md` Pattern 2 (BorderedLoader) is exactly the modal "long async op with optional cancel" UX we want. While its overlay is mounted via `ctx.ui.custom(..., { overlay: true })`, the user cannot start a new model turn — the editor is hidden behind the overlay.

### 1.3 Per-turn batches are produced in `captureUnindexedBatchesFromSession`
That function emits one `CapturedBatch` per assistant message. The merge needs to happen before summarization but after frontier trimming so the frontier still sees real per-tool-call boundaries.

### 1.4 User-message boundary
Walking the same branch list and incrementing a `userTurnGroup` counter every time we see `entry.message.role === "user"` gives us the grouping key. Each assistant batch produced afterwards is tagged with the current `userTurnGroup` until the next user message resets it.

---

## Phase 2 — Design

### 2.1 Loader for `/pruner now`
- `case "now"` opens a `BorderedLoader` overlay with the title `pruner: summarizing…` (plus `(N pending)` hint when known).
- The overlay's `done` callback is invoked from a `finally` after `flushPending` resolves so the overlay always closes.
- Esc on the loader is wired to `loader.onAbort` only as a safety fallback that closes the overlay; it does NOT cancel the LLM call. The flush continues writing summaries via `pi.sendMessage` / `appendCustomMessageEntry` as today.
- The existing `isFlushing` guard is kept so nothing slips through if some other code path races.

### 2.2 Config field
```ts
export type BatchingMode = "turn" | "agent-message";

export interface ContextPruneConfig {
  // … existing …
  batchingMode: BatchingMode; // default "turn"
}
```
`BATCHING_MODES = [{ value: "turn", label: "Per turn" }, { value: "agent-message", label: "Per agent message" }]`.

### 2.3 Grouping function
```ts
export function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode): CapturedBatch[] {
  if (mode !== "agent-message") return batches;
  // merge consecutive batches sharing the same userTurnGroup
}
```
Merge rules:
- Keep input order.
- New `assistantText` = original `assistantText` values joined by `\n\n` (skip empty entries).
- New `toolCalls` = concat of all input `toolCalls` arrays, in order.
- `turnIndex` = last batch's `turnIndex` (the latest assistant turn in the group).
- `timestamp` = last batch's `timestamp`.
- Batches without a `userTurnGroup` (e.g. live `turn_end` capture) are passed through one-per-batch — `agent-message` only meaningfully kicks in when flushing from a session-branch scan.

### 2.4 Where grouping runs
In `index.ts` inside `flushPending`, the order becomes:
1. `captureUnindexedBatchesFromSession`
2. `trimBatchToPendingRange` filter
3. **`groupBatchesByMode(batches, batchingMode)`** ← new step
4. `summarizeBatches`
5. per-batch persistence loop
6. frontier advance based on last successfully-processed (merged) batch

Frontier still uses the last tool-call's `toolCallId` of the last processed batch, so subsequent flushes correctly skip everything we've persisted.

### 2.5 Settings + commands UX
- Add a row to the `/pruner settings` overlay cycling `turn` ↔ `agent-message`, with a description explaining "one summary per turn" vs "one summary per user→final-agent message span".
- Add `/pruner batching [value]` subcommand mirroring `/pruner prune-on`.
- Update `HELP_TEXT`, completions, and `/pruner status` output.

---

## Phase 3 — Implementation

Files touched:
- `src/types.ts` — `BatchingMode`, `BATCHING_MODES`, `batchingMode` on `ContextPruneConfig` + `DEFAULT_CONFIG`, `userTurnGroup?` on `CapturedBatch`.
- `src/batch-capture.ts` — assign `userTurnGroup` while scanning the branch; export `groupBatchesByMode`.
- `index.ts` — call `groupBatchesByMode` in `flushPending`; ensure frontier semantics stay correct.
- `src/commands.ts` — add `BorderedLoader` helper, wire it into `/pruner now`, add `batching` subcommand + settings row + help text + status line.
- `AGENTS.md` — update project context.

### 3.1 Types
```ts
export type BatchingMode = "turn" | "agent-message";

export const BATCHING_MODES = [
  { value: "turn", label: "Per turn" },
  { value: "agent-message", label: "Per agent message" },
] as const;

export interface ContextPruneConfig {
  enabled: boolean;
  showPruneStatusLine: boolean;
  summarizerModel: string;
  summarizerThinking: SummarizerThinking;
  pruneOn: PruneOn;
  remindUnprunedCount: boolean;
  batchingMode: BatchingMode; // NEW — default "turn"
}
```

### 3.2 Grouping logic
```ts
export function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode): CapturedBatch[] {
  if (mode !== "agent-message") return batches;
  const out: CapturedBatch[] = [];
  let current: CapturedBatch | null = null;
  for (const batch of batches) {
    if (batch.userTurnGroup === undefined) { out.push(batch); current = null; continue; }
    if (current && current.userTurnGroup === batch.userTurnGroup) {
      current.assistantText = [current.assistantText, batch.assistantText].filter(Boolean).join("\n\n");
      current.toolCalls = current.toolCalls.concat(batch.toolCalls);
      current.turnIndex = batch.turnIndex;
      current.timestamp = batch.timestamp;
    } else {
      current = { ...batch };
      out.push(current);
    }
  }
  return out;
}
```

### 3.3 Loader for `/pruner now`
```ts
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

case "now": {
  if (!currentConfig.value.enabled) { /* unchanged */ }
  let result: FlushResult | null = null;
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "pruner: summarizing…");
    loader.onAbort = () => done(undefined); // overlay close only; flush keeps running
    flushPending(ctx)
      .then((r) => { result = r; done(undefined); })
      .catch(() => done(undefined));
    return loader;
  }, { overlay: true });
  // notify based on `result` exactly like today
}
```

### 3.4 Settings + subcommand
- Add a `batchingMode` row to the items array in `/pruner settings`.
- Add `{ value: "batching", label: "batching — per turn or per agent message" }` to `SUBCOMMANDS`.
- Add a `case "batching":` block mirroring `case "prune-on":` (picker on bare form, set + persist on arg form).
- Append the new field to `/pruner status` output.
- Update `HELP_TEXT`.

### 3.5 AGENTS.md
Document the new config field, `groupBatchesByMode`, and the loader pattern in the existing structure section.

---

## Phase 4 — Validation

1. Set `pruneOn: on-demand`, `batchingMode: turn`. Run a multi-turn agent task. `/pruner now` produces N summaries (one per turn).
2. Set `batchingMode: agent-message`. Reset session, run the same task. `/pruner now` produces 1 summary per user→final-agent span.
3. Open `/pruner now` while another flush is already in progress — second invocation cannot run because the BorderedLoader overlay is on screen.
4. Verify settings persist to `~/.pi/agent/context-prune/settings.json`.
5. After a merged-batch flush, run `/pruner now` again and confirm `empty` (frontier advanced correctly).
