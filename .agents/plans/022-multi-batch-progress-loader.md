---
id: "022"
title: "Multi-batch progress loader for /pruner now"
status: in-progress
created: 2026-05-04
---

# Plan 022 — Multi-batch progress loader for `/pruner now`

## Goal

Replace the static `BorderedLoader` in `/pruner now` with a multi-row overlay that shows one
animated spinner per pending batch and checks them off as each LLM summarization call completes.
This makes the user less impatient by showing concrete progress instead of a single "summarizing…"
message that never changes.

## Context

- `BorderedLoader` only exposes `signal` / `onAbort` — no `setMessage` on the public API.
- The base `Loader` (pi-tui) has `setMessage(message)` and `setIndicator()` for live updates.
- `summarizeBatches` currently uses `Promise.all` (parallel). Per-batch progress requires sequential
  calls (`summarizeBatch` one at a time) with a callback between each.
- We need to know batch count **before** showing the overlay → extract a `capturePendingBatches()`
  helper from `flushPending` so commands can preview the queue.

## Design decisions

| Decision | Rationale |
|---|---|
| Sequential per-batch LLM calls when `onProgress` is set | Needed for accurate per-batch completion events; only `/pruner now` (user-triggered) pays this cost |
| `previewedBatches` option on `flushPending` | Avoids double-capture; commands preview once, pass result in so flush reuses it |
| New `src/multi-batch-loader.ts` component | Keeps TUI logic isolated; mirrors the `SettingsOverlay` / `TreeBrowser` pattern already in the codebase |
| `Loader` rows constructed with same color fns as `BorderedLoader` | Visual consistency with existing Pi widgets |
| `capturePendingBatches` exposed via `registerCommands` arg | Minimal surface — only commands.ts needs it; avoids polluting the extension API surface |

## Phases

### Phase 1 — Types
- [ ] Add `ProgressCallback` type to `src/types.ts`:
  ```ts
  export type ProgressCallback = (
    index: number, total: number,
    batch: CapturedBatch,
    stage: "start" | "done" | "skipped"
  ) => void;
  ```
- [ ] Add `FlushOptions` interface to `src/types.ts`:
  ```ts
  export interface FlushOptions {
    delivery?: "runtime" | "session";
    onProgress?: ProgressCallback;
    previewedBatches?: CapturedBatch[];
  }
  ```

### Phase 2 — `src/multi-batch-loader.ts` (new file)
- [ ] Create `MultiBatchLoaderOverlay extends Container`
  - Constructor: `(tui: TUI, theme: Theme, batches: CapturedBatch[])`
  - Builds: one `DynamicBorder` top + header `Text` + one `Loader` per batch + `DynamicBorder` bottom
  - Each `Loader` label: `Batch N/M (K tool call(s)) — summarizing…`
  - `markRunning(index)`: already spinning by default; call to be explicit
  - `markDone(index)`: `loader.setIndicator(undefined)` + `loader.setMessage("✓ Batch N done (K tool calls)")`
  - `markSkipped(index)`: `loader.setIndicator(undefined)` + `loader.setMessage("⚠ Batch N skipped")`
  - `onAbort` setter + `handleInput` forwarding Esc → `_onAbort?.()`

### Phase 3 — `index.ts`
- [ ] Extract `capturePendingBatches(ctx): CapturedBatch[]` private helper from `flushPending`
  (the capture + trim + group steps; no LLM work)
- [ ] Change `flushPending` signature to accept `FlushOptions` (typed)
- [ ] When `options.previewedBatches` is set, skip the capture step and use the provided array
- [ ] When `options.onProgress` is set, replace `summarizeBatches` with a sequential `for` loop
  calling `summarizeBatch` + `onProgress("start")` before and `onProgress("done"|"skipped")` after
- [ ] Pass `capturePendingBatches` as a new arg to `registerCommands(...)`

### Phase 4 — `src/commands.ts`
- [ ] Update `registerCommands` signature to accept `capturePendingBatches: (ctx) => CapturedBatch[]`
- [ ] In `case "now"`:
  1. Call `capturePendingBatches(ctx)` before opening the overlay
  2. If empty, `ctx.ui.notify("pruner: nothing pending", "info")` and break
  3. Create `MultiBatchLoaderOverlay` with the previewed batches
  4. Open via `ctx.ui.custom(factory, { overlay: true })`
  5. Call `flushPending(ctx, { previewedBatches: batches, onProgress: (i, _t, _b, stage) => ... })`
     updating the overlay rows live
  6. After flush resolves, call `done(undefined)` and notify with the `FlushResult`
- [ ] Import `MultiBatchLoaderOverlay` from `./multi-batch-loader`

### Phase 5 — `AGENTS.md`
- [ ] Document `MultiBatchLoaderOverlay` in the Code Structure section
- [ ] Update `src/types.ts` entry to mention `ProgressCallback` and `FlushOptions`
- [ ] Update `index.ts` entry to mention `capturePendingBatches` helper
- [ ] Update `src/commands.ts` entry to describe the new `/pruner now` UX

### Phase 6 — Validation
- [ ] Switch `batchingMode` to `turn` so auto-flush doesn't steal the pending batch before `/pruner now`
- [ ] Generate 3+ tool calls across different turns
- [ ] Run `/pruner now` and verify N individual spinner rows appear
- [ ] Verify each row checks off as its batch completes
- [ ] Verify Esc closes the overlay without hanging
- [ ] Verify the final `FlushResult` notification is shown after the overlay closes
