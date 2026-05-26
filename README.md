# pi-context-prune

A [Pi coding-agent](https://github.com/badlogic/pi-mono) extension that **summarizes completed tool-call batches**, prunes raw tool outputs from future LLM context, and exposes a `context_tree_query` escape hatch to recover any original output on demand.

## Related Extensions

Here are some other Pi extensions that work well alongside context pruning:

*   **[pi-context-usage](https://github.com/championswimmer/pi-context-usage) ([npm](https://www.npmjs.com/package/pi-context-usage))**
    *   **What it does:** Visualizes the current size of your LLM context and breaks it down to show exactly what is taking up space (system prompt, user messages, tool calls, tool results, etc.).
    *   **Why use it:** It's the perfect way to see *why* you need pruning. You can use it to inspect your context before and after a prune to see exactly how much space the `pi-context-prune` extension just saved you.
*   **[pi-cache-graph](https://github.com/championswimmer/pi-cache-graph) ([npm](https://www.npmjs.com/package/pi-cache-graph))**
    *   **What it does:** Plots your provider's prefix cache hits and misses as a live graph inside the TUI.
    *   **Why use it:** Pruning context directly impacts cache re-use. This extension lets you see the real-time effect of your chosen `pruneOn` mode on cache stability.

---

## Why

> 📖 For a deep dive into how pruning works, how prefix caching interacts with it, and the research behind summarization-based context management, see [**PRUNING.md**](PRUNING.md).

As long agent sessions grow, every tool call adds token-heavy output to the context window. Most of it is not needed verbatim after the first use. This extension:

1. **Detects** when an assistant turn finishes calling tools (`turn_end`)
2. **Summarizes** that batch of tool calls using your configured model
3. **Injects** a compact summary message before the next LLM call (`deliverAs: "steer"`)
4. **Prunes** the original verbose tool outputs from future context (`context` event)
5. **Preserves** every original output in the session index — retrievable at any time via `context_tree_query`

The session file is never modified. Pruning only affects the next request's context build.

## Installation

### Install from npm (stable releases)

The package is published on [npmjs.org](https://www.npmjs.com/package/pi-context-prune). Use this for stable, versioned releases:

```bash
# Install globally (all projects)
pi install npm:pi-context-prune

# Or install for the current project only
pi install -l npm:pi-context-prune
```

Once installed, the extension is auto-loaded every time you run `pi`. No flags needed.

To **upgrade to a newer release**, simply re-run the install command — Pi will pull the latest version from npm.

### Install from GitHub (cutting-edge / main branch)

If you want the latest unreleased changes from `main`, install directly from the git repository:

```bash
# Install globally (all projects)
pi install git:github.com/championswimmer/pi-context-prune

# Or install for the current project only
pi install -l git:github.com/championswimmer/pi-context-prune
```

> **Note:** The `main` branch may contain unreleased or experimental changes. Prefer the npm install for day-to-day use.

### Try without installing

```bash
# Load for this session only (no install)
pi -e npm:pi-context-prune

# Or try the latest from git without installing
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
pi remove pi-context-prune
```

## Prune-On Modes

The extension supports five trigger modes controlling **when** summarization and pruning happen.

### Cache-aware guidance

This extension rewrites the **future request context** by replacing old raw `toolResult` messages with a compact summary. That saves tokens, but it also changes the prompt prefix seen by the model.

On providers with **prefix / prompt caching** (for example Anthropic-style prompt caching), cache hits require the earlier prompt prefix to stay identical. If you keep changing earlier context, the provider has to recompute from the point of change onward, which means **higher latency, higher input cost, and fewer cache hits**. In other words: pruning too often can save tokens in-context while still hurting overall performance by repeatedly busting the provider cache.

That is why **`agent-message` is the default**: it batches a whole stretch of tool work, prunes **once** when the agent is done and sends a final text reply, and then leaves the new shorter context stable again. You usually pay one cache bust per meaningful work batch instead of one cache bust per tool turn.

References:
- Anthropic prompt caching docs: <https://docs.claude.com/en/docs/build-with-claude/prompt-caching>
- AWS Bedrock prompt caching overview: <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html>
- `pi-context` extension (`context_tag`, `context_log`, `context_checkout`): <https://github.com/ttttmr/pi-context>

### Mode trade-offs

| Mode | Trigger | Pros | Cons / cache impact | Recommendation |
|---|---|---|---|---|
| `every-turn` | Immediately after each tool-calling turn | Smallest raw context as fast as possible; easiest to reason about | **Busts prompt cache the most often** because earlier context is rewritten after almost every tool turn; adds summarizer latency every turn; can cost more overall despite saving context tokens | **Debugging only.** Useful to test the extension, inspect summaries, or study behavior — not recommended for normal day-to-day use |
| `on-context-tag` | When `context_tag` is called | Lets you align pruning with explicit milestones / save-points; fewer cache busts than `every-turn` if you tag sparingly | Only auto-triggers if you have the [`pi-context`](https://github.com/ttttmr/pi-context) extension installed, because that extension provides the `context_tag` tool; if you tag too often, you still churn cache; if you forget to tag, pending batches keep growing | Good if you already use `pi-context` and think in checkpoints / milestones |
| `on-demand` | Only when you run `/pruner now` | Maximum manual control; easiest mode for preserving cache because nothing changes until you decide; good for long investigations where you want to delay pruning | Easy to forget; pending batches can grow large; you must manage timing yourself | Good for advanced users who want explicit control over when the cache is intentionally invalidated |
| `agent-message` | When the agent sends a final text-only response, or when the agent loop ends | Best balance of automation, context savings, and cache friendliness; batches many tool turns into one prune; after the prune, future requests become highly cacheable again until the next batch finishes | You do not reclaim space mid-batch; if a run goes extremely long before the final reply, context can grow more than in aggressive modes | **Recommended default.** Safest general-purpose mode for normal coding-agent workflows |
| `agentic-auto` | The model decides by calling `context_prune` | Lets the agent compact context before it gets too large; can work well for long autonomous runs when the model is disciplined | Depends on model judgment; if the model calls `context_prune` too often, it can churn cache similarly to `every-turn`; behavior is less predictable than `agent-message` | Good for longer autonomous sessions after prompt-tuning and observation |

### How each mode works

**`every-turn`** — Every tool-calling turn is summarized and pruned immediately. This is intentionally aggressive. It is useful for debugging the extension or validating summaries, but in real work it usually rewrites the prompt prefix too frequently and hurts provider-side prompt caching.

**`on-context-tag`** — Tool-call turns are queued until `context_tag` is called, then all pending batches are summarized in one LLM call and pruned together. This mode is meant to pair with the [`pi-context`](https://github.com/ttttmr/pi-context) extension; without that extension, `context_tag` is not available, so this mode will not auto-trigger unless you switch modes or flush manually with `/pruner now`.

**`on-demand`** — Tool-call turns are batched but never summarized automatically. You decide when to flush with `/pruner now`. This is the most manual mode and also the easiest to keep cache-friendly, because you can wait until a large chunk of work is complete before changing earlier context.

**`agent-message`** — Tool-call turns are batched. When the agent finally replies with a normal text answer (a turn with no tool calls), all pending batches are summarized and pruned together. If the agent loop ends before that happens, a safety-net flush runs on `agent_end`. This mode is the default because it usually causes just one context rewrite per meaningful task batch.

**`agentic-auto`** — The `context_prune` tool is activated and exposed to the LLM. The system prompt tells the model to use it only after a meaningful batch of related tool calls, not after every small step. Used well, this gives the agent flexibility; used badly, it can over-prune and reduce cache effectiveness.

## Commands

The extension registers the `/pruner` command:

| Command | Effect |
|---|---|
| `/pruner` | Interactive picker over all subcommands |
| `/pruner settings` | Opens an interactive settings overlay |
| `/pruner on` | Enable pruning |
| `/pruner off` | Disable pruning |
| `/pruner status` | Show enabled state, summarizer model, thinking level, prune trigger, and cumulative stats |
| `/pruner model` | Show current summarizer model |
| `/pruner model <id>` | Set summarizer model (e.g. `anthropic/claude-haiku-3-5`) |
| `/pruner model <id>:<thinking>` | Set summarizer model and thinking together (e.g. `openai/gpt-5-mini:low`) |
| `/pruner thinking` | Show current summarizer thinking level |
| `/pruner thinking <level>` | Set summarizer thinking (`default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `/pruner prune-on` | Interactive picker over all trigger modes |
| `/pruner prune-on <mode>` | Set trigger mode directly |
| `/pruner stats` | Show cumulative summarizer token/cost stats |
| `/pruner tree` | Browse pruned tool calls in a foldable tree browser; press `Ctrl-O` on a summary to open it in a bordered overlay |
| `/pruner now` | Flush pending tool calls immediately (works in all modes) with a live progress overlay that shows streamed received-character counts per batch |
| `/pruner help` | Show full help text |

### Settings overlay

`/pruner settings` opens a TUI overlay with five interactive items:

1. **Enabled** — toggle pruning on/off
2. **Prune status line** — show or hide the footer status widget and queued turn notifications
3. **Prune trigger** — cycle through all five `pruneOn` modes
4. **Summarizer model** — press Enter to open a searchable submenu listing `"default"` plus all available models
5. **Summarizer thinking** — cycle through the thinking/reasoning level used for summarizer calls

All changes are saved immediately to `<agent-dir>/context-prune/settings.json` and reflected in the footer status widget when it is enabled. `<agent-dir>` is whatever pi resolves for the current session — `$PI_CODING_AGENT_DIR` if set (with tilde expansion), otherwise `~/.pi/agent`. Each preset directory therefore gets its own settings file, including its own summarizer model.

## Tools

### `context_tree_query`

When pruning is on, the LLM sees compact summary messages instead of raw tool outputs. Each summary ends with short aliases such as:

```
Summarized tool refs: `t1`, `t2`
Use `context_tree_query` with these refs to retrieve the original full outputs.
```

Those short refs are generated by the extension and mapped back to the real `toolCallId`s in the summary message metadata. The LLM only sees the short refs in future context; the full IDs stay in the stored details used by `context_tree_query` and internal tree/browser recovery. The tool is always available when the extension is loaded.

### `context_prune` (agentic-auto mode only)

When `pruneOn` is set to `agentic-auto`, the `context_prune` tool is activated and made available to the LLM. It is removed from the active tool list in all other modes.

When the model calls `context_prune`:
- All pending tool-call batches are summarized together (parallel one-call-per-batch by default, or sequentially in `/pruner now` so the overlay can show live progress)
- While the tool is running, compact live progress is streamed into the tool output box above the input (for example `Context prune running… batch 2/4 · 1.2k chars received`)
- If the summary is smaller than the raw tool-result text it would replace, the original outputs are pruned from future context and a summary message is injected as a steer
- If the summary is larger than the raw tool-result text, pruning is skipped for that attempted range: the original tool results remain in context, but the prune frontier still advances so the next prune attempt starts after that range instead of retrying it forever

The tool is guided by a system prompt that instructs the model to use it after completing a meaningful batch of work (not after every trivial call).

## Configuration

Config is stored in `<agent-dir>/context-prune/settings.json` (project-independent, but scoped to the active pi agent directory — `$PI_CODING_AGENT_DIR` or `~/.pi/agent`):

```json
{
  "enabled": false,
  "showPruneStatusLine": true,
  "summarizerModel": "default",
  "summarizerThinking": "default",
  "pruneOn": "agent-message",
  "remindUnprunedCount": true
}
```

| Key | Values | Default |
|---|---|---|
| `enabled` | `true` / `false` | `false` |
| `showPruneStatusLine` | `true` / `false` | `true` |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` |
| `summarizerThinking` | `"default"`, `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` | `"default"` |
| `pruneOn` | `"every-turn"`, `"on-context-tag"`, `"on-demand"`, `"agent-message"`, `"agentic-auto"` | `"agent-message"` |
| `remindUnprunedCount` | `true` / `false` | `true` |

- `showPruneStatusLine: true` keeps the prune footer widget and the automatic queued-turn notice visible. Turn it off if you want pruning to stay active without the extra status noise.
- `remindUnprunedCount: true` appends a small ephemeral `<pruner-note>` to the last tool result before each LLM call to remind the model of the number of unpruned tool calls in context. This only has an effect when `pruneOn` is set to `"agentic-auto"`.

- `summarizerModel: "default"` means the current active Pi model. An explicit value like `"anthropic/claude-haiku-3-5"` uses that model for summarization (must be registered in Pi and have an API key).
- `summarizerThinking: "default"` preserves old behavior: no explicit thinking/reasoning option is added to summarizer calls.
- `summarizerThinking: "off"` requests no summarizer reasoning where the provider adapter supports an explicit disable path. Some providers may still fall back to their own default behavior.
- `"minimal"`, `"low"`, `"medium"`, `"high"`, and `"xhigh"` request that thinking level for summarizer calls where supported. For cheap background summarization, prefer `"minimal"` or `"low"` with a small/fast model.
- Settings are persisted on every change via the `/pruner` command or the settings overlay.

### Choosing a Summarizer Model

The default (`"default"`) reuses whatever model you have active in Pi. **This is convenient but wasteful** — you don't need a powerful coding model to write a bullet-point summary of tool outputs. Using a cheaper, faster model here reduces both latency and cost without any quality trade-off.

> **Rule of thumb:** pick the smallest/fastest model available on your current subscription or API plan.

| Subscription / API plan | Recommended summarizer model |
|---|---|
| GitHub Copilot / Codex | `openai/gpt-4.1-mini` or `google/gemini-2.5-flash` or `xai/grok-3-fast` |
| OpenRouter | `openrouter/qwen/qwen3-30b-a3b` (fast MoE, very cheap) |
| Anthropic direct | `anthropic/claude-haiku-3-5` |
| Google AI direct | `google/gemini-2.5-flash` |

Set it with:

```bash
/pruner model openai/gpt-4.1-mini
/pruner thinking low

# Or set both at once:
/pruner model openai/gpt-4.1-mini:low

# Or via the interactive settings overlay
/pruner settings
```

Or directly in `<agent-dir>/context-prune/settings.json`:

```json
{
  "summarizerModel": "openrouter/qwen/qwen3-30b-a3b",
  "summarizerThinking": "low"
}
```

## Architecture

```
index.ts                    — entry point, wires events + modules
src/
  types.ts                  — shared types, constants, PruneOn modes
  config.ts                 — load/save <agent-dir>/context-prune/settings.json (honors PI_CODING_AGENT_DIR)
  batch-capture.ts          — serialize turn_end event → CapturedBatch
  summarizer.ts             — resolve model, call LLM, build summary text
  indexer.ts                — Map<toolCallId, ToolCallRecord> + session persistence
  pruner.ts                 — filter context event messages
  query-tool.ts             — context_tree_query tool registration
  context-prune-tool.ts     — context_prune tool registration (agentic-auto)
  frontier.ts               — persisted prune-frontier tracker for last attempted prune boundary
  stats.ts                  — StatsAccumulator for cumulative token/cost tracking
  tree-browser.ts           — foldable tree browser for /pruner tree
  commands.ts               — /pruner command + settings overlay + message renderer
```

### Event flow

```
session_start
  └─► loadConfig()              read <agent-dir>/context-prune/settings.json
  └─► indexer.reconstruct()     rebuild Map from session branch entries
  └─► statsAccum.reconstruct()  rebuild stats from session branch entries
  └─► frontier.reconstruct()    rebuild last prune-attempt boundary from session entries
  └─► syncToolActivation()      activate/deactivate context_prune tool

session_tree
  └─► indexer.reconstruct()     rebuild Map (branch may have different history)
  └─► statsAccum.reconstruct()  rebuild stats (branch may have different history)
  └─► frontier.reconstruct()    rebuild last prune-attempt boundary for the branch
  └─► clear pendingBatches      discard queued batches from old branch

turn_end (tool calls present + enabled)
  └─► captureBatch()            serialize the tool call batch
  └─► trim against index/frontier so same-turn later tool calls survive an earlier mid-turn prune
  └─► push remaining tool calls to pendingBatches
  └─► if every-turn: flushPending() immediately
  └─► otherwise: notify user of pending count + trigger

tool_execution_end (context_tag, on-context-tag mode)
  └─► flushPending()

agent_end
  └─► update footer status only if batches remain pending

context_prune tool call (agentic-auto mode)
  └─► flushPending()

flushPending()
  └─► scan the session branch for completed unpruned tool results, including mid-turn subsets
  └─► trim against index/frontier so already-attempted prefixes are ignored
  └─► summarizeBatches()         call LLM(s) → summary text + usage stats
  └─► compare summary chars vs raw tool-result chars
  └─► if smaller: persist index + inject summary, then advance frontier
  └─► if larger: keep original tool results, skip summary/index writes, still advance frontier
  └─► statsAccum.add()/persist() accumulate token/cost stats for the summarizer call

context (enabled + index non-empty)
  └─► pruneMessages()            remove toolResult messages in the index

before_agent_start (agentic-auto mode)
  └─► append AGENTIC_AUTO_SYSTEM_PROMPT to system prompt
```

### Session persistence

- **Config** lives in `<agent-dir>/context-prune/settings.json` — the extension's own file, independent of Pi's project settings. `<agent-dir>` resolves through pi's `getAgentDir()` so it honors `PI_CODING_AGENT_DIR` (default `~/.pi/agent`)
- **Index** is persisted via `pi.appendEntry("context-prune-index", { toolCalls })` — one entry per summarized batch, NOT in LLM context
- **Prune frontier** is persisted via `pi.appendEntry("context-prune-frontier", ...)` — it records the last attempted prune boundary even when an oversized summary is rejected
- **Summaries** are injected as `custom_message` entries with `customType: "context-prune-summary"` — these ARE in LLM context (replacing the raw outputs only when pruning is accepted). Their visible text uses short refs, while the `details.toolCallRefs` metadata keeps the full `toolCallId` mapping for later recovery.
- The underlying session JSONL file always retains the original `ToolResultMessage` entries unchanged

### Footer status widget

The extension registers a status widget in the Pi footer that shows the current state:

- `prune: OFF (On agent message)` — pruning disabled, showing what mode it would use
- `prune: ON (On agent message)` — pruning active with the current trigger mode
- `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` — pruning active with cumulative stats (input/output tokens, cost)
- `prune: 3 pending` — batches queued, waiting for the trigger
- `prune: summarizing…` — currently running the summarizer LLM call
- Live progress details are shown in richer surfaces instead: `/pruner now` uses the multi-row overlay, and agentic-auto `context_prune` streams updates in the tool output box above the input
- When `showPruneStatusLine` is `false`, the footer stays clear and the queued-turn notice is suppressed, but pruning still works normally.

## v1 Limitations

- Summarization only runs when pruning is **enabled**. If you enable it mid-session, earlier turns are not retroactively summarized.
- The `context_tree_query` tool is only active when the extension is loaded.
- The `context_prune` tool is only activated in `agentic-auto` mode.
- The summarizer call happens synchronously inside `turn_end`, adding latency between turns proportional to the summarizer model's response time.
- Mid-turn pruning now supports completed subsets of a longer tool chain, but batching is still based on assistant-message groups rather than arbitrary semantic task labels.
- The `/pruner tree` browser shows pruned tool calls grouped under their summaries. Press `Ctrl-O` on a summary node to open the full pruned summary message in a bordered overlay. It still does not recover full original tool outputs inline (use `context_tree_query` for that).
- Summary grouping across multiple turns (e.g., "compress the last 5 summaries") is a follow-up item.

## Follow-up ideas

- Auto-summarize older unsummarized turns on `/pruner on`
- Batch multiple turn summaries into a single meta-summary at compaction time
- ~~`/pruner original-tree`~~ ✅ `/pruner tree` foldable tree browser — done
- Configurable pruning policy (prune only large tool results, prune by token count threshold)
- Tighter `/settings` integration once Pi exposes a settings UI API