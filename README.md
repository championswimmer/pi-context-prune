# CoACT

> **Action-preserving observation compression for [Pi](https://github.com/badlogic/pi-mono) coding agents.**

`pi-coact` is a Pi extension that **summarizes completed tool-call batches, compresses the raw tool outputs out of future LLM context, and keeps every original result recoverable on demand** — so long sessions stay cheap and fast without losing fidelity.

Named after the [CoACT](https://arxiv.org/abs/2607.02911) line of work on **observation compression for coding agents**: compress what the agent *saw*, never what it must *do next*. See [**RESEARCH.md**](RESEARCH.md) for the full analysis and roadmap, and [**PRUNING.md**](PRUNING.md) for the mechanics of compression and prefix-cache interaction.

> **Fork notice.** CoACT is a hard fork of [`championswimmer/pi-context-prune`](https://github.com/championswimmer/pi-context-prune), rebranded and extended (token-based thresholds, dynamic thinking levels, the `max` reasoning level, `/CoACT` command surface). Full credit to the original author.

---

## Why

As agent sessions grow, every tool call dumps token-heavy output into the context window — `read`, `bash`, `rg`, web fetches. Most of it is never needed verbatim after the first glance, yet it keeps being paid for on every subsequent request.

CoACT:

1. **Detects** when an assistant turn finishes calling tools (`turn_end`).
2. **Summarizes** that batch with a configured (usually cheap, fast) model.
3. **Injects** a compact hidden summary before the next LLM call (`deliverAs: "steer"`).
4. **Compresses** the original verbose outputs out of future context (`context` event).
5. **Preserves** every original result in the session index — recoverable any time via `context_tree_query`.

The session file is **never modified**. Compression only affects how the *next* request's context is built.

### Why *token-based* and *cache-aware*

- **Token units everywhere.** Both the *should-I-even-summarize* threshold and the *is-the-summary-smaller* comparison use real tokenizer counts (`gpt-tokenizer`, cl100k) with a `chars/4` fallback. Code tokenizes far denser than prose per character, so character counts systematically under-measure raw tool output — tokens are materially fairer.
- **Prefix-cache friendly.** Rewriting earlier context busts the provider's prefix/prompt cache. CoACT's default trigger batches a whole run of tool work and compresses **once**, so you usually pay a single cache invalidation per meaningful task instead of one per turn.

---

## Installation

### From npm (stable)

Published as [`pi-coact`](https://www.npmjs.com/package/pi-coact):

```bash
pi install npm:pi-coact            # all projects
pi install -l npm:pi-coact         # current project only
```

Re-run the same command to upgrade. The extension auto-loads on every `pi` run — no flags needed.

### From GitHub (cutting edge / `main`)

```bash
pi install git:github.com/pinion05/PI-CoACT
```

### Try without installing

```bash
pi -e npm:pi-coact                 # this session only
pi -e git:github.com/pinion05/PI-CoACT
```

### From source (development)

```bash
git clone https://github.com/pinion05/PI-CoACT
cd PI-CoACT
pi -e .
```

### Manage

```bash
pi list                # installed packages
pi remove pi-coact
```

---

## Quick start

```bash
/CoACT settings                    # open the interactive overlay
/CoACT model anthropic/claude-haiku-3-5:low   # cheap, fast summarizer
/CoACT on                          # enable compression
```

That's it. With the default `agent-message` trigger, CoACT compresses each batch of tool work once the agent sends its final text reply, then leaves the shorter context stable for cache-friendly follow-ups.

---

## Commands

The extension registers the **`/CoACT`** command:

| Command | Effect |
|---|---|
| `/CoACT` | Interactive picker over all subcommands |
| `/CoACT settings` | Open the interactive settings overlay |
| `/CoACT on` / `off` | Enable / disable compression |
| `/CoACT status` | Show state, model, thinking, trigger, batching mode, and stats |
| `/CoACT model` | Show the current summarizer model |
| `/CoACT model <id>` | Set summarizer model (e.g. `anthropic/claude-haiku-3-5`) |
| `/CoACT model <id>:<thinking>` | Set model + thinking together (e.g. `openai/gpt-5-mini:low`) |
| `/CoACT thinking` | Show the current summarizer thinking level |
| `/CoACT thinking <level>` | `default` · `off` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` |
| `/CoACT trigger` | Show or interactively pick the trigger mode |
| `/CoACT trigger <mode>` | `every-turn` · `on-context-tag` · `on-demand` · `agent-message` · `agentic-auto` |
| `/CoACT batching` | Show or pick batching granularity (`turn` / `agent-message`) |
| `/CoACT stats` | Show cumulative summarizer token/cost stats |
| `/CoACT tree` | Browse compressed tool calls in a foldable tree (`Ctrl-O` opens a summary) |
| `/CoACT now` | Flush pending tool calls immediately (live footer progress) |
| `/CoACT help` | Show full help |

### Settings overlay

`/CoACT settings` opens a TUI overlay:

1. **Enabled** — toggle compression on/off
2. **Footer status line** — show/hide the status widget + queued-turn notices
3. **Trigger** — cycle the five trigger modes
4. **Summarizer model** — searchable submenu (`"default"` + all registered models)
5. **Summarizer thinking** — cycle reasoning levels (**filtered to what the current model supports**)
6. **Remind uncompressed count** — toggle the `agentic-auto` `<coact-note>` reminder
7. **Batching mode** — `turn` vs `agent-message`
8. **Min raw tokens** — cycle presets for the minimum raw tool-output tokens before a summarizer call (`0` disables)

Changes save immediately to `~/.pi/agent/context-prune/settings.json`.

---

## Trigger modes

| Mode | When it compresses | Cache impact | Use for |
|---|---|---|---|
| `agent-message` *(default)* | After the agent's final text reply, or on `agent_end` | **Best** — one rewrite per task batch, then stable | Normal coding workflows |
| `on-demand` | Only on `/CoACT now` | Best if you flush sparingly | Long investigations, manual control |
| `on-context-tag` | When `context_checkpoint` (legacy `context_tag`) runs | Few busts if you tag sparingly | Milestone workflows with [`pi-context`](https://github.com/ttttmr/pi-context) |
| `agentic-auto` | When the LLM calls the `context_prune` tool | Depends on model discipline | Long autonomous runs |
| `every-turn` | After every tool-calling turn | **Worst** — rewrites prefix almost every turn | Debugging / inspecting summaries only |

---

## Tools

### `context_tree_query` — always available

Compressed batches are replaced in context by a compact summary ending with short refs:

```
**Refs**: t12, t13 (context_tree_query)
```

The LLM sees only the short refs in future context; the full `toolCallId` mapping lives in the summary's stored metadata. Calling `context_tree_query` with those refs recovers the original, full outputs on demand.

### `context_prune` — `agentic-auto` only

Activated only when the trigger is `agentic-auto`. The model calls it to compress pending batches; live progress streams into the tool-output box (`CoACT running… batch 2/4 · 1.2k tokens received`). If a summary isn't smaller than the raw text it would replace, that range is skipped (originals stay) but the compression frontier still advances past it.

---

## Configuration

Stored in `~/.pi/agent/context-prune/settings.json` (global, project-independent):

```jsonc
{
  "enabled": false,
  "showPruneStatusLine": true,
  "summarizerModel": "default",
  "summarizerThinking": "default",
  "pruneOn": "agent-message",
  "remindUnprunedCount": true,
  "batchingMode": "turn",
  "minRawTokenThreshold": 0
}
```

| Key | Values | Default |
|---|---|---|
| `enabled` | `true` / `false` | `false` |
| `showPruneStatusLine` | `true` / `false` | `true` |
| `summarizerModel` | `"default"` or `"provider/model-id"` | `"default"` |
| `summarizerThinking` | `default` · `off` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | `"default"` |
| `pruneOn` | `every-turn` · `on-context-tag` · `on-demand` · `agent-message` · `agentic-auto` | `"agent-message"` |
| `remindUnprunedCount` | `true` / `false` | `true` |
| `batchingMode` | `"turn"` / `"agent-message"` | `"turn"` |
| `minRawTokenThreshold` | integer ≥ 0 (tokens; `0` = always summarize) | `0` |

Notes:

- **`minRawTokenThreshold`** skips the summarizer LLM call for batches whose raw tool output is below the threshold (in **tokens**, `gpt-tokenizer` cl100k with `chars/4` fallback). A tiny batch's summary is almost always larger than the raw text, so skipping avoids wasted calls while still advancing the frontier. Snaps to 50-token steps; presets `[0, 50, 100, 200, 300, 500, 1000]`. *Migrates old `minRawCharThreshold` automatically (chars ÷ 4, quantized).*
- **`summarizerModel: "default"`** reuses the active Pi model — convenient but wasteful. You don't need a frontier coding model to bullet-point tool output; pick the smallest/fastest model on your plan to cut both latency and cost.
- **Dynamic thinking levels.** `summarizerThinking` is filtered to the levels the *current summarizer model actually supports` (read from model metadata, with a graceful fallback to the full list). `max` is included where supported.

### Choosing a summarizer model

| Plan | Recommended |
|---|---|
| GitHub Copilot / Codex | `openai/gpt-4.1-mini`, `google/gemini-2.5-flash`, `xai/grok-3-fast` |
| OpenRouter | `openrouter/qwen/qwen3-30b-a3b` (fast MoE, very cheap) |
| Anthropic direct | `anthropic/claude-haiku-3-5` |
| Google AI direct | `google/gemini-2.5-flash` |

```bash
/CoACT model openai/gpt-4.1-mini:low
# or edit ~/.pi/agent/context-prune/settings.json directly
```

---

## Architecture

```
index.ts                    entry point — wires events + modules
src/
  types.ts                  shared types, constants, trigger modes
  config.ts                 load/save settings (+ char→token migration)
  tokens.ts                 gpt-tokenizer counter (chars/4 fallback)
  prune-threshold.ts        token thresholds + flush-outcome logic
  batch-capture.ts          serialize turn_end → CapturedBatch
  summarizer.ts             resolve model, call LLM, build summary text
  summary-refs.ts           short-ref generation + wrapper
  indexer.ts                Map<toolCallId, ToolCallRecord> + persistence
  pruner.ts                 filter context event messages
  query-tool.ts             context_tree_query registration
  context-prune-tool.ts     context_prune registration (agentic-auto)
  frontier.ts               persisted compression-frontier tracker
  stats.ts                  cumulative token/cost accumulator
  tree-browser.ts           foldable tree browser for /CoACT tree
  reminder.ts               <coact-note> reminder (agentic-auto)
  commands.ts               /CoACT command + settings overlay + widgets
```

### Event flow

```
session_start        loadConfig → reconstruct index/stats/frontier → sync context_prune tool
session_tree         reconstruct for the new branch; drop pending batches
turn_end             captureBatch → trim vs index/frontier → push to pending
                     (every-turn: flushPending immediately)
tool_execution_end   context_checkpoint → flushPending   (on-context-tag)
context_prune call   flushPending                              (agentic-auto)
agent_end            update footer if batches pending

flushPending
  ├─ pre-filter batches below minRawTokenThreshold (no summarizer call)
  ├─ summarizeBatches → summary text + usage (sequential w/ progress, or parallel)
  ├─ compare summary TOKENS vs raw TOKENS
  ├─ smaller: persist index + inject summary → advance frontier
  └─ larger: keep originals, skip writes → still advance frontier
  statsAccum.add/persist

context              pruneMessages — drop toolResult messages in the index
before_agent_start   append agentic-auto system prompt (agentic-auto only)
```

### Persistence & data compatibility

- **Config** — `~/.pi/agent/context-prune/settings.json` (the extension's own file).
- **Index** — `pi.appendEntry("context-prune-index", …)`, one entry per compressed batch, **not** in LLM context.
- **Frontier** — `pi.appendEntry("context-prune-frontier", …)`, records the last attempted boundary even when an oversized summary is rejected.
- **Summaries** — hidden `custom_message` entries, `customType: "context-prune-summary"`, wrapped in `<context-prune-summary>`; **in** LLM context (replacing raw outputs only when compression is accepted). Short refs in text, full `toolCallId` mapping in `details.toolCallRefs`.

> The `context-prune-*` `customType` values, the `<context-prune-summary>` wrapper tag, and the config path are **intentionally unchanged** for full backward compatibility with sessions compressed by the upstream `pi-context-prune`.

The underlying session JSONL always retains the original `ToolResultMessage` entries unchanged.

### Footer widget

```
CoACT: OFF (On agent message)
CoACT: ON (On agent message) │ ↑1.2k ↓340 $0.003
CoACT: 3 pending
CoACT: summarizing…
```

Hidden when `showPruneStatusLine` is `false`; compression keeps working regardless.

---

## Limitations & roadmap

**Current limits**

- Summarization runs only when **enabled**; enabling mid-session does not retroactively compress earlier turns.
- The summarizer call is synchronous inside `turn_end` (latency ∝ summarizer response time — use a fast model).
- `/CoACT tree` groups compressed calls under their summaries and opens summaries in an overlay, but doesn't inline full originals (use `context_tree_query`).

**Roadmap** (see [RESEARCH.md](RESEARCH.md) for the CoACT-aligned plan)

- Next-Action Preservation (NAP): never compress the most recent, still-relevant observations.
- Candidate-filter-shortest pipeline: choose the smallest sufficient summary per batch.
- Meta-summary of older summaries at compaction time.
- Auto-compress old unsummarized turns on `/CoACT on`.

---

## Related

- [**pi-context**](https://github.com/ttttmr/pi-context) — provides `context_checkpoint` (legacy `context_tag`) used by `on-context-tag`.
- [**pi-context-usage**](https://github.com/championswimmer/pi-context-usage) — visualize context size; great for seeing CoACT's before/after effect.
- [**pi-cache-graph**](https://github.com/championswimmer/pi-cache-graph) — live prefix-cache hit/miss graph; see how your trigger choice affects cache stability.
- [Anthropic prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) · [AWS Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)

---

## License

MIT — forked from [`championswimmer/pi-context-prune`](https://github.com/championswimmer/pi-context-prune) (MIT).
