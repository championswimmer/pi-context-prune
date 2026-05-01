export interface TokenAccountingMetrics {
  rawTokenCount: number;
  summaryTokenCount: number;
  tokensSaved: number;
  savingsRatio: number;
}

const FALLBACK_CHARS_PER_TOKEN = 4;

function normalizeTokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    for (const key of ["totalTokens", "tokenCount", "count", "tokens"]) {
      const normalized = normalizeTokenCount(candidate[key]);
      if (normalized !== null) return normalized;
    }
  }

  return null;
}

/** Deterministic fallback token estimator used when no model tokenizer is available. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

/**
 * Count tokens with a model-provided tokenizer when possible.
 * Falls back to `estimateTokens()` if the model exposes no tokenizer,
 * returns an unsupported shape, or throws while counting.
 */
export function countTokens(text: string, model?: unknown): number {
  if (!text) return 0;
  if (!model || typeof model !== "object") return estimateTokens(text);

  const candidate = model as {
    countTokens?: (input: string) => unknown;
    tokenize?: (input: string) => unknown;
  };

  try {
    if (typeof candidate.countTokens === "function") {
      const normalized = normalizeTokenCount(candidate.countTokens(text));
      if (normalized !== null) return normalized;
    }

    if (typeof candidate.tokenize === "function") {
      const normalized = normalizeTokenCount(candidate.tokenize(text));
      if (normalized !== null) return normalized;
    }
  } catch {
    // Ignore tokenizer failures and fall back to the deterministic estimator.
  }

  return estimateTokens(text);
}

/** Compute token savings for raw text vs its summary. */
export function computeSavings(rawTokenCount: number, summaryTokenCount: number): TokenAccountingMetrics {
  const tokensSaved = rawTokenCount - summaryTokenCount;
  const savingsRatio = rawTokenCount <= 0 ? 0 : tokensSaved / rawTokenCount;
  return {
    rawTokenCount,
    summaryTokenCount,
    tokensSaved,
    savingsRatio,
  };
}

export function formatSavingsRatio(savingsRatio: number): string {
  return `${(savingsRatio * 100).toFixed(1)}%`;
}

export function formatTokenMetrics(metrics: TokenAccountingMetrics): string {
  return `≈ ${metrics.summaryTokenCount} summary vs ${metrics.rawTokenCount} raw tokens, saved ${metrics.tokensSaved} (${formatSavingsRatio(metrics.savingsRatio)})`;
}
