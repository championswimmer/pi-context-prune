import type { CapturedBatch } from "./types.js";
import { formatCharProgress } from "./stats.js";

export type PruneProgressPhase = "running" | "done" | "skipped";

/**
 * Shared formatter for live prune progress, used by /CoACT now and the
 * context_prune tool so both paths show the exact same text.
 */
export function pruneProgressText(
  batch: CapturedBatch,
  index: number,
  total: number,
  receivedChars: number,
  phase: PruneProgressPhase = "running",
): string {
  const rawChars = batch.toolCalls.reduce((sum, tc) => sum + tc.resultText.length, 0);
  const toolCount = batch.toolCalls.length;
  const batchPrefix = total > 1 ? `batch ${index + 1}/${total} · ` : "";
  const phaseLabel =
    phase === "running"
      ? "Context prune running…"
      : phase === "done"
        ? "Context prune done…"
        : "Context prune skipped…";

  return `${phaseLabel} ${batchPrefix}${formatCharProgress(receivedChars, rawChars)} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}`;
}
