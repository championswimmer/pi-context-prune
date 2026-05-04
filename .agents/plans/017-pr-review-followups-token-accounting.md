---
name: 017-pr-review-followups-token-accounting
description: Address PR #9 review feedback for issue #4 by fixing wording, fallback accounting consistency, async-tokenizer hardening, and Node 20-compatible test execution.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: fetch PR #9 review comments and classify each as blocker / should-fix / optional"
      - "- [x] step 2: verify the Node 20 compatibility concern against the repo's release workflow"
      - "- [x] step 3: decide the smallest safe implementation for all four comments"
  - phase: implementation
    steps:
      - "- [x] step 1: harden `src/tokens.ts` against async/thenable tokenizer results without making the public API async"
      - "- [x] step 2: improve `formatTokenMetrics()` wording for negative/zero savings"
      - "- [x] step 3: change fallback raw-token accounting to round once on aggregated raw text rather than per-tool-call"
      - "- [x] step 4: switch the test runner setup to something that works on both Node 20 and Node 22"
      - "- [x] step 5: update/add tests for the new token helper behavior and wording-sensitive logic where appropriate"
  - phase: validation
    steps:
      - "- [x] step 1: run `npm test` on the current Node version"
      - "- [x] step 2: run `npm test` on Node 20 (via nvm/npx) to confirm workflow compatibility"
      - "- [x] step 3: review the diff to confirm issue #4 behavior remains instrumentation-only"
      - "- [x] step 4: commit, push, and update PR #9"
---

# 017-pr-review-followups-token-accounting

## Review summary

PR #9 received four Copilot comments. After inspection:

1. **Async tokenizer assumption** — legit but future-facing. We can harden the helper cheaply by detecting thenables and falling back deterministically.
2. **`saved -50` wording** — legit user-facing bug. Must fix.
3. **Per-tool fallback rounding bias** — legit instrumentation-quality issue. Fix by aggregating raw text before fallback counting.
4. **Node 20-incompatible test script** — legit and important. The release workflow uses Node 20, so `npm test` / `npm run check` should work there too.

## Chosen implementation

- Keep `countTokens()` synchronous, but detect Promise-like return values and attach a no-op rejection handler before falling back.
- Make `formatTokenMetrics()` say one of:
  - `saved N (...)`
  - `no token change (...)`
  - `grew by N (...)`
- Add a helper to count a collection of text blocks in aggregate so the fallback estimator rounds once.
- Replace the `--experimental-strip-types` test script with a Node-20-compatible TypeScript runner (`tsx`).
- Validate on both Node 22 and Node 20 before pushing.

## Validation notes

- `npm test` passes on Node `v22.17.0`.
- `npm run check` passes on Node `v22.17.0`.
- `npm test` passes on Node `v20.20.0` via `nvm use 20.20.0`.
- The follow-up keeps issue #4 instrumentation-only: prune triggers and char-based oversized skip behavior are unchanged.
