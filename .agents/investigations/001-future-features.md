# Future Features & Research Directions for pi-context-prune

**Date:** 2026-04-30  
**Status:** Draft — ideas for research and potential implementation

---

## 1. Importance-Scored / Selective Pruning

### Idea
Instead of pruning every tool result from a batch uniformly, score each tool call by importance before deciding whether to summarize-and-prune or keep it verbatim in context.

### Motivation
Not all tool outputs are equal. A `read` of a 3-line config file is cheap to keep verbatim; a 50 KB `bash` stdout that was only a stepping-stone is the ideal pruning candidate. Research on AI agent tool-call optimization (e.g. SWE-Pruner, arXiv 2601.16746) shows that _self-adaptive_ context pruning — where importance is assessed per-result — outperforms uniform truncation.

### Potential approach
- Add an optional `importanceScore(toolName, resultText, args)` hook in `batch-capture.ts` or a new `scorer.ts` module.
- Score heuristics: result char count, tool name category (`read`/`bash`/`search`), recency, whether the result was referenced by a subsequent tool call.
- Results below a threshold are pruned; above it are kept verbatim. Middle tier: truncated but kept.
- The summarizer prompt could also instruct the LLM to identify which parts of a result are load-bearing vs. ephemeral.

### Research links
- SWE-Pruner (arXiv 2601.16746): self-adaptive context pruning for coding agents
- ACON (arXiv 2510.00615): failure-driven guideline optimization for context compression
- Factory.ai blog: "Evaluating Context Compression for AI Agents"

---

## 2. Prompt-Cache–Aware Pruning Schedule

### Idea
Teach the pruner about provider prompt-caching mechanics and automatically delay or batch pruning to maximize prefix-cache hit rates.

### Motivation
Anthropic caches prefixes in 1 024-token increments; OpenAI caches up to the last 128 K tokens. Pruning mid-conversation rewrites earlier context and busts cached prefixes, potentially costing more than it saves. The current `agent-message` default is already cache-friendly (prune once at the end), but the extension has no insight into actual cache hit/miss data.

### Potential approach
- Parse `cacheRead` / `cacheWrite` token counts already returned in `SummarizeResult.usage` and in Pi's response usage.
- Expose a `/pruner cache-stats` subcommand showing cache efficiency for the current session.
- A new `pruneOn: "cache-aware"` mode: flush only when `cacheWrite` tokens in the last turn exceed a threshold (indicating the prefix is already being rewritten anyway).
- Alternatively, compute a "prune worthiness" score = `(tokens pruned) / (cache invalidation cost)` before flushing.

### Research links
- Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- OpenAI prompt caching guide: https://developers.openai.com/api/docs/guides/prompt-caching
- "Prompt Caching for AI Agents: Cut LLM Costs by 60%" — Athenic Blog

---

## 3. Structured / Plan-Aware Summaries

### Idea
Instead of free-form markdown bullet summaries, generate structured summaries (JSON or typed sections) that explicitly track: files modified, decisions made, findings, and open questions.

### Motivation
Research (Morph blog: "Compaction vs Summarization") distinguishes _verbatim_, _opaque_, and _plan-aware_ compression strategies. Plan-aware compression — where the summary encodes the agent's evolving plan — significantly improves task performance on long-horizon tasks because the model can reason about its progress rather than re-deriving context from bullet lists.

### Potential approach
- Add a `summaryFormat: "markdown" | "structured" | "plan-aware"` config option.
- `"structured"`: summarizer returns JSON with keys `filesRead`, `filesModified`, `findings`, `decisions`, `openQuestions`. The `context-prune-summary` custom message carries this as `details` and the renderer shows it as a structured table.
- `"plan-aware"`: the summarizer prompt is given the user's original task (passed in from `before_agent_start` context) and asked to describe _how each tool call advanced the plan_, not just what it returned.
- The `context_tree_query` tool could be extended to answer semantic queries ("which tool calls touched file X?") against the structured index.

### Research links
- Morph: "Compaction vs Summarization: Agent Context Management Compared"
- ACON paper: failure-driven structured guideline updates
- "Active Context Compression" (arXiv 2601.07190): autonomous agent memory management

---

## 4. Token-Budget–Aware Auto-Flush

### Idea
Monitor the running context token count and automatically trigger a flush when the remaining token budget drops below a configurable threshold, regardless of the current `pruneOn` mode.

### Motivation
Context budget management is an active research area (ContextBudget, arXiv 2604.01664). A token-budget–aware mode would be the most robust safety net: even if the user forgets to enable pruning, the extension could intervene before a context-limit error occurs.

### Potential approach
- New config: `autoBudgetThreshold: number | null` (e.g. `0.75` = flush when 75% of max context is used).
- In `turn_end`, after capturing the batch, check `event.totalTokens / event.maxTokens` (if Pi exposes this). If above threshold, trigger an immediate `flushPending`.
- Combine with importance scoring (idea #1) to prioritize which batches to flush first.
- Show a warning notification when the budget trigger fires so the user knows it happened automatically.
- A related sub-feature: **cooperative memory paging** — when flushing, emit a lightweight "bookmark" of each pruned section so the model can ask to retrieve it without knowing the exact `toolCallId`.

### Research links
- ContextBudget (arXiv 2604.01664): budget-aware context management for search agents
- Cooperative memory paging (arXiv 2604.12376): keyword bookmarks for evicted context segments

---

## 5. Semantic Search over Pruned Outputs

### Idea
Instead of (or in addition to) exact `toolCallId` lookup in `context_tree_query`, allow the LLM to query pruned outputs by semantic similarity or keyword.

### Motivation
The LLM often knows _what_ it's looking for ("the grep result for `configPath`") but not _which_ `toolCallId` it was. Requiring the model to track and cite exact IDs is friction. Semantic search over the pruned index would make retrieval much more natural.

### Potential approach
- Add an optional `query: string` parameter to `context_tree_query` alongside `toolCallIds`.
- When `query` is provided, embed the query and compare against pre-computed embeddings of stored `resultText` slices. Return the top-K matches.
- Embedding could be done on the fly (small model, cheap) or lazily at prune time and stored in the session index.
- A simpler first step: keyword/regex search over `resultText` fields — no embedding required.
- Expose `/pruner search <query>` as a user-facing command that prints matching pruned results.

### Research links
- Semantic caching in LLM applications (Brightlume AI blog)
- RAG vs context compression tradeoffs (Meilisearch blog; elastic.co blog)
- CompLLM (arXiv 2509.19228): segmented independent compression with retrieval

---

## 6. Cross-Session / Global Pruned Output Store

### Idea
Persist pruned tool outputs in a project-level or global store (beyond the current session file), enabling recovery across sessions and reuse of expensive tool results.

### Motivation
Currently the index lives in the session file. If the user starts a new session for the same project, all pruned outputs from previous sessions are gone. For expensive operations (large directory reads, test suite runs, analysis passes), this is wasteful.

### Potential approach
- New config: `persistenceScope: "session" (default) | "project" | "global"`.
- `"project"`: write a `.pi/pruner-index.jsonl` file in the project root (alongside `.pi/`). On `session_start`, scan and load entries from that file too.
- `"global"`: write to `~/.pi/agent/context-prune/global-index.jsonl` — available in all projects.
- Include a TTL (time-to-live) for cross-session entries so stale file reads don't pollute new sessions.
- Security consideration: never persist entries that contain secrets or tokens (heuristic: check for patterns like `sk-`, `ghp_`, env var assignments).

---

## 7. Summarizer Quality Feedback Loop

### Idea
Let the LLM (or user) rate summary quality and use that feedback to adapt the summarizer prompt over time.

### Motivation
The current summarizer prompt is static. A feedback loop — even a simple thumbs-up/down on summary messages — would let the extension learn which summaries were too lossy (model had to call `context_tree_query` frequently) and which were too verbose (defeating the purpose of pruning).

### Potential approach
- Track how often `context_tree_query` is called after a summary: high recall rate = summary was too lossy.
- Expose `/pruner rate <good|bad>` to let the user annotate the last summary.
- Store feedback in `~/.pi/agent/context-prune/feedback.jsonl`.
- After N negative examples, run a meta-prompt: "here are summaries rated bad; here are the original batches; improve the summarizer prompt". Write the result to a `customSummarizerPrompt` config field.
- This is inspired by ACON's failure-driven guideline optimization (arXiv 2510.00615).

### Research links
- ACON: Optimizing Context Compression for Long-horizon LLM Agents (arXiv 2510.00615)
- "Active Context Compression: Autonomous Memory Management in LLM Agents" (arXiv 2601.07190)

---

## 8. Differential / Delta Summaries

### Idea
When the same file or resource is read multiple times across turns, generate a **delta summary** ("same file as turn 12, new section: lines 45–80") instead of summarizing each read independently.

### Motivation
Coding agents often read the same file multiple times (e.g. once to orient, once after an edit, once to verify). Each independent summary repeats overlapping information. Delta summaries would be far more token-efficient.

### Potential approach
- In `batch-capture.ts` or a new `deduplicator.ts`, detect when a `toolName + primary arg (e.g. path)` combo appeared in a previous summarized batch.
- Pass the prior summary for that resource to the summarizer alongside the new result, instructing it to describe only what changed.
- Store a `relatedSummaryId` link in `ToolCallRecord` so `context_tree_query` can traverse the delta chain.

---

## 9. Pruner Analytics Dashboard (`/pruner dashboard`)

### Idea
Extend the `TreeBrowser` into a full session analytics view: token savings over time, pruning frequency, most-pruned tools, cache hit estimate.

### Motivation
Users currently see aggregate stats in the footer (e.g. `↑1.2k ↓340 $0.003`) but have no way to visualize the savings trajectory across a long session or compare pruning strategies.

### Potential approach
- New `/pruner dashboard` command opens a `Component` showing:
  - A sparkline of context size over turns (estimated from batch char counts).
  - A bar chart of tokens pruned per turn.
  - A table: top N tools by total pruned chars.
  - Cache efficiency estimate (pruned tokens × cache discount rate).
- Reuses `charCount` data already computed in `TreeNode` and the stats accumulator.
- The Pi TUI has `Markdown`, `Text`, `Container` — a simple ASCII chart renderer could be added without external deps.

---

## 10. Multi-Model Summarization Pipeline

### Idea
Use a cheap/fast model for initial summarization and optionally a smarter model for a compression pass when context is critically full.

### Motivation
The current design uses a single model for all summarization. A tiered approach (cheap model for routine turns, expensive model for high-stakes compression when budget is low) would optimize cost/quality tradeoffs.

### Potential approach
- Add `summarizerModel2: string | null` and `budgetThresholdForModel2: number` to `ContextPruneConfig`.
- In `flushPending`, check the remaining budget. Below the threshold, use `model2` for higher-quality compression.
- Alternatively: the primary model summarizes to bullets; a second pass with a compression-specialist model (e.g. a fine-tuned small model) further compresses those bullets.

### Research links
- CompLLM (arXiv 2509.19228): hierarchical context compression
- Zylos Research: "AI Agent Context Compression Strategies for Long-Running Sessions"

---

## Priority Assessment

| Feature | Effort | Impact | Recommended Next |
|---|---|---|---|
| Token-budget auto-flush (#4) | Medium | High | ✅ Yes — safety net for all users |
| Importance scoring (#1) | Medium | High | ✅ Yes — reduce unnecessary pruning |
| Cache-aware scheduling (#2) | Medium | Medium | Consider — high value for heavy Anthropic users |
| Structured summaries (#3) | High | High | After #1/#4 stabilize |
| Semantic search in query-tool (#5) | High | Medium | Later — keyword search first |
| Cross-session store (#6) | Medium | Medium | Later — config + TTL complexity |
| Delta summaries (#8) | High | Medium | Later — needs dedup tracking |
| Feedback loop (#7) | High | Low-Medium | Research project |
| Analytics dashboard (#9) | Medium | Low-Medium | Nice to have |
| Multi-model pipeline (#10) | Low | Medium | Quick win if two-model config is easy |
