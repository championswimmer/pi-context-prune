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
    ├── batch-capture.ts           # Serialize turn_end events into CapturedBatch objects
    ├── summarizer.ts              # LLM call that summarizes a CapturedBatch to markdown
    ├── indexer.ts                 # Runtime Map<toolCallId, ToolCallRecord> + session persistence
    ├── pruner.ts                  # Filter context event messages (removes summarized ToolResultMessages)
    ├── query-tool.ts              # Register the context_tree_query tool for recovering pruned outputs
    ├── context-prune-tool.ts      # Register the context_prune tool for agentic-auto mode
    ├── tree-browser.ts            # TreeBrowser TUI component + buildPruneTree for /pruner tree
    ├── stats.ts                   # StatsAccumulator for cumulative summarizer token/cost tracking
    └── commands.ts                # /pruner command + interactive settings overlay + summary message renderer
```

### `index.ts` — Extension entry point
Wires all modules together and registers Pi event handlers:
- **`pendingBatches: CapturedBatch[]`** — queue of captured batches not yet summarized; drained by `flushPending`.
- **`flushPending(ctx, options?)`** — summarizes + indexes all pending batches in a **single LLM call**. Accepts `{ delivery?: "runtime" | "session" }`: `"runtime"` uses `pi.sendMessage(..., { deliverAs: "steer" })` (default, used during an active agent loop); `"session"` writes directly via `sessionManager.appendCustomMessageEntry` (used for `every-turn` and `agent-message` modes where Pi may be shutting down by the time the summarizer returns). Sets status to "prune: summarizing…" while working, then restores the status widget with stats (e.g. `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003`). Returns a typed `FlushResult` (`{ ok: true, batchCount, toolCallCount }` or `{ ok: false, reason, error? }`). Batches that fail to flush are atomically restored to `pendingBatches`.
- **`syncToolActivation()`** — activates or deactivates the `context_prune` tool in the Pi active-tools list based on whether `enabled && pruneOn === "agentic-auto"`. Uses `pi.getActiveTools()` / `pi.setActiveTools()` (ExtensionAPI, not ExtensionContext).
- **`session_start`** — loads config from `~/.pi/agent/context-prune/settings.json`, rebuilds the in-memory index and stats accumulator, clears `pendingBatches`, updates the footer status widget, calls `syncToolActivation()`, and notifies the user of the loaded state.
- **`session_tree`** — rebuilds the index and stats accumulator after branch navigation (pending batches and stats belong to the current branch).
- **`turn_end`** — captures the batch (filtering out any `context_prune` tool call to avoid re-queuing agentic-auto housekeeping), pushes to `pendingBatches`. Behavior depends on `pruneOn` mode:
  - `every-turn`: flushes immediately with `delivery: "session"`.
  - `on-context-tag` / `on-demand` / `agent-message` / `agentic-auto`: queues and notifies the user of pending count and trigger.
- **`tool_execution_end`** — when `event.toolName === "context_tag"` and mode is `on-context-tag`, calls `flushPending` with `delivery: "runtime"`.
- **`message_end`** — when mode is `agent-message` and the message is a final text-only assistant response (no tool calls), calls `flushPending` with `delivery: "session"`. This is the primary flush path for `agent-message` mode.
- **`agent_end`** — safety net: if pending batches still remain (e.g. because no `message_end` fired before session shutdown), updates the status widget to show the pending count. Does **not** attempt a best-effort LLM call here to avoid starting async work after Pi may have already disposed the session.
- **`before_agent_start`** — when mode is `agentic-auto` and pruning is enabled, appends `AGENTIC_AUTO_SYSTEM_PROMPT` to the system prompt so the LLM knows when and how to call `context_prune`.
- **`context`** — filters the message array sent to the LLM, removing `ToolResultMessage` entries that have been summarized. Returns `undefined` (no change) if the index is empty or no messages were removed.

### `src/types.ts` — Shared types and constants
Single source of truth for all interfaces and constants:
- **`CapturedBatch`** / **`CapturedToolCall`** — snapshot of one assistant turn's tool calls + results. `CapturedBatch` also carries `assistantText` (any non-tool-call text from the assistant message).
- **`ToolCallRecord`** — full record stored in the runtime index (includes original `resultText`).
- **`IndexEntryData`** — data shape written to session via `pi.appendEntry` for persistence across restarts.
- **`PruneOn`** — `"every-turn" | "on-context-tag" | "on-demand" | "agent-message" | "agentic-auto"` — when summarization is triggered:
  - `every-turn`: summarize after every tool-calling turn.
  - `on-context-tag`: batch turns, flush when `context_tag` is called.
  - `on-demand`: only when the user runs `/pruner now`.
  - `agent-message`: batch turns, flush when the agent sends a final text-only response (default).
  - `agentic-auto`: the LLM decides when to prune by calling the `context_prune` tool, guided by `AGENTIC_AUTO_SYSTEM_PROMPT`.
- **`SummarizerThinking`** — `"default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` — reasoning effort level to pass to the summarizer LLM. `"default"` omits the option entirely (provider default); other values set `reasoningEffort` in the `complete()` call options.
- **`PRUNE_ON_MODES`** — `{ value, label }` array for interactive selectors.
- **`SUMMARIZER_THINKING_LEVELS`** — `{ value, label }` array for interactive selectors.
- **`ContextPruneConfig`** — `{ enabled, summarizerModel, summarizerThinking, pruneOn }` stored in `~/.pi/agent/context-prune/settings.json`.
- **`SummarizerStats`** — cumulative token/cost stats: `{ totalInputTokens, totalOutputTokens, totalCost, callCount }`. Persisted via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`SummarizeResult`** — return type from summarizer: `{ summaryText, usage }` carrying both the markdown summary and LLM usage data.
- **`SummaryMessageDetails`** — metadata attached to `context-prune-summary` custom messages.
- Constants: `CUSTOM_TYPE_SUMMARY`, `CUSTOM_TYPE_INDEX`, `CUSTOM_TYPE_STATS`, `STATUS_WIDGET_ID`, `DEFAULT_CONFIG`, `CONTEXT_PRUNE_TOOL_NAME`, `AGENTIC_AUTO_SYSTEM_PROMPT`.

### `src/config.ts` — Config persistence
- **`SETTINGS_PATH`** — constant resolving to `~/.pi/agent/context-prune/settings.json` (global, project-independent).
- **`loadConfig()`** — reads `SETTINGS_PATH`, parses JSON, merges with `DEFAULT_CONFIG`. Returns defaults on any read/parse error.
- **`saveConfig(config)`** — creates the directory if needed (`mkdir recursive`) then writes the full config as the file root (no key wrapping).

### `src/batch-capture.ts` — Turn capture and serialization
- **`captureBatch(message, toolResults, turnIndex, timestamp)`** — converts raw `turn_end` event data into a typed `CapturedBatch`. Extracts `assistantText` from `TextContent` blocks and matches each `ToolCall` content block in the `AssistantMessage` with its corresponding `ToolResultMessage` by `toolCallId`. Falls back to `"(no result)"` if no match is found for a tool call.
- **`serializeBatchForSummarizer(batch)`** — renders a single `CapturedBatch` as plain text for the summarizer LLM. Includes `assistantText` as a header if present. Truncates individual result text at 2 000 chars to keep the summarizer prompt manageable.
- **`serializeBatchesForSummarizer(batches)`** — renders multiple `CapturedBatch` objects into a single text block for batched summarization. Each batch is rendered as a `=== Turn N ===` section, separated by blank lines. Reuses `serializeBatchForSummarizer` for each batch's body.

### `src/summarizer.ts` — LLM summarization
- **`summarizerThinkingOptions(config)`** — translates `config.summarizerThinking` into a `complete()` options object. `"default"` returns `{}`; `"off"` returns `{ reasoningEffort: undefined }`; all other levels return `{ reasoningEffort: level }`. Provider adapters translate `reasoningEffort` into the provider-specific field.
- **`resolveModel(config, ctx)`** — resolves `config.summarizerModel` to a model instance. `"default"` returns `ctx.model`; `"provider/model-id"` splits on `/` and looks up via `ctx.modelRegistry.find(provider, modelId)` with a fallback to `ctx.model` + warning on failure.
- **`summarizeBatch(batch, config, ctx)`** — summarizes a single `CapturedBatch` in one LLM call. Returns `SummarizeResult` (summary text + usage) on success, `null` on failure.
- **`summarizeBatches(batches, config, ctx)`** — summarizes multiple `CapturedBatch` objects in a **single LLM call**. If only one batch, delegates to `summarizeBatch`. Returns `SummarizeResult` on success, `null` on failure.

### `src/indexer.ts` — `ToolCallIndexer` class
Maintains the runtime `Map<toolCallId, ToolCallRecord>` and handles session persistence:
- **`reconstructFromSession(ctx)`** — scans the current branch's session entries for `CUSTOM_TYPE_INDEX` custom entries and repopulates the in-memory map.
- **`addBatch(batch, pi)`** — adds all records from a batch to the map and calls `pi.appendEntry(CUSTOM_TYPE_INDEX, ...)` to persist them so they survive restarts and branch switches.
- **`isSummarized(toolCallId)`** — used by the pruner to decide which messages to drop.
- **`getRecord(toolCallId)`** / **`lookupToolCalls(ids)`** — used by the query tool and tree-browser to retrieve full original outputs.

### `src/pruner.ts` — Context message filter
- **`pruneMessages(messages, indexer)`** — filters the `context` event's message array. Drops any message with `role === "toolResult"` whose `toolCallId` is present in the index. All other messages (including `AssistantMessage` tool-call blocks that carry the IDs) are kept so the model can still reference them when calling `context_tree_query`.

### `src/query-tool.ts` — `context_tree_query` tool
Registers a Pi tool that allows the LLM (or user) to recover pruned outputs:
- Accepts `{ toolCallIds: string[] }`.
- Looks up each ID in the indexer; returns full `resultText` (truncated via Pi's `truncateHead` helper with `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`) along with tool name, args, status, and turn index.
- IDs not found in the index return a "(not found)" notice rather than an error.
- Returns `{ content, details: { results } }` with found records in the `details` field.

### `src/context-prune-tool.ts` — `context_prune` tool (agentic-auto mode)
Registers the `context_prune` tool with Pi. The tool is **always registered** (so Pi knows about it), but is only added to the active tools list when `pruneOn === "agentic-auto"` and `enabled === true`. Activation/deactivation is handled in `index.ts` via `syncToolActivation()` → `pi.setActiveTools()`.
- Takes no parameters — calling it flushes all pending batches via `flushPending(ctx, { delivery: "runtime" })`.
- Returns a typed `FlushResult` describing how many batches and tool calls were summarized, or a reason if the flush did not run (empty, already-flushing, stale-context, etc.).
- Carries `promptSnippet` and `promptGuidelines` so the LLM is guided to call it after batches of 8–10 tool calls, not after every 2–3.

### `src/tree-browser.ts` — `TreeBrowser` TUI component
Provides a foldable interactive tree view of pruned tool calls, opened by `/pruner tree`.
- **`buildPruneTree(ctx, indexer)`** — scans the current session branch for `CUSTOM_TYPE_SUMMARY` entries and constructs a `TreeNode[]` where each summary is a parent node and its pruned tool calls are children. Each node carries a `charCount` (character count of the result text) so the UI can show space savings at a glance.
- **`TreeNode`** — `{ id, label, children, expanded, depth, isLeaf, detail?, charCount? }`. Summary nodes carry their markdown summary text in `detail`; tool-call leaf nodes carry a 200-char result preview.
- **`TreeBrowser`** — a `Component` (Pi TUI interface) implementing a scrollable keyboard-navigable tree:
  - Arrow keys move selection; `Enter`/`Space` expand/collapse parent nodes.
  - `Ctrl-O` opens a **summary overlay** for the selected summary node — a centered box rendering the full markdown summary with scroll support.
  - `Esc`/`q` closes the overlay (or the browser if no overlay is open).
  - Renders via `boxLines()` (a local box-drawing helper that draws `┌─┐` borders with a title).
  - The overlay uses the `Markdown` TUI renderer with `getMarkdownTheme()` for styled summary display.

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
- **`SUBCOMMANDS`** — `{ value, label }` array for tab-completion and the interactive picker. Includes `settings`, `on`, `off`, `status`, `model`, `thinking`, `prune-on`, `stats`, `tree`, `now`, `help`.
- **`HELP_TEXT`** — full explanation of all subcommands, mode guidance, and a note on prompt-cache impact.
- **`getArgumentCompletions(prefix)`** — filters `SUBCOMMANDS` by prefix for tab-completion.
- **Bare `/pruner`** (no args) — calls `ctx.ui.select()` to show an interactive picker over `SUBCOMMANDS`.
- **`/pruner settings`** — opens an interactive `SettingsOverlay` (via `ctx.ui.custom()` with `overlay: true`) containing a `SettingsList` with four items:
  1. **Enabled** — toggle between `true` / `false`
  2. **Prune trigger** — cycle through all five `PruneOn` modes
  3. **Summarizer model** — shows current value; pressing Enter opens a searchable submenu listing `"default"` plus all models from `ctx.modelRegistry.getAvailable()`. Selecting a model saves immediately.
  4. **Summarizer thinking** — cycle through all `SummarizerThinking` levels.
  All changes are persisted to `settings.json` on every toggle and the footer widget is updated.
- **`/pruner on|off`** — enables/disables pruning, saves config, calls `syncToolActivation()`, updates footer widget.
- **`/pruner status`** — shows enabled state, summarizer model, thinking level, prune trigger, and cumulative summarizer stats (calls, tokens, cost).
- **`/pruner stats`** — shows detailed cumulative summarizer token/cost stats.
- **`/pruner model [value]`** — gets or sets the summarizer model. Accepts `"provider/model-id"` or `"provider/model-id:thinking"` (colon-separated suffix sets both model and thinking level in one command).
- **`/pruner thinking [value]`** — gets or sets the summarizer thinking level; bare form shows `ctx.ui.select()` picker over `SUMMARIZER_THINKING_LEVELS`.
- **`/pruner prune-on [value]`** — gets or sets the trigger mode; bare form shows `ctx.ui.select()` picker over `PRUNE_ON_MODES`.
- **`/pruner tree`** — builds a `TreeNode[]` via `buildPruneTree()` and opens a `TreeBrowser` via `ctx.ui.custom()` so the user can browse pruned tool calls interactively.
- **`/pruner now`** — calls `flushPending(ctx)` immediately; guards against pruning being disabled.
- **`/pruner help`** — displays `HELP_TEXT` via `ctx.ui.notify`.
- **`default` case** — directs unknown subcommands to run `/pruner help`.
- **Message renderer** for `context-prune-summary` — renders summary messages in the TUI with a styled header (accent color) showing turn index and tool count; collapses to header-only when not expanded, shows full content when expanded.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Pruning only `ToolResultMessage`s | `AssistantMessage` tool-call blocks (which carry IDs) are kept so the model can call `context_tree_query` by ID |
| Two `flushPending` delivery modes | `"runtime"` uses `pi.sendMessage` steer (safe during active agent loops); `"session"` writes via `sessionManager` directly (safe when Pi may be shutting down the session after print-mode runs) |
| `pi.appendEntry` for persistence | Session custom entries survive restarts and branch navigation; index is rebuilt on `session_start` / `session_tree` |
| `summarizerModel: "default"` | Reuses the active model's credentials via `ctx.modelRegistry.getApiKeyAndHeaders()` — no hidden side-channel or extra config needed |
| `summarizerThinking` setting | Lets users trade summarizer cost/latency for quality; `"default"` preserves old behavior (no explicit reasoning option sent) |
| Config in `~/.pi/agent/context-prune/settings.json` | Extension owns its own file — no risk of clobbering other Pi settings, and config persists across all projects |
| Five `pruneOn` trigger modes | `every-turn` (immediate), `on-context-tag` (aligned with save-points), `on-demand` (manual), `agent-message` (batch until final text response), `agentic-auto` (LLM decides via `context_prune` tool) — lets users trade immediacy for batch efficiency |
| `pendingBatches` queue + `flushPending` | Decouples capture (always at `turn_end`) from summarization (mode-dependent). `flushPending` drains all pending batches into a **single** `summarizeBatches` LLM call, reducing round-trips from N to 1. |
| `message_end` instead of `turn_end` for `agent-message` flush | `message_end` fires reliably at the final text-only response and before session teardown, giving time to capture the sessionManager before awaiting the summarizer LLM call. `turn_end` in print mode fires too late. |
| `agent_end` as status update only | Avoids starting async LLM work after Pi may have disposed the session. If batches remain, the user sees a "N pending" status and can `/pruner now` next session. |
| `context_prune` tool always registered, conditionally activated | Keeps Pi's tool registry consistent; `syncToolActivation()` adds/removes it from the active list on every config change without re-registering. |
| `SettingsOverlay` wrapper | Required because `Container` alone doesn't forward keyboard input — the wrapper delegates `handleInput`/`invalidate` to the inner `SettingsList` |
| `context` handler returns `undefined` when no pruning occurs | Avoids unnecessary message-list reconstruction when nothing was filtered |
| Stats persistence via `CUSTOM_TYPE_STATS` | Stats are snapshots persisted alongside index entries; on `session_start` / `session_tree`, the last snapshot is applied, matching the same lifecycle as the indexer |
| `SummarizeResult` return type | Summarizer functions return `{ summaryText, usage }` so callers can accumulate token/cost data without side effects in the summarizer module |
| Status widget includes stats suffix | Footer shows `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` after summarizer calls, giving users visibility into pruner overhead |
| Auth via `ctx.modelRegistry.getApiKeyAndHeaders()` | Explicit credential resolution for the summarizer LLM call, with error notification on failure |
| `TreeBrowser` for `/pruner tree` | Gives users a visual, keyboard-navigable audit trail of what was pruned and how much space was saved, without leaving the Pi TUI |
