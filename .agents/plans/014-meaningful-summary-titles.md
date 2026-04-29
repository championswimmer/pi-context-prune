---
name: 014-meaningful-summary-titles
description: Replace the generic "Turn N summary (M tools)" header on pruned summaries with a meaningful, content-derived title so the context tree and message list become scannable.
steps:
  - phase: discovery
    steps:
      - "- [ ] step 1: catalogue every render surface that currently shows the `Turn N summary (M tools)` string"
      - "- [ ] step 2: confirm the shape of `SummaryMessageDetails` and where it is constructed / persisted"
      - "- [ ] step 3: decide on a title format and a robust extraction strategy"
  - phase: implementation
    steps:
      - "- [ ] step 1: extend the summarizer prompt + return shape to produce a one-line title"
      - "- [ ] step 2: thread the title through `flushPending` into `SummaryMessageDetails`"
      - "- [ ] step 3: update the message renderer in `src/commands.ts` to use the new title"
      - "- [ ] step 4: update the tree-browser header in `src/tree-browser.ts` to use the new title"
      - "- [ ] step 5: add a graceful fallback for older sessions that lack a stored title"
  - phase: validation
    steps:
      - "- [ ] step 1: typecheck / build"
      - "- [ ] step 2: manual sanity check against an existing session (old entries still render) and a fresh prune (new title shows)"
      - "- [ ] step 3: commit and push"
---

# 014-meaningful-summary-titles

## Problem

Every pruned summary currently renders with the same shape:

```
[pruner] Turn 0 summary (4 tools)
```

This appears in:

- `src/commands.ts` — the inline message renderer registered for `context-prune-summary`
  (line ~488: `[pruner] Turn ${turnIndex} summary (${toolCount} tool${...})`).
- `src/tree-browser.ts` — the `/pruner tree` browser header
  (line ~133: `[pruner] Turn ${turnIndex} summary (… chars · original …)`).

Because most agent replies turn over after a single tool-using turn, the
`turnIndex` is almost always `0` for the most recent branch, so users see a
wall of nearly identical headers and have to expand each one to remember what
it actually summarized. The tool count is also a poor differentiator — many
batches have 1–4 tools.

Goal: make each summary's header convey *what was summarized*, not just
*that something was summarized*.

## Design

### Title source — generate it in the summarizer

The cleanest, most informative source is the LLM that already reads every tool
call and result. We will:

1. Tweak `SYSTEM_PROMPT` and `BATCHED_SYSTEM_PROMPT` in `src/summarizer.ts` so
   the model emits a structured first line:

   ```
   TITLE: <≤ 60 char human-readable summary>

   - bullet 1
   - bullet 2
   …
   ```

   The title should describe the *intent* of the work, e.g.
   - `Inspected pruner summary renderer + tree browser`
   - `Edited src/commands.ts settings overlay`
   - `Searched repo for "Turn 0 summary" usages`

   Constraints we'll ask for in the prompt:
   - one line, ≤ 60 chars
   - no leading verb tense lock-in beyond "past tense, imperative-ish"
   - no surrounding quotes, no trailing punctuation
   - no toolCallIds / no markdown / no emoji

2. After the LLM call, parse the response:
   - first non-empty line, `^TITLE:\s*(.+)$` → `title`
   - strip the TITLE line from the body before we append the existing
     `**Summarized toolCallIds**` footer.
   - if the regex fails, fall back to:
     1. first non-empty line of the body, trimmed and clipped to 60 chars, OR
     2. a synthesized title from `toolNames` (e.g. `read, bash, edit (+1)`),
        OR
     3. the existing `Turn N summary (M tools)` string as a last resort.

3. Extend `SummarizeResult` with `title: string` and have both
   `summarizeBatch` and `summarizeBatches` return it.

### Wiring the title through to the renderers

- `src/types.ts` — add `title?: string` to `SummaryMessageDetails`.
  (Optional so we don't break old persisted entries.)
- `index.ts` `flushPending` — when building `details` (≈ line 156), set
  `title: result.title`.
- `src/commands.ts` renderer — replace the constant-shape header with:

  ```ts
  const title = details?.title?.trim();
  const headerText = title
    ? `[pruner] ${title}`
    : `[pruner] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`;
  ```

  Optionally append a tiny suffix ` (${toolCount}t)` or turn number for
  disambiguation when two summaries share a near-identical title.

- `src/tree-browser.ts` — same swap, but keep the rich byte/char info as a
  dim-styled sub-line so the tree browser still shows compaction stats:

  ```
  [pruner] Inspected pruner summary renderer + tree browser
   · 4 tools · 1.2k chars (orig 8.4k)
  ```

### Why "ask the LLM" instead of "first line of the existing summary"?

Today's prompts produce bullet lists that begin with `- read(...)` style
content. Using the first bullet as a title gives us output like
`- read: opened src/commands.ts` — fine, but tightly coupled to the prompt's
formatting and easily broken if we ever tweak it. A dedicated `TITLE:` field
is:

- explicit (one place to parse),
- easy to validate / fall back from,
- cheap (the model already has full context; this is a few extra tokens),
- prompt-format-independent (the bullets can change shape freely).

### Backward compatibility

Old persisted `context-prune-summary` messages don't have `details.title`.
Both renderers must keep their current "Turn N summary (M tools)" behavior
when `title` is missing or empty. No migration is needed.

## Phase 1 — Discovery
- [ ] step 1: catalogue every render surface that currently shows the `Turn N summary (M tools)` string
- [ ] step 2: confirm the shape of `SummaryMessageDetails` and where it is constructed / persisted (`index.ts` `flushPending`, ~line 138–170)
- [ ] step 3: decide on a title format and a robust extraction strategy (resolved above: `TITLE:` line + multi-tier fallback)

## Phase 2 — Implementation
- [ ] step 1: extend the summarizer prompt + return shape to produce a one-line title
  - update `SYSTEM_PROMPT` and `BATCHED_SYSTEM_PROMPT` in `src/summarizer.ts`
  - add `title: string` to `SummarizeResult` in `src/types.ts`
  - add a `extractTitle(rawText, batches)` helper local to `summarizer.ts` with the documented fallback ladder
  - return `{ summaryText, usage, title }` from both summarize functions; `summaryText` no longer contains the `TITLE:` line
- [ ] step 2: thread the title through `flushPending` into `SummaryMessageDetails`
  - extend `SummaryMessageDetails` with `title?: string`
  - set `details.title = result.title` when constructing the summary message in `index.ts`
- [ ] step 3: update the message renderer in `src/commands.ts` to use the new title (with fallback)
- [ ] step 4: update the tree-browser header in `src/tree-browser.ts` to use the new title, keep the chars/original-chars info on a sub-line
- [ ] step 5: add a graceful fallback for older sessions that lack a stored title (already covered by the `details.title?` optional field + ternary)

## Phase 3 — Validation
- [ ] step 1: typecheck / build (`npm run build` or equivalent)
- [ ] step 2: manual sanity check
  - load an existing session containing old summaries → headers still render with the old format
  - trigger a fresh prune → new header shows the LLM-generated title
  - `/pruner tree` shows the new title and the chars sub-line
- [ ] step 3: commit and push

## Out of scope

- Changing the body format of the summary (still bullets).
- Renaming `turnIndex` in `SummaryMessageDetails` (still useful elsewhere).
- Localizing or theming the title beyond the existing `accent` color.
