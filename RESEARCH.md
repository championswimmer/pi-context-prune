# Research: CoACT → PI-CoACT roadmap

> Lightweight notes mapping the **CoACT** paper to this extension's next steps.
> This file records the analysis only; it is not a spec.

## Which CoACT? (two papers, don't confuse them)

| | Co**A**ct | **CoACT** ← the relevant one |
|---|---|---|
| Title | Global-Local Hierarchy for Autonomous Agent Collaboration | Action-Preserving Observation Compression for Coding Agents |
| arXiv | 2406.13381 (2024) | **2607.02911 (2026)** |
| Idea | manager/worker multi-agent hierarchy | compress tool *observations* to cut tokens |
| Relevant here | ✗ | **✓** |

## Three ideas worth stealing

1. **NAP (Next-Action Preservation).** A compression is "good" iff the agent still takes the **same next action** after compression. NAP is a cheap, per-step proxy for final task success (pass@1) — which is too expensive/sparse to measure directly.
2. **Generate K candidates → NAP-filter → keep shortest.** Keep only candidates whose induced next action matches the raw-observation action; among survivors pick the most compact. If none survives → **keep the raw observation** (fallback).
3. **Observe-compress, not trajectory-compress, to save the KV cache.** Compress the newest observation *before* it enters the context so the cached prefix stays valid. Result in the paper: −33% total tokens, pass@1 maintained/improved, **no step-count inflation** (aggressive baselines add +24…111% recovery steps).

## How this relates to the current extension

This extension is a **trajectory compressor** (it summarizes past tool-call batches and advances a frontier). CoACT is an **observation compressor**. The paper shows the two are orthogonal and stack (RQ3), and that the only correctness signal that matters is **does the next action survive** — not "is the summary shorter than the raw text", which is what we do today (`minRawCharThreshold` + oversized-skip are char-count heuristics).

## Tiered roadmap

**Tier 1 — replace the char heuristic with the NAP principle (cheap, high signal)**
- **A.** Summarizer prompt: require preserving identifiers the next action needs (file paths, line numbers, exact values, `toolCallId` refs). Today's prompt asks for "future-relevant findings"; make action-relevant tokens explicit.
- **B.** Generate 2–3 summary candidates per batch (we already run batches in parallel), then pick the **shortest one that keeps the same `toolCallId`/ref coverage**. The `context_tree_query` ref system gives us a machine-checkable NAP proxy.

**Tier 2 — add observation compression (the real CoACT), preserve cache ★**
- **C.** Cap/trim each tool result at `turn_end` capture *before* it is stored (`maxObservationChars`, head + tail + compressed middle). Paper's headline win comes from the long-observation tail (2K+ token obs: 9.6% → 2.5%).
- **D.** Length-aware aggressiveness: compress harder for long observations. Sibling to `minRawCharThreshold` (skip short) — add `maxRawCharThreshold` (squeeze long).

**Tier 3 — measure recovery cost (CoACT's online-alignment analog)**
- **E.** Detect when a summary triggers a re-read of the same file/ref in a later turn; if so, make that batch's next compression more conservative. A runtime stand-in for CoACT's online training stage (D₂).

**Reframe.** `minRawCharThreshold` is a cheap pre-filter for CoACT's NAP-fail fallback ("if no compression can preserve the action, keep raw"). Tiny tool outputs almost always have summaries *larger* than the raw text, so skipping them early is the right call — and now has a theoretical justification to cite.

## Suggested order
1. Now (cheap, meaningful): **A** + cite NAP in docs.
2. Next (the substantive "PI-CoACT" work): **C + D** (observation compression + length curve).
3. Follow-up: **B** (multi-candidate + NAP), **E** (recovery-step self-correction).
