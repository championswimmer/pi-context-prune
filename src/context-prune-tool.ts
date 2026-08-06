/**
 * Registers the context_prune tool — a tool the LLM can call in agentic-auto mode
 * to trigger summarization and pruning of pending tool-call results.
 *
 * The tool is always registered (so Pi knows about it), but it is only
 * added to the active tools list when pruneOn === "agentic-auto".
 * Activation/deactivation is handled in index.ts via ctx.setActiveTools().
 */

import { Type } from "@sinclair/typebox";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, FlushOptions } from "./types.js";
import { CONTEXT_PRUNE_TOOL_NAME } from "./types.js";
import { pruneProgressText } from "./progress-text.js";

/**
 * Registers the context_prune tool with Pi.
 * The tool takes no parameters — calling it flushes all pending batches.
 *
 * @param pi      Extension API for tool registration
 * @param flushPending  Shared flush function that summarizes + indexes pending batches
 */
type FlushResult =
  | {
      ok: true;
      reason: "flushed" | "skipped-oversized" | "skipped-below-threshold" | "skipped-mixed";
      batchCount: number;
      toolCallCount: number;
      rawCharCount: number;
      summaryCharCount: number;
      belowThresholdBatchCount: number;
      belowThresholdToolCallCount: number;
    }
  | { ok: false; reason: string; error?: string };

function sendToolProgress(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  text: string,
): void {
  onUpdate?.({
    content: [{ type: "text", text }],
    details: {},
  });
}

export function registerContextPruneTool(
  pi: ExtensionAPI,
  flushFn: (ctx: ExtensionContext, options?: FlushOptions) => Promise<FlushResult>,
): void {
  pi.registerTool({
    name: CONTEXT_PRUNE_TOOL_NAME,
    label: "Prune Context",
    description:
      "Summarize and prune preceding tool-call results from context to reduce context size. " +
      "Call this after completing a batch of 8–10 related tool calls to keep context lean. " +
      "Pruned outputs can be recovered in full using the context_tree_query tool.",
    promptSnippet: "Summarize and prune preceding tool-call results to reduce context size",
    promptGuidelines: [
      "Use after completing a batch of 8–10 related tool calls, not after every 2–3 calls.",
      "Pruned outputs can be recovered in full using context_tree_query with the short refs from the summary.",
      "Do NOT use this tool for trivial or single tool calls — only when context is getting large.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      try {
        sendToolProgress(onUpdate, "Context prune running… (press Esc to cancel)");

        let lastProgressText = "Context prune running…";
        const result = await flushFn(ctx, {
          signal,
          onBatchTextProgress: (index, total, batch, receivedChars) => {
            const next = pruneProgressText(batch, index, total, receivedChars, "running");
            if (next === lastProgressText) return;
            lastProgressText = next;
            sendToolProgress(onUpdate, next);
          },
        });
        if (!result.ok) {
          if (result.reason === "aborted") {
            const cancelledText = "Context prune was cancelled (Esc pressed). No batches were summarized and the prune frontier was not advanced. You can call context_prune again when ready.";
            sendToolProgress(onUpdate, "⊘ Context prune cancelled.");
            return {
              content: [{ type: "text", text: cancelledText }],
              details: result,
            };
          }
          const suffix = "error" in result && result.error ? ` (${result.error})` : "";
          return {
            content: [
              {
                type: "text",
                text: `Context prune did not run: ${result.reason}${suffix}.`,
              },
            ],
            details: result,
          };
        }

        if (result.reason === "skipped-below-threshold") {
          return {
            content: [
              {
                type: "text",
                text: `Context prune skipped ${result.belowThresholdBatchCount} batch${result.belowThresholdBatchCount === 1 ? "" : "es"} (${result.belowThresholdToolCallCount} tool call${result.belowThresholdToolCallCount === 1 ? "" : "s"}): the raw tool results were below the configured minRawTokenThreshold. The original tool results were kept, and the prune frontier advanced so the next prune starts after this range.`,
              },
            ],
            details: result,
          };
        }

        if (result.reason === "skipped-oversized" || result.reason === "skipped-mixed") {
          const belowLine =
            result.reason === "skipped-mixed" && result.belowThresholdBatchCount > 0
              ? ` ${result.belowThresholdBatchCount} additional batch${result.belowThresholdBatchCount === 1 ? "" : "es"} were skipped because they were below the minRawTokenThreshold.`
              : "";
          return {
            content: [
              {
                type: "text",
                text: `Context prune skipped ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}: the summary was ${result.summaryCharCount} chars while the raw tool results were ${result.rawCharCount} chars. The original tool results were kept, and the prune frontier advanced so the next prune starts after this range.${belowLine}`,
              },
            ],
            details: result,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Context prune completed. Summarized ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"}. Summary size: ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars. Use context_tree_query with the short refs from the summary to retrieve full outputs if needed.`,
            },
          ],
          details: result,
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Context prune failed: ${err.message}`,
            },
          ],
          details: { ok: false, reason: "failed", error: err.message },
        };
      }
    },
  });
}