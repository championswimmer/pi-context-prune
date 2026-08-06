import type { CapturedBatch, PruneFrontierOutcome } from "./types.js";

/** Step (in tokens) that minRawTokenThreshold snaps to. */
export const RAW_TOKEN_THRESHOLD_STEP = 50;

/** Count the raw tool-result characters in a captured batch. */
export function batchRawCharCount(batch: CapturedBatch): number {
  return batch.toolCalls.reduce((sum, toolCall) => sum + toolCall.resultText.length, 0);
}

/** Count the raw tool-result TOKENS in a captured batch (counter injected for testability). */
export function batchRawTokenCount(
  batch: CapturedBatch,
  countTokens: (text: string) => number,
): number {
  return batch.toolCalls.reduce((sum, toolCall) => sum + countTokens(toolCall.resultText), 0);
}

/**
 * Return true when a batch should be skipped before making a summarizer call.
 * A threshold of 0 disables the pre-check; the threshold is inclusive, so a
 * batch with exactly the configured number of raw tokens is summarized.
 * `countTokens` is injected so this module stays free of runtime cross-file imports.
 */
export function isBelowRawTokenThreshold(
  batch: CapturedBatch,
  threshold: number,
  countTokens: (text: string) => number,
): boolean {
  return threshold > 0 && batchRawTokenCount(batch, countTokens) < threshold;
}

/**
 * Snap an arbitrary number to the nearest `RAW_TOKEN_THRESHOLD_STEP` multiple.
 * Non-finite or non-positive values (and anything that rounds down to 0)
 * become 0 (disabled). Keeps `minRawTokenThreshold` always a multiple of the
 * step regardless of where the value came from (settings file, cycler, command).
 */
export function quantizeRawTokenThreshold(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value / RAW_TOKEN_THRESHOLD_STEP) * RAW_TOKEN_THRESHOLD_STEP;
}

/**
 * Derive the prune-frontier outcome from batch counts. Pure function of three
 * inputs so it can be unit-tested without a running extension.
 *
 *  - summarized: at least one batch had its summary persisted
 *  - skipped-below-threshold: every batch was skipped solely for being below minRawTokenThreshold
 *  - skipped-oversized: every batch was skipped solely because its summary was larger than the raw text
 *  - skipped-mixed: nothing was summarized, but more than one skip reason applied
 *
 * The caller must guarantee `summarized + oversized + belowThreshold >= 1` (an
 * empty result is reported as a summarizer failure before this runs).
 */
export function computeFlushOutcome(
  summarizedBatchCount: number,
  oversizedBatchCount: number,
  belowThresholdBatchCount: number,
): PruneFrontierOutcome {
  const allSkipped = summarizedBatchCount === 0;
  if (!allSkipped) return "summarized";
  const onlyBelow = oversizedBatchCount === 0;
  const onlyOversized = belowThresholdBatchCount === 0;
  if (onlyBelow) return "skipped-below-threshold";
  if (onlyOversized) return "skipped-oversized";
  return "skipped-mixed";
}
