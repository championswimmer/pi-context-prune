import { createRequire } from "node:module";

/**
 * Sync token counter. Prefers `gpt-tokenizer` (cl100k base, GPT-4 family — a
 * reasonable default approximation across GPT/Claude/GLM/DeepSeek-class models)
 * which ships with pi. If it isn't resolvable at runtime we fall back to a
 * chars/4 heuristic so the extension still works (just less precisely).
 *
 * Used for the prune/keep decision where char count is a poor proxy: code and
 * structured tool output tokenize more densely than English prose, so a
 * token-delta comparison is materially fairer than a char-delta one.
 */
const nodeRequire = createRequire(import.meta.url);

let counter: ((text: string) => number) | null = null;
let initialized = false;

function ensureCounter(): ((text: string) => number) | null {
  if (initialized) return counter;
  initialized = true;
  try {
    const mod = nodeRequire("gpt-tokenizer");
    const fn = mod?.countTokens;
    counter = typeof fn === "function" ? (text: string) => fn(text) : null;
  } catch {
    counter = null;
  }
  return counter;
}

/** Best-effort token count for a string (real tokenizer when available). */
export function countTokens(text: string): number {
  const c = ensureCounter();
  if (c) return c(text);
  // Fallback: ~4 chars/token is the standard English/code approximation.
  return Math.ceil(text.length / 4);
}
