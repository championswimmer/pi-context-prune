---
name: 046-report-summarizer-usage-to-pi
description: Report every pruner summarizer LLM call through two channels. The Pi-standard `type:"usage"` session entry (SessionManager.appendUsage) covers the footer and /session. A pi-stats usage sidecar at <agentDir>/context-prune/usage.jsonl covers @hank-warren/pi-stats. Both records share a deterministic id so future consumers that read both can de-duplicate.
steps:
  - phase: design-check
    steps:
      - "- [x] step 1: find the first Pi version that ships SessionManager.appendUsage + UsageEntry and bump the pi-coding-agent peer/dev dependency to it"
      - "- [ ] step 2: spike: call appendUsage from an extension and confirm that the footer ↑↓$ and the /session per-model breakdown update"
      - "- [ ] step 3: spike: hand-write one sidecar line at ~/.pi/agent/context-prune/usage.jsonl and confirm pi-stats shows a `provider/model (summarizer)` row"
  - phase: implementation
    steps:
      - "- [x] step 1: add SummarizeBatchOptions.onUsage(response) fired inside summarizeBatch as soon as the provider returns a final AssistantMessage \u2014 before the stopReason check, text extraction, or any throw/null return (covers success, error, aborted-with-usage)"
      - "- [x] step 1b: capture sessionManager + sessionId at the start of flushPending and bind onUsage to reportSummarizerUsage; remove statsAccum.add from the flush loop and call it from the same hook, so pruner stats and Pi usage always match"
      - "- [x] step 2: add src/usage-log.ts: pi-stats v1 sidecar writer (normalize usage, 16 MB rotate to usage.jsonl.1, dir 0700, file 0600, appendFileSync)"
      - "- [x] step 3: add src/usage-report.ts: reportSummarizerUsage(ctx, result, meta) → appendUsage first, then write a sidecar record with the shared id `<sessionId>:<usageEntryId>`"
      - "- [x] step 4: verify every paid call is reported exactly once: oversized-dropped summaries, stopReason=error, aborted with usage, parallel results after the first failed batch (currently dropped by the loop's break), and results lost to a stale-context persistence error"
      - "- [x] step 5: leave the context_prune tool result without usage (appendUsage already covers that call in the footer)"
      - "- [x] step 5b: persist statsAccum also on the summarizer-failed return path (currently only persisted on success)"
      - "- [x] step 6: fallbacks: if appendUsage is missing, the sidecar id is a random UUID with no usageEntryId; all I/O errors notify once and never fail a prune"
      - "- [x] step 7: switch SETTINGS_PATH and the sidecar path to Pi's getAgentDir() so PI_CODING_AGENT_DIR is respected"
      - "- [x] step 8: keep StatsAccumulator/CUSTOM_TYPE_STATS unchanged for the pruner's own footer suffix and /pruner stats"
  - phase: upstream-coordination
    steps:
      - "- [x] step 1: open an issue/PR on @hank-warren/pi-stats: count Pi `type:\"usage\"` entries, and skip any whose `<sessionId>:<entryId>` equals a sidecar record's id (or sidecar.sessionId + usageEntryId)"
  - phase: validation
    steps:
      - "- [x] step 1: unit tests: oversized summary (summary > raw chars) still produces exactly one usage entry + one sidecar line; stopReason=error and a mid-batch failure in parallel mode still report every completed call; appendUsage args; sidecar record shape (v, id, ts, source, label, provider, model, usage, sessionId, usageEntryId); the shared id matches the returned entry; rotation; fallback when appendUsage is missing; no throw on I/O error"
      - "- [ ] step 2: manual check: after a prune, the footer $ goes up by exactly the summarizer cost, /session lists the summarizer model, and pi-stats shows the same tokens/cost once under `(summarizer)`"
      - "- [x] step 3: update README + AGENTS.md (usage-report/usage-log modules, sidecar path, shared-id contract, minimum Pi version)"
---

# 046-report-summarizer-usage-to-pi

## Problem

`summarizeBatch()` calls `provider.stream()` directly. The `AssistantMessage` it gets back
(with `usage`) is never recorded anywhere that Pi or usage dashboards read. Summarizer spend
is therefore missing from Pi's footer, from `/session`, and from `@hank-warren/pi-stats`.

## Two channels, one call → two records sharing an id

| Channel | Format owner | Read by today |
|---|---|---|
| `SessionManager.appendUsage("context_prune", …)` → `type:"usage"` session entry | Pi (docs/session-format.md, UsageEntry) | Pi footer, `/session`, RPC stats |
| `<agentDir>/context-prune/usage.jsonl` sidecar line | pi-stats ("Extension usage sidecars" in its README) | `@hank-warren/pi-stats` |

Nothing reads both today, so there is no double counting. Both records carry the same key so
that a future consumer reading both can drop one.

### Channel 1 — Pi-standard usage entry (footer, `/session`)

```ts
const entry = sm.appendUsage("context_prune", msg.provider, msg.responseModel ?? msg.model, msg.usage, note);
// → { type:"usage", id:"a1b2c3d4", parentId, timestamp, kind, provider, model, usage, note }
```

- `appendUsage` is synchronous and returns the entry. The `id` is 8 hex characters and only
  unique within the session (`generateId` in session-manager.js).
- `ctx.sessionManager` is typed `ReadonlySessionManager`, but it is the real `SessionManager`
  at runtime. Feature-detect `appendUsage`.
- `note` is human-readable, e.g. `"summarized 9 tool calls (turn 12)"`.

### Channel 2 — pi-stats usage sidecar

Path: `join(getAgentDir(), "context-prune", "usage.jsonl")`. pi-stats looks exactly one folder
below the agent dir for `usage.jsonl` / `usage.jsonl.1`. We already keep `settings.json` in
this folder.

```json
{"v":1,"id":"<sessionId>:<usageEntryId>","ts":"<entry.timestamp>","source":"context-prune","label":"summarizer","provider":"anthropic","model":"claude-haiku-4-5","usage":{"input":812,"output":96,"cacheRead":0,"cacheWrite":0,"reasoning":0,"cost":0.0012},"sessionId":"<sessionId>","usageEntryId":"<usageEntryId>","kind":"context_prune"}
```

- Required by pi-stats: `v: 1`, a valid `usage`, `id` (its dedupe key), `ts`,
  `source`/`label` (the row is shown as `provider/model (summarizer)`), `provider`, `model`.
- The extra fields (`sessionId`, `usageEntryId`, `kind`) are ignored by pi-stats 0.4.2's
  parser. They make the link to the session entry explicit.
- Usage normalization follows `@hank-warren/pi-auto-permissions` `usage-log.ts`: non-finite or
  negative numbers become 0, and `cost` comes from `usage.cost.total`.
- The record contains no content: no prompts, summary text, or tool args.
- Writing: `mkdir -p` (0700), rotate to `usage.jsonl.1` above 16 MB (one generation, which
  pi-stats still reads), `appendFileSync`, file mode 0600.

### Shared id contract (for future de-duplication)

**`id = "<sessionId>:<usageEntryId>"`**

- **Unique across all sessions:** the session UUID plus an entry id that is unique within that
  session.
- **Derivable from the session file alone:** a consumer reading a JSONL session has the header
  `id` and each entry's `id`, so it can build the same key without parsing `note`.
- **Same timestamp:** the sidecar `ts` is set to the usage entry's `timestamp`.
- **Order:** call `appendUsage` first (sync, returns the id), then write the sidecar line in the
  same tick.
- **Fallback:** if `appendUsage` is unavailable (older Pi), use `id = randomUUID()` and omit
  `usageEntryId`. There's no session record in that case, so there's nothing to de-duplicate.
- **Why not tool-call ids:** one summarizer call covers many tool calls, and a tool call could
  appear in a re-summarized batch after a branch or retry. A per-usage-record key is 1:1 with
  the LLM call, which is what should be counted. The summarized tool-call count still goes in
  `note` for humans.

### When to report — at the source, never gated on the outcome

**Rule: any provider response that carries `usage` is reported once, when it's produced,
whatever `flushPending` later does with the summary.** The tokens were spent either way.

In current code, where usage gets lost or only luckily survives:

| Case | Today (`index.ts` / `summarizer.ts`) | Plan |
|---|---|---|
| Summary larger than raw tool output (**frequent**) | `statsAccum.add` runs before `shouldSkipOversized`, so our stats count it, but nothing else sees it | reported by `onUsage` before the size check even exists |
| `stopReason === "error"` | `summarizeBatch` throws → catch returns `null` → usage lost | `onUsage` fires before the throw |
| Aborted (`/pruner now` Esc, signal) | rethrown → usage lost | `onUsage` fires if the provider returned a final message with usage |
| Parallel batch that succeeded **after** a failed batch | loop `break`s at the first `null`; the result is ignored and re-summarized later (paid twice, counted zero times) | reported when its call finished; the retry is reported again, since it's a real second call |
| Stale-context persistence error mid-loop | `break` → remaining results lost | same as above |
| Auth or unknown-provider failure | no call made | nothing to report |

Implementation: `summarizeBatch(batch, config, ctx, { onUsage })` calls
`onUsage(response)` right after the stream resolves its final `AssistantMessage`, if
`response.usage` exists. The hook is sync and wrapped in try/catch so it can never change the
summarizer's result. `flushPending` binds `onUsage` to `reportSummarizerUsage` using the
`sessionManager` it captured at flush start, so the session delivery and print-mode paths
write to the right session. It also calls `statsAccum.add` there, which removes today's
`statsAccum.add(result.usage)` from the loop, so our footer suffix and Pi's usage can never
disagree. The `note` stays outcome-neutral (`"summarizer call: 9 tool calls (turn 12)"`),
because the dropped-oversized outcome is only known later. The usage is correct either way.
- All flush paths: every-turn, agent-message, on-context-tag, `/pruner now`, and the
  `context_prune` tool.
- The `context_prune` tool result gets **no** `usage`, otherwise the footer would count the
  call twice.
- `"session"` delivery path (print mode, shutdown): use the same captured `sessionManager`
  reference that `flushPending` already holds.

## Edge cases

- **In-memory sessions** (`--no-session`): `appendUsage` still works in memory (footer
  correct) and `getSessionId()` still returns an id. The sidecar is global, so it's still
  written.
- **Branches and forks:** a usage entry belongs to the branch where it was written. When a
  fork copies the entry into a new session, a future consumer would see a different
  `sessionId`. pi-stats already de-duplicates copied-branch session records, and the sidecar
  line keeps the original session's id, so the key still points at the original.
- **I/O errors:** notify once per session and never fail or delay a prune.
- **Opt-out:** users can set pi-stats' `PI_STATS_DISABLE_USAGE_SIDECARS=1`. We could add our
  own `usageSidecar: boolean` config (default true) if users ask.

## Rejected alternatives

- **Hidden child session JSONL:** it is non-standard and would clutter consumers.
- **toolResult `usage`:** it only exists on the `context_prune` path.
- **Assistant message in the parent session:** it would enter LLM context and break role
  alternation and the prompt cache.
- **A tool-call id as the shared key:** it is not 1:1 with LLM calls (see above).

## Phase 1 — Design check
- [x] step 1: find the first Pi version that ships SessionManager.appendUsage + UsageEntry and bump the pi-coding-agent peer/dev dependency to it
- [ ] step 2: spike: call appendUsage from an extension and confirm that the footer ↑↓$ and the /session per-model breakdown update
- [ ] step 3: spike: hand-write one sidecar line at ~/.pi/agent/context-prune/usage.jsonl and confirm pi-stats shows a `provider/model (summarizer)` row

Design check: Pi 0.86.0 is the first published version with `appendUsage`; the two interactive spikes remain open because this environment cannot run a real authenticated Pi + pi-stats session.

## Phase 2 — Implementation
- [x] step 1: add SummarizeBatchOptions.onUsage(response) fired inside summarizeBatch as soon as the provider returns a final AssistantMessage — before the stopReason check, text extraction, or any throw/null return (covers success, error, aborted-with-usage)
- [x] step 1b: capture sessionManager + sessionId at the start of flushPending and bind onUsage to reportSummarizerUsage; remove statsAccum.add from the flush loop and call it from the same hook, so pruner stats and Pi usage always match
- [x] step 2: add src/usage-log.ts: pi-stats v1 sidecar writer (normalize usage, 16 MB rotate to usage.jsonl.1, dir 0700, file 0600, appendFileSync)
- [x] step 3: add src/usage-report.ts: reportSummarizerUsage(ctx, result, meta) → appendUsage first, then write a sidecar record with the shared id `<sessionId>:<usageEntryId>`
- [x] step 4: verify every paid call is reported exactly once: oversized-dropped summaries, stopReason=error, aborted with usage, parallel results after the first failed batch (currently dropped by the loop's break), and results lost to a stale-context persistence error
- [x] step 5: leave the context_prune tool result without usage (appendUsage already covers that call in the footer)
- [x] step 5b: persist statsAccum also on the summarizer-failed return path (currently only persisted on success)
- [x] step 6: fallbacks: if appendUsage is missing, the sidecar id is a random UUID with no usageEntryId; all I/O errors notify once and never fail a prune
- [x] step 7: switch SETTINGS_PATH and the sidecar path to Pi's getAgentDir() so PI_CODING_AGENT_DIR is respected
- [x] step 8: keep StatsAccumulator/CUSTOM_TYPE_STATS unchanged for the pruner's own footer suffix and /pruner stats

## Phase 3 — Upstream coordination
- [x] step 1: open an issue/PR on @hank-warren/pi-stats: count Pi `type:"usage"` entries, and skip any whose `<sessionId>:<entryId>` equals a sidecar record's id (or sidecar.sessionId + usageEntryId)

## Phase 4 — Validation
- [x] step 1: unit tests: oversized summary (summary > raw chars) still produces exactly one usage entry + one sidecar line; stopReason=error and a mid-batch failure in parallel mode still report every completed call; appendUsage args; sidecar record shape (v, id, ts, source, label, provider, model, usage, sessionId, usageEntryId); the shared id matches the returned entry; rotation; fallback when appendUsage is missing; no throw on I/O error
- [ ] step 2: manual check: after a prune, the footer $ goes up by exactly the summarizer cost, /session lists the summarizer model, and pi-stats shows the same tokens/cost once under `(summarizer)`
- [x] step 3: update README + AGENTS.md (usage-report/usage-log modules, sidecar path, shared-id contract, minimum Pi version)

Validation: `npm run check` runs a bundled provider-stream/sidecar regression test. The end-to-end footer, `/session`, and pi-stats dashboard check still needs a live authenticated session. Upstream coordination: https://github.com/hank-warren/pi-extensions/issues/42.

## Risks
- `appendUsage` isn't on the typed `ExtensionAPI`. Feature detection keeps us safe, and we
  could ask Pi to expose `pi.appendUsage`.
- If pi-stats starts counting `type:"usage"` entries before it adopts the shared-id dedupe,
  pruner calls would be counted twice in pi-stats. Phase 3 is there to agree the key with the
  maintainer first.
- The sidecar format is pi-stats' convention (`v: 1`). If it changes, only `src/usage-log.ts`
  needs updating.
