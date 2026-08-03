# Project Guidance

This repository is for a Pi coding-agent extension that prunes tool-call trees before the next request is sent.

## Working style
- Keep changes small, focused, and reversible.
- Read existing files before editing them.
- Preserve user work; do not overwrite unrelated changes.
- Prefer Markdown for plans and notes, and keep code and docs aligned.

## Planning
- Use the `planning` skill for any multi-step task.
- Store plans in `.agents/plans/`.
- Use zero-padded numbered plan filenames like `000-first-plan.md`, `001-another-plan.md`, and `002-plan-more.md`.
- Keep plan checklists in sync with actual progress.

## Implementation
- When adding code, include a brief explanation of why the change exists.
- Add tests or a reproducible verification command for behavior changes when possible.

---

## Code Structure

```
pi-context-prune/
├── index.ts                       # Extension entry point — wires all modules together
├── package.json                   # Pi package manifest; declares extension at ./index.ts
└── src/
    ├── types.ts                   # Shared types, constants, and interfaces (including PruneOn modes)
    ├── config.ts                  # Load/save ~/.pi/agent/context-prune/settings.json
    ├── batch-capture.ts           # Capture turn results from events or session branch
    ├── summarizer.ts              # LLM call that summarizes a CapturedBatch to markdown
    ├── indexer.ts                 # Runtime Map<toolCallId, ToolCallRecord> + session persistence
    ├── pruner.ts                  # Filter context event messages (removes summarized ToolResultMessages)
    ├── reminder.ts                # Append <pruner-note> reminder to last toolResult (agentic-auto only)
    ├── query-tool.ts              # Register the context_tree_query tool for recovering pruned outputs
    ├── context-prune-tool.ts      # Register the context_prune tool for agentic-auto mode
    ├── viewer-document.ts         # Pure builder: session branch + indexer → ViewerDocument for web tree
    ├── viewer-server.ts           # Shared localhost viewer (publish latest, open browser, idle stop)
    ├── viewer-page.ts             # Self-contained HTML/CSS/JS for the conversation viewer
    ├── stats.ts                   # StatsAccumulator for cumulative summarizer token/cost tracking
    ├── multi-batch-loader.ts      # MultiBatchLoaderOverlay TUI component for /pruner now progress display
    ├── agent-end-guard.ts         # Successful final-assistant allow-list for agent-message commits
    ├── agent-message-lifecycle.ts # agent_end policy: flush only on successful stop
    ├── cancellable-flush.ts       # Invocation-local AbortController helper for /pruner now
    └── commands.ts                # /pruner command + interactive settings overlay + summary message renderer
```

### `index.ts` — Extension entry point
Wires all modules together and registers Pi event handlers:
- **`pendingBatches: CapturedBatch[]`** — queue of captured batches not yet summarized; drained by `flushPending`.
- **`capturePendingBatches(ctx)`** — extracted helper that runs the capture + trim + group steps from `flushPending` without any LLM work. Exposed to `commands.ts` via `registerCommands` so `/pruner now` can preview the pending queue and know the batch count before opening the `MultiBatchLoaderOverlay`.
- **`flushPending(ctx, options?)`** — summarizes + indexes all unsummarized batches in parallel by default; when `options.onProgress` is provided (`/pruner now`), uses a worker pool sized by `flushConcurrency`. Batches under `minRawCharsToSummarize` are pre-skipped (no LLM, frontier still advances). Live status text is `A/B · C/D(chars)`. Accepts `FlushOptions`: `{ delivery?, onProgress?, onBatchTextProgress?, previewedBatches? }`. When `previewedBatches` is set the internal capture step is skipped (avoids double-capture from `/pruner now`). While summarization is running, `onBatchTextProgress` receives the streamed summary character count for the active batch so callers can surface live progress in richer UIs (the `/pruner now` overlay and `context_prune` tool updates), while the footer itself stays at the simpler `prune: summarizing…` state. Returns a typed `FlushResult`.

- **`syncToolActivation()`** — activates or deactivates the `context_prune` tool in the Pi active-tools list based on whether `enabled && pruneOn === "agentic-auto"`. Uses `pi.getActiveTools()` / `pi.setActiveTools()` (ExtensionAPI, not ExtensionContext).
- **`session_start`** — loads config from `~/.pi/agent/context-prune/settings.json`, rebuilds the in-memory index and stats accumulator, clears `pendingBatches`, updates the footer status widget, calls `syncToolActivation()`, and notifies the user of the loaded state.
- **`session_tree`** — rebuilds the index and stats accumulator after branch navigation (pending batches and stats belong to the current branch).
- **`turn_end`** — captures the batch (filtering out any `context_prune` tool call to avoid re-queuing agentic-auto housekeeping), pushes to `pendingBatches`. Behavior depends on `pruneOn` mode:
  - `every-turn`: flushes immediately with `delivery: "session"`.
  - `on-context-tag` / `on-demand` / `agent-message` / `agentic-auto`: queues and notifies the user of pending count and trigger.
- **`tool_execution_end`** — when `event.toolName` is `context_checkpoint` (or the legacy `context_tag`) and mode is `on-context-tag`, calls `flushPending` with `delivery: "runtime"`.
- **`agent_end`** — primary flush path for `agent-message` mode via `handleAgentEndLifecycle`. Summarizes only when the last assistant message has `stopReason === "stop"` and no tool calls, passing `ctx.signal` so Esc can cancel the summarizer. Unsuccessful endings (`error` / `aborted` / `length` / tool use) keep batches pending and refresh the pending status. Other modes only update the pending status when batches remain.
- **`before_agent_start`** — when mode is `agentic-auto` and pruning is enabled, appends `AGENTIC_AUTO_SYSTEM_PROMPT` to the system prompt so the LLM knows when and how to call `context_prune`.
- **`context`** — filters the message array sent to the LLM, removing `ToolResultMessage` entries that have been summarized. Also injects stored batch summaries near the pruned toolCalls via pure `injectSummaries` (no steer) for all `pruneOn` modes — session-delivered summaries only live in the session file, so this injection is the only path that shows them to the LLM within the running process. Additionally, when `remindUnprunedCount` is true (agentic-auto only), applies a `<pruner-note>` only when unpruned work crosses 8, then 12 calls. The watermark resets below 8 and on session/branch changes. Returns `undefined` (no change) if neither pruning nor annotation modified the list.

### `src/types.ts` — Shared types and constants
Single source of truth for all interfaces and constants:
- **`CapturedBatch`** / **`CapturedToolCall`** — snapshot of one assistant turn's tool calls + results. `CapturedBatch` carries `assistantText` (any non-tool-call text from the assistant message) and an optional `userTurnGroup` field set by `captureUnindexedBatchesFromSession` to identify which user→agent span the batch belongs to (used for `agent-message` batching mode).
- **`ToolCallRecord`** — full record stored in the runtime index (includes original `resultText`).
- **`IndexEntryData`** — data shape written to session via `pi.appendEntry` for persistence across restarts.
- **`PruneOn`** — `"every-turn" | "on-context-tag" | "on-demand" | "agent-message" | "agentic-auto"` — when summarization is triggered:
  - `every-turn`: summarize after every tool-calling turn.
  - `on-context-tag`: batch turns, flush when `context_checkpoint` (legacy: `context_tag`) is called.
  - `on-demand`: only when the user runs `/pruner now`.
  - `agent-message`: batch turns, flush on successful `agent_end` (`stop`, no tool calls) (default).
  - `agentic-auto`: the LLM decides when to prune by calling the `context_prune` tool, guided by `AGENTIC_AUTO_SYSTEM_PROMPT`.
- **`BatchingMode`** — `"turn" | "agent-message"` — granularity of each pruning batch.
  - `turn`: one summary per assistant turn (default; current behavior).
  - `agent-message`: all assistant turns between two consecutive user messages are merged into a single summary.
- **`SummarizerThinking`** — `"default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` — reasoning effort level to pass to the summarizer LLM. `"default"` omits the option entirely (provider default); other values set `reasoningEffort` in the provider call options.
- **`PRUNE_ON_MODES`** — `{ value, label }` array for interactive selectors.
- **`BATCHING_MODES`** — `{ value, label }` array for interactive selectors.
- **`SUMMARIZER_THINKING_LEVELS`** — `{ value, label }` array for interactive selectors.
- **`ContextPruneConfig`** — `{ enabled, showPruneStatusLine, summarizerModel, summarizerThinking, pruneOn, remindUnprunedCount, batchingMode, flushConcurrency, minRawCharsToSummarize }` stored in `~/.pi/agent/context-prune/settings.json`. `flushConcurrency` (default 4, clamp 1–16) caps parallel summarizer calls for `/pruner now` only. `minRawCharsToSummarize` (default 800, `0`=off) pre-skips LLM when batch raw chars are below the gate.
- **`SummarizerStats`** — cumulative token/cost stats: `{ totalInputTokens, totalOutputTokens, totalCost, callCount }`. Persisted via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`ProgressCallback`** — `(index, total, batch, stage: "start" | "done" | "skipped") => void` — progress callback fired by `flushPending` when processing batches sequentially. Only used when the caller passes `onProgress` in `FlushOptions` (i.e. `/pruner now`).
- **`BatchTextProgressCallback`** — `(index, total, batch, receivedChars) => void` — live callback fired while the summarizer streams text for the active batch in `/pruner now`.
- **`FlushOptions`** — `{ delivery?, onProgress?, onBatchTextProgress?, previewedBatches? }` — typed options bag for `flushPending`. `onProgress` triggers sequential processing; `onBatchTextProgress` reports streamed summary character counts for the active batch; `previewedBatches` skips the internal capture step to avoid double-capture when the caller previewed the queue before opening the overlay.
- **`SummarizeBatchOptions`** — `{ onTextProgress? }` — optional per-call summarizer hooks. Used to surface streamed character counts during a single batch summary.
- **`SummarizeBatchesOptions`** — `{ onBatchTextProgress? }` — optional hooks for parallel multi-batch summarization so callers can surface live per-batch text progress in the footer or overlay.
- **`SummarizeResult`** — return type from summarizer: `{ summaryText, usage }` carrying both the markdown summary and LLM usage data.
- **`SummaryMessageDetails`** — metadata attached to `context-prune-summary` custom messages.
- Constants: `CUSTOM_TYPE_SUMMARY`, `CUSTOM_TYPE_INDEX`, `CUSTOM_TYPE_STATS`, `STATUS_WIDGET_ID`, `DEFAULT_CONFIG`, `CONTEXT_PRUNE_TOOL_NAME`, `AGENTIC_AUTO_SYSTEM_PROMPT`.

### `src/config.ts` — Config persistence
- **`SETTINGS_PATH`** — constant resolving to `~/.pi/agent/context-prune/settings.json` (global, project-independent).
- **`loadConfig()`** — reads `SETTINGS_PATH`, parses JSON, merges with `DEFAULT_CONFIG`. Returns defaults on any read/parse error.
- **`saveConfig(config)`** — creates the directory if needed (`mkdir recursive`) then writes the full config as the file root (no key wrapping).

### `src/batch-capture.ts` — Turn capture and serialization
- **`captureBatch(message, toolResults, turnIndex, timestamp)`** — converts raw `turn_end` event data into a typed `CapturedBatch`. Extracts `assistantText` from `TextContent` blocks and matches each `ToolCall` content block in the `AssistantMessage` with its corresponding `ToolResultMessage` by `toolCallId`. Falls back to `"(no result)"` if no match is found for a tool call.
- **`captureUnindexedBatchesFromSession(branch, indexer, excludeToolNames)`** — scans a session branch for all unsummarized tool results and groups them into `CapturedBatch` objects. Each batch is tagged with a `userTurnGroup` counter that increments on every `role: "user"` message encountered while walking the branch — all assistant turns between two consecutive user messages share the same `userTurnGroup`. This allows `groupBatchesByMode` to merge them later. **Important**: `getBranch()` returns `SessionEntry[]` (not `AgentMessage[]`). Each message entry is `{ type: "message", message: AgentMessage }`. The function unwraps `entry.message` before accessing `role`/`toolCallId`. Pi appends both the assistant message and individual tool results to the session as they arrive (not batched at `turn_end`), so mid-turn results ARE visible in the branch.
- **`groupBatchesByMode(batches, mode)`** — applies the batching-mode grouping. `"turn"` returns batches unchanged (one summary per assistant turn). `"agent-message"` merges consecutive batches that share the same `userTurnGroup` into a single `CapturedBatch` (concat `toolCalls`, join `assistantText`, keep last `turnIndex`/`timestamp`). Batches without `userTurnGroup` (live `turn_end` path) are always passed through one-per-batch. Called in `flushPending` after frontier trimming and before `summarizeBatches`.
- **`serializeBatchForSummarizer(batch)`** — renders a single `CapturedBatch` as plain text for the summarizer LLM. Includes `assistantText` as a header if present. Truncates individual result text at 2 000 chars to keep the summarizer prompt manageable.
- **`serializeBatchesForSummarizer(batches)`** — renders multiple `CapturedBatch` objects into a single text block for batched summarization. Each batch is rendered as a `=== Turn N ===` section, separated by blank lines. Reuses `serializeBatchForSummarizer` for each batch's body.

### `src/summarizer.ts` — LLM summarization
- **`summarizerThinkingOptions(config)`** — translates `config.summarizerThinking` into a provider-call options object. `"default"` returns `{}`; `"off"` returns `{ reasoningEffort: undefined }`; all other levels return `{ reasoningEffort: level }`. Provider adapters translate `reasoningEffort` into the provider-specific field.
- **`resolveModel(config, ctx)`** — resolves `config.summarizerModel` to a model instance. `"default"` returns `ctx.model`; `"provider/model-id"` splits on `/` and looks up via `ctx.modelRegistry.find(provider, modelId)` with a fallback to `ctx.model` + warning on failure.
- **`summarizeBatch(batch, config, ctx, options?)`** — summarizes a single `CapturedBatch` in one LLM call. Internally uses streaming so it can optionally report received summary-text character counts through `options.onTextProgress`, while still returning a final `SummarizeResult` (summary text + usage) on success or `null` on failure.
- **`summarizeBatches(batches, config, ctx, options?)`** — summarizes multiple `CapturedBatch` objects via one parallel LLM call per batch. If only one batch, delegates to `summarizeBatch`. For live UX it can forward streamed per-batch character counts through `options.onBatchTextProgress`. Returns an array of per-batch results.

### `src/indexer.ts` — `ToolCallIndexer` class
Maintains the runtime `Map<toolCallId, ToolCallRecord>` and handles session persistence:
- **`reconstructFromSession(ctx)`** — scans the current branch's session entries for `CUSTOM_TYPE_INDEX` custom entries and repopulates the in-memory map; also restores batch summary text from `CUSTOM_TYPE_SUMMARY` custom_message entries via `recordSummary`.
- **`addBatch(batch, pi)`** — persists the complete batch through `pi.appendEntry(CUSTOM_TYPE_INDEX, ...)`, then publishes all records to the runtime map so failed persistence cannot expose a partial in-memory index.
- **`recordSummary(content, details)`** / **`getSummaries()`** — stores batch summary text (keyed by sorted toolCallId set) for context injection; also registers short-id aliases. Re-recording the same batch replaces stale retry content.
- **`getCommittedSummaries()`** — returns only summaries whose full toolCallId set exists in the index; agentic-auto pruning and all-mode context injection use this commit boundary.
- **`isSummarized(toolCallId)`** — used by the pruner to decide which messages to drop.
- **`getRecord(toolCallId)`** / **`lookupToolCalls(ids)`** — used by the query tool and tree-browser to retrieve full original outputs.

### `src/pruner.ts` — Context message filter + summary inject
- **`pruneMessages(messages, indexer, pruneOn?)`** — filters the `context` event's message array. Other modes drop indexed `ToolResultMessage`s as before; agentic-auto drops them only when the covering summary's complete batch index is committed. Assistant tool-call blocks remain so the model can call `context_tree_query` by ID.
- **`injectSummaries(messages, indexer)`** — pure normalization for all `pruneOn` modes: removes indexer-managed persisted summaries, then re-inserts only committed summaries after the last covered toolCall block so merged multi-turn batches stay causally ordered. Summaries whose toolCalls left context (for example after compaction) stay out; repeated calls are idempotent. Injection from the indexer (not steer/session state) is what makes session-delivered summaries visible to the LLM within the running process.

### `src/reminder.ts` — Unpruned-count reminder (agentic-auto only)
- **`countUnprunedToolCalls(messages, indexer)`** — walks `AssistantMessage` `toolCall` content blocks and counts those whose id is NOT in the indexer, excluding `context_prune` housekeeping calls.
- **`buildReminderText(count)`** — returns `<pruner-note>N unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.</pruner-note>`.
- **`annotateWithUnprunedCount(messages, count)`** — if the last message is a `ToolResultMessage`, returns a shallow-cloned list with a `text` content block appended carrying the reminder. Otherwise returns `messages` unchanged.
- **`applyUnprunedReminder(messages, indexer, watermark)`** — applies the reminder only on the 8- and 12-call threshold crossings and returns the next watermark. Wired from `index.ts`'s `context` handler, gated on `enabled && pruneOn === "agentic-auto" && remindUnprunedCount`. Annotating only the tail of the last toolResult preserves role alternation and keeps the static prompt-cache prefix intact.

### `src/query-tool.ts` — `context_tree_query` tool
Registers a Pi tool that allows the LLM (or user) to recover pruned outputs:
- Accepts `{ toolCallIds: string[] }`.
- Looks up each ID in the indexer; returns full `resultText` (truncated via Pi's `truncateHead` helper with `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`) along with tool name, args, status, and turn index.
- IDs not found in the index return a "(not found)" notice rather than an error.
- Returns `{ content, details: { results } }` with found records in the `details` field.

### `src/context-prune-tool.ts` — `context_prune` tool (agentic-auto mode)
Registers the `context_prune` tool with Pi. The tool is **always registered** (so Pi knows about it), but is only added to the active tools list when `pruneOn === "agentic-auto"` and `enabled === true`. Activation/deactivation is handled in `index.ts` via `syncToolActivation()` → `pi.setActiveTools()`.
- Takes no parameters — calling it flushes all pending batches via `flushPending(ctx, { delivery: "runtime" })`.
- Uses the tool `onUpdate` callback to stream compact live progress text into the running tool output box (e.g. `Context prune running… batch 2/4 · 1.2k chars received`).
- Returns a typed `FlushResult` describing how many batches and tool calls were summarized, or a reason if the flush did not run (empty, already-flushing, stale-context, etc.).
- Carries `promptSnippet` and `promptGuidelines` so the LLM is guided to call it after batches of 8–10 tool calls, not after every 2–3.

### `src/viewer-document.ts` / `viewer-server.ts` / `viewer-page.ts` — Web conversation viewer
Replaces the old TUI tree with a localhost web page opened by `/pruner tree`.
- **`resolveViewerEntries(sm)`** — prefers `buildContextEntries()` (compaction-aware agent path). Never falls back to `getEntries()` (whole tree / sibling branches).
- **`buildViewerDocument(entries, indexer, meta)`** — pure transform into a `ViewerDocument` timeline matching agent-visible context (`pruneMessages` semantics: drop summarized toolResults; keep assistant tool-call blocks; include compaction/branch_summary). Windows to latest `VIEWER_ROW_WINDOW` rows. Summary rows carry short refs + original tool bodies from the indexer for quality comparison.
- **`publishViewerDocument` / `openViewer`** — write latest snapshot + originals sidecar under `~/.pi/agent/context-prune/`, ensure one fixed-port server (`127.0.0.1:17342`). `/pruner tree` always `forceOpen`s the browser. Multiple pi processes share the same endpoint via the file + health check; last publish wins. `/api/original` caches the originals map by mtime.
- **Page UX** — messages collapsed by default, click to expand, scroll to bottom on load/update, poll latest. Tab refcount via `POST /api/hello` (boot) + `sendBeacon /api/bye` (pagehide); last tab schedules stop after `VIEWER_TAB_STOP_DELAY_MS` (refresh-safe). Heartbeat is lastSeen-only; 60s stale is lost-bye fallback.

### `src/multi-batch-loader.ts` — `MultiBatchLoaderOverlay` TUI component
Provides a multi-row progress overlay for `/pruner now` that shows one animated spinner per pending
batch, updates the active row with streamed summary character counts, and checks each row off as the corresponding LLM summarization call completes.
- **`MultiBatchLoaderOverlay extends Container`** — constructor takes `(tui, theme, batches: CapturedBatch[])`.
  Builds one `DynamicBorder` top + one `Loader` per batch + one `DynamicBorder` bottom.
  Each `Loader` label shows `Batch N/M (K tool calls) summarizing…`, then appends `received N chars` while text is streaming.
- **`markRunning(index)`** — resets a row to the base `summarizing…` label.
- **`markReceivedChars(index, receivedChars)`** — updates the row label with the number of summary characters streamed so far.
- **`markDone(index)`** — calls `loader.stop()` + `loader.setMessage("✓ Batch N/M done (K tool calls)")` to freeze the spinner and show a checkmark.
- **`markSkipped(index)`** — calls `loader.stop()` + `loader.setMessage("⚠ Batch N/M skipped")` when the LLM call returned null.
- **`onAbort` setter + `handleInput`** — forwards `Esc`/`q` to the invocation-local abort callback so `/pruner now` can cancel the in-flight summarizer.

### `src/stats.ts` — `StatsAccumulator` class + formatting helpers
Accumulates cumulative token/cost stats for summarizer LLM calls and persists them to the session:
- **`add(usage)`** — accumulates one LLM call's usage (input tokens, output tokens, total cost).
- **`getStats()`** — returns a `SummarizerStats` snapshot.
- **`reset()`** — clears all accumulated stats to zero.
- **`reconstructFromSession(ctx)`** — scans session entries for `CUSTOM_TYPE_STATS` and restores the last snapshot.
- **`persist(pi)`** — writes current stats as a session entry via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`formatTokens(n)`** — formats token counts like Pi's footer (e.g. `1.2k`, `340`).
- **`formatCost(n)`** — formats cost like `$0.003` or `<$0.001`.
- **`statsSuffix(stats)`** — builds the status widget suffix string (e.g. ` │ ↑1.2k ↓340 $0.003`) or `""` if no calls yet.

### `src/commands.ts` — `/pruner` command + settings overlay + renderer
- **`SettingsOverlay`** — a TUI `Container` subclass that wraps a `SettingsList` with a `DynamicBorder` + title. Forwards `handleInput` and `invalidate` to the inner list so keyboard navigation works inside the overlay.
- **`pruneStatusText(config, stats?)`** — formats the footer widget string including mode label and optional stats suffix: e.g. `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003`.
- **`SUBCOMMANDS`** — `{ value, label }` array for tab-completion and the interactive picker. Includes `settings`, `on`, `off`, `status`, `model`, `thinking`, `prune-on`, `batching`, `stats`, `tree`, `now`, `help`.
- **`HELP_TEXT`** — full explanation of all subcommands, batching mode guidance, prune-on mode guidance, and a note on prompt-cache impact.
- **`getArgumentCompletions(prefix)`** — filters `SUBCOMMANDS` by prefix for tab-completion.
- **Bare `/pruner`** (no args) — calls `ctx.ui.select()` to show an interactive picker over `SUBCOMMANDS`.
- **`/pruner settings`** — opens an interactive `SettingsOverlay` (via `ctx.ui.custom()` with `overlay: true`) containing a `SettingsList` with six items:
  1. **Enabled** — toggle between `true` / `false`
  2. **Prune status line** — toggle the footer status widget and queued turn notifications on/off
  3. **Prune trigger** — cycle through all five `PruneOn` modes
  4. **Summarizer model** — shows current value; pressing Enter opens a searchable submenu listing `"default"` plus all models from `ctx.modelRegistry.getAvailable()`. Selecting a model saves immediately.
  5. **Summarizer thinking** — cycle through all `SummarizerThinking` levels.
  6. **Batching mode** — cycle between `"turn"` and `"agent-message"`.
  All changes are persisted to `settings.json` on every toggle and the footer widget is updated when enabled.
- **`/pruner on|off`** — enables/disables pruning, saves config, calls `syncToolActivation()`, updates footer widget.
- **`/pruner status`** — shows enabled state, summarizer model, thinking level, prune trigger, batching mode, status line visibility, and cumulative summarizer stats (calls, tokens, cost).
- **`/pruner stats`** — shows detailed cumulative summarizer token/cost stats.
- **`/pruner model [value]`** — gets or sets the summarizer model. Accepts `"provider/model-id"` or `"provider/model-id:thinking"` (colon-separated suffix sets both model and thinking level in one command).
- **`/pruner thinking [value]`** — gets or sets the summarizer thinking level; bare form shows `ctx.ui.select()` picker over `SUMMARIZER_THINKING_LEVELS`.
- **`/pruner prune-on [value]`** — gets or sets the trigger mode; bare form shows `ctx.ui.select()` picker over `PRUNE_ON_MODES`.
- **`/pruner batching [value]`** — gets or sets the batching mode (`turn` or `agent-message`); bare form shows `ctx.ui.select()` picker over `BATCHING_MODES`.
- **`/pruner tree`** — builds a `ViewerDocument` from `buildContextEntries()` + indexer, publishes it as latest, and force-opens the shared local web viewer (`http://127.0.0.1:17342/`).
- **`/pruner now`** — previews the pending batch queue via `capturePendingBatches(ctx)` before opening the overlay (exits early with a notification if nothing is pending). Opens a `MultiBatchLoaderOverlay` (via `ctx.ui.custom()` with `overlay: true`) with an invocation-local `AbortController`. Esc/`q` abort the summarizer; the overlay stays open until pending restoration finishes so no flush continues in the background. Progress rows still show running / received-chars / done / skipped.
- **`/pruner help`** — displays `HELP_TEXT` via `ctx.ui.notify`.
- **`default` case** — directs unknown subcommands to run `/pruner help`.
- **Message renderer** for `context-prune-summary` — renders summary messages in the TUI with a styled header (accent color) showing turn index and tool count; collapses to header-only when not expanded, shows full content when expanded.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Pruning only `ToolResultMessage`s | `AssistantMessage` tool-call blocks (which carry IDs) are kept so the model can call `context_tree_query` by ID |
| Two `flushPending` delivery modes | `"runtime"` uses `pi.sendMessage` steer for non-agentic-auto modes; agentic-auto runtime path skips steer (session `appendCustomMessageEntry` + indexer `recordSummary` + context inject) because `context_prune` runs while streaming and steer would re-wake the agent; `"session"` writes via `sessionManager` directly (safe when Pi may be shutting down the session after print-mode runs) |
| `pi.appendEntry` for persistence | Session custom entries survive restarts and branch navigation; index is rebuilt on `session_start` / `session_tree` |
| `summarizerModel: "default"` | Reuses the active model's credentials via `ctx.modelRegistry.getApiKeyAndHeaders()` — no hidden side-channel or extra config needed |
| `summarizerThinking` setting | Lets users trade summarizer cost/latency for quality; `"default"` preserves old behavior (no explicit reasoning option sent) |
| Config in `~/.pi/agent/context-prune/settings.json` | Extension owns its own file — no risk of clobbering other Pi settings, and config persists across all projects |
| Five `pruneOn` trigger modes | `every-turn` (immediate), `on-context-tag` (aligned with save-points), `on-demand` (manual), `agent-message` (batch until final text response), `agentic-auto` (LLM decides via `context_prune` tool) — lets users trade immediacy for batch efficiency |
| `pendingBatches` queue + `flushPending` | Decouples capture (always at `turn_end`) from summarization (mode-dependent). `flushPending` drains all pending batches into a **single** `summarizeBatches` LLM call, reducing round-trips from N to 1. |
| Guarded `agent_end` for `agent-message` flush | `message_end` also fires for `error`/`aborted` assistant messages. `agent_end` is the full-run boundary, is awaited before Pi clears the active run, and still has `ctx.signal` for Esc cancellation. Session delivery captures the appender before the summarizer await. |
| Strict `stop` allow-list | Only `stopReason === "stop"` with no tool calls commits automatic pruning. `error`/`aborted`/`length`/tool-use keep original ToolResults pending. |
| `context_prune` tool always registered, conditionally activated | Keeps Pi's tool registry consistent; `syncToolActivation()` adds/removes it from the active list on every config change without re-registering. |
| `MultiBatchLoaderOverlay` for `/pruner now` | Shows per-batch spinner rows with live streamed summary-character counts, then checks each row off as its LLM call completes — gives concrete progress feedback instead of a single static "summarizing…" message. `/pruner now` uses `flushConcurrency` workers; auto-flush paths keep unbounded parallel per-batch calls |
| `context_prune` onUpdate progress | Keeps the footer status simple while agentic-auto pruning still shows live progress in the running tool output box above the input |
| `capturePendingBatches` extracted from `flushPending` | Lets `/pruner now` preview the queue before opening the overlay so it knows how many rows to pre-build. Avoids double-capture via `previewedBatches` option on `flushPending` |
| `context` handler returns `undefined` when no pruning occurs | Avoids unnecessary message-list reconstruction when nothing was filtered |
| Stats persistence via `CUSTOM_TYPE_STATS` | Stats are snapshots persisted alongside index entries; on `session_start` / `session_tree`, the last snapshot is applied, matching the same lifecycle as the indexer |
| `SummarizeResult` return type | Summarizer functions return `{ summaryText, usage }` so callers can accumulate token/cost data without side effects in the summarizer module |
| Status widget includes stats suffix | Footer shows `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` after summarizer calls, giving users visibility into pruner overhead |
| Auth via `ctx.modelRegistry.getApiKeyAndHeaders()` | Explicit credential resolution for the summarizer LLM call, with error notification on failure |
| Web viewer for `/pruner tree` | Full agent-visible conversation timeline in a browser so developers can compare summaries vs originals; uses compaction-aware context entries, not the full session tree |
| `resolveViewerEntries` skips `getEntries()` | `getEntries()` returns every branch; mixing sibling paths would corrupt the timeline |
| `/pruner tree` always forceOpen browser | Server may still be up after tab close; without forceOpen the command silently "updated" with no visible tab |
| Viewer stops only on `session_shutdown` reason `quit` | Pi also emits shutdown for `/new`/`/resume`/`/fork`/`reload`; stopping there killed the shared tree tab when switching sessions |
| Tab refcount hello/bye + delayed stop | Immediate bye=stop kills multi-tab and mid-refresh; count + 300ms delay stops only when the last tab is truly gone |
| Invocation-local AbortController for `/pruner now` | Manual flush has no active agent signal. Esc/`q` abort that controller; the command waits for pending restoration before closing the overlay so no background flush remains. |
| `userTurnGroup` field on `CapturedBatch` | Assigned in `captureUnindexedBatchesFromSession` by incrementing a counter at every user message — gives `groupBatchesByMode` a stable key to merge turns within the same conversation exchange without changing the live `turn_end` capture path. |
| `batchingMode` is separate from `pruneOn` | `pruneOn` controls *when* to flush; `batchingMode` controls *how coarse* each summary is. Keeping them independent lets users mix e.g. `pruneOn: on-demand` with `batchingMode: agent-message` freely. |

## Agent skills

### Issue tracker

GitHub Issues on `shelken/pi-context-prune` (`gh -R shelken/pi-context-prune`). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` when present). See `docs/agents/domain.md`.
