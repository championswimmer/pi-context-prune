# pi-context-prune

A [Pi coding-agent](https://github.com/badlogic/pi-mono) extension that **summarizes completed tool-call batches**, prunes raw tool outputs from future LLM context, and exposes a `context_tree_query` escape hatch to recover any original output on demand.

## Why

As long agent sessions grow, every tool call adds token-heavy output to the context window. Most of it is not needed verbatim after the first use. This extension:

1. **Detects** when an assistant turn finishes calling tools (`turn_end`)
2. **Summarizes** that batch of tool calls using your configured model
3. **Injects** a compact summary message before the next LLM call (`deliverAs: "steer"`)
4. **Prunes** the original verbose tool outputs from future context (`context` event)
5. **Preserves** every original output in the session index — retrievable at any time via `context_tree_query`

The session file is never modified. Pruning only affects the next request's context build.

## Installation

### Install permanently (recommended)

```bash
# Install globally (all projects)
pi install git:github.com/championswimmer/pi-context-prune

# Or install for the current project only
pi install -l git:github.com/championswimmer/pi-context-prune
```

Once installed, the extension is auto-loaded every time you run `pi`. No flags needed.

### Try without installing

```bash
# Load for this session only (no install)
pi -e git:github.com/championswimmer/pi-context-prune
```

### From source (development)

```bash
git clone https://github.com/championswimmer/pi-context-prune
cd pi-context-prune
pi -e .
```

### Manage installed extensions

```bash
pi list           # show installed packages
pi remove git:github.com/championswimmer/pi-context-prune
```

## Prune-On Modes

The extension supports five trigger modes controlling **when** summarization and pruning happen. Choose the mode that best fits your workflow:

| Mode | Label | Trigger | Best for |
|---|---|---|---|
| `every-turn` | Every turn | Immediately after each tool-calling turn | Maximum context savings; simple and automatic |
| `on-context-tag` | On context tag | When the LLM (or user) calls `context_tag` | Aligns pruning with save-points / milestones |
| `on-demand` | On demand | Only when you run `/pruner now` | Full manual control — nothing is pruned automatically |
| `agent-message` | On agent message | When the agent sends a final text-only response (no tool calls), or when the agent loop ends (default) | Batch multiple tool turns and summarize once at the end of an agentic run |
| `agentic-auto` | Agentic auto | The LLM decides by calling the `context_prune` tool | Let the model manage its own context budget |

### How each mode works

**`every-turn`** — Every time an assistant turn includes tool calls, the results are summarized and pruned immediately. No batching; each turn is independent. The simplest mode.

**`on-context-tag`** — Tool-call turns are batched (queued) until `context_tag` is called (either by the model or the user via a save-point). At that point, all pending batches are summarized in a single LLM call and pruned. Useful when you want pruning to align with natural checkpoints.

**`on-demand`** — Tool-call turns are batched but never summarized automatically. You must run `/pruner now` to flush the queue. Gives you complete control over when summarization happens.

**`agent-message`** — Tool-call turns are batched. When the agent sends a final text-only response (a turn with no tool calls), all pending batches are flushed and summarized. If the agent loop ends before a text-only turn (e.g., aborted), a safety-net flush ensures no batches are lost. Ideal for agentic runs where you want to batch all intermediate tool work and summarize only at the end. This is the default mode.

**`agentic-auto`** — The `context_prune` tool is activated and made available to the LLM. A system prompt instructs the model to call it after completing a meaningful batch of 8–10 related tool calls (and not after every 2–3 trivial calls). When the model calls `context_prune`, all pending batches are flushed. The tool is only active in this mode. If the agent loop ends with remaining pending batches, they are flushed automatically.

## Commands

The extension registers the `/pruner` command:

| Command | Effect |
|---|---|
| `/pruner` | Interactive picker over all subcommands |
| `/pruner settings` | Opens an interactive settings overlay |
| `/pruner on` | Enable pruning |
| `/pruner off` | Disable pruning |
| `/pruner status` | Show enabled state, summarizer model, prune trigger, and cumulative stats |
| `/pruner model` | Show current summarizer model |
| `/pruner model <id>` | Set summarizer model (e.g. `anthropic/claude-haiku-3-5`) |
| `/pruner prune-on` | Interactive picker over all trigger modes |
| `/pruner prune-on <mode>` | Set trigger mode directly |
| `/pruner stats` | Show cumulative summarizer token/cost stats |
| `/pruner tree` | Browse pruned tool calls in a foldable tree browser |
| `/pruner now` | Flush pending tool calls immediately (works in all modes) |
| `/pruner help` | Show full help text |

### Settings overlay

`/pruner settings` opens a TUI overlay with three interactive items:

1. **Enabled** — toggle pruning on/off
2. **Prune trigger** — cycle through all five `pruneOn` modes
3. **Summarizer model** — press Enter to open a searchable submenu listing `"default"` plus all available models

All changes are saved immediately to `~/.pi/agent/context-prune/settings.json` and reflected in the footer status widget.

## Tools

### `context_tree_query`

When pruning is on, the LLM sees compact summary messages instead of raw tool outputs. Each summary ends with:

```
Summarized toolCallIds: `abc12345`, `def67890`
Use `context_tree_query` with these IDs to retrieve the original full outputs.
```

The LLM can call `context_tree_query` with those IDs to get the full original output at any time, without those outputs permanently inflating context. The tool is always available when the extension is loaded.

### `context_prune` (agentic-auto mode only)

When `pruneOn` is set to `agentic-auto`, the `context_prune` tool is activated and made available to the LLM. It is removed from the active tool list in all other modes.

When the model calls `context_prune`:
- All pending tool-call batches are summarized in a single LLM call
- The original outputs are pruned from future context
- A summary message is injected as a steer

The tool is guided by a system prompt that instructs the model to use it after completing a meaningful batch of work (not after every trivial call).

## Configuration

Config is stored in `~/.pi/agent/context-prune/settings.json` (global, project-independent):

```json
{
  "enabled": false,
  "summarizerModel": "default",
  "pruneOn": "every-turn"
}
```

| Key | Values | Default |
|---|---|---|
| `enabled` | `true` / `false` | `false` |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` |
| `pruneOn` | `"every-turn"`, `"on-context-tag"`, `"on-demand"`, `"agent-message"`, `"agentic-auto"` | `"agent-message"` |

- `"default"` means the current active Pi model. An explicit value like `"anthropic/claude-haiku-3-5"` uses that model for summarization (must be registered in Pi and have an API key).
- Settings are persisted on every change via the `/pruner` command or the settings overlay.

## Architecture

```
index.ts                    — entry point, wires events + modules
src/
  types.ts                  — shared types, constants, PruneOn modes
  config.ts                 — load/save ~/.pi/agent/context-prune/settings.json
  batch-capture.ts          — serialize turn_end event → CapturedBatch
  summarizer.ts             — resolve model, call LLM, build summary text
  indexer.ts                — Map<toolCallId, ToolCallRecord> + session persistence
  pruner.ts                 — filter context event messages
  query-tool.ts             — context_tree_query tool registration
  context-prune-tool.ts     — context_prune tool registration (agentic-auto)
  stats.ts                  — StatsAccumulator for cumulative token/cost tracking
  tree-browser.ts           — foldable tree browser for /pruner tree
  commands.ts               — /pruner command + settings overlay + message renderer
```

### Event flow

```
session_start
  └─► loadConfig()              read ~/.pi/agent/context-prune/settings.json
  └─► indexer.reconstruct()     rebuild Map from session branch entries
  └─► statsAccum.reconstruct()  rebuild stats from session branch entries
  └─► syncToolActivation()      activate/deactivate context_prune tool

session_tree
  └─► indexer.reconstruct()     rebuild Map (branch may have different history)
  └─► statsAccum.reconstruct()  rebuild stats (branch may have different history)
  └─► clear pendingBatches      discard queued batches from old branch

turn_end (tool calls present + enabled)
  └─► captureBatch()            serialize the tool call batch
  └─► push to pendingBatches
  └─► if every-turn: flushPending() immediately
  └─► if agent-message (text-only turn): flushPending()
  └─► otherwise: notify user of pending count + trigger

tool_execution_end (context_tag, on-context-tag mode)
  └─► flushPending()

agent_end (agent-message / agentic-auto safety net)
  └─► flushPending()             flush any orphaned pending batches

context_prune tool call (agentic-auto mode)
  └─► flushPending()

flushPending()
  └─► summarizeBatches()         call LLM → summary text + usage stats
  └─► statsAccum.add()           accumulate token/cost stats
  └─► statsAccum.persist()       persist stats to session
  └─► indexer.addBatch()         persist to session via pi.appendEntry
  └─► pi.sendMessage()           inject summary (deliverAs: "steer")

context (enabled + index non-empty)
  └─► pruneMessages()            remove toolResult messages in the index

before_agent_start (agentic-auto mode)
  └─► append AGENTIC_AUTO_SYSTEM_PROMPT to system prompt
```

### Session persistence

- **Config** lives in `~/.pi/agent/context-prune/settings.json` — the extension's own file, independent of Pi's project settings
- **Index** is persisted via `pi.appendEntry("context-prune-index", { toolCalls })` — one entry per summarized batch, NOT in LLM context
- **Summaries** are injected as `custom_message` entries with `customType: "context-prune-summary"` — these ARE in LLM context (replacing the raw outputs)
- The underlying session JSONL file always retains the original `ToolResultMessage` entries unchanged

### Footer status widget

The extension registers a status widget in the Pi footer that shows the current state:

- `prune: OFF (On agent message)` — pruning disabled, showing what mode it would use
- `prune: ON (On agent message)` — pruning active with the current trigger mode
- `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` — pruning active with cumulative stats (input/output tokens, cost)
- `prune: 3 pending` — batches queued, waiting for the trigger
- `prune: summarizing…` — currently running the summarizer LLM call

## v1 Limitations

- Summarization only runs when pruning is **enabled**. If you enable it mid-session, earlier turns are not retroactively summarized.
- The `context_tree_query` tool is only active when the extension is loaded.
- The `context_prune` tool is only activated in `agentic-auto` mode.
- The summarizer call happens synchronously inside `turn_end`, adding latency between turns proportional to the summarizer model's response time.
- The `/pruner tree` browser shows pruned tool calls grouped under their summaries, but does not yet support recovering full original outputs inline (use `context_tree_query` for that).
- Summary grouping across multiple turns (e.g., "compress the last 5 summaries") is a follow-up item.

## Follow-up ideas

- Auto-summarize older unsummarized turns on `/pruner on`
- Batch multiple turn summaries into a single meta-summary at compaction time
- ~~`/pruner original-tree`~~ ✅ `/pruner tree` foldable tree browser — done
- Configurable pruning policy (prune only large tool results, prune by token count threshold)
- Tighter `/settings` integration once Pi exposes a settings UI API