/**
 * Registers the context_prune tool — a tool the LLM can call in agentic-auto mode
 * to trigger summarization and pruning of pending tool-call results.
 *
 * The tool is always registered (so Pi knows about it), but it is only
 * added to the active tools list when pruneOn === "agentic-auto".
 * Activation/deactivation is handled in index.ts via ctx.setActiveTools().
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CONTEXT_PRUNE_TOOL_NAME } from "./types.js";

/**
 * Registers the context_prune tool with Pi.
 * The tool takes no parameters — calling it flushes all pending batches.
 *
 * @param pi      Extension API for tool registration
 * @param flushPending  Shared flush function that summarizes + indexes pending batches
 */
type FlushResult =
  | { ok: true; reason: "flushed"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number }
  | { ok: true; reason: "skipped-oversized"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number }
  | { ok: false; reason: string; error?: string };

export function registerContextPruneTool(
  pi: ExtensionAPI,
  flushPending: (ctx: ExtensionContext) => Promise<FlushResult>,
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
      "Pruned outputs can be recovered in full using context_tree_query with the toolCallIds from the summary.",
      "Do NOT use this tool for trivial or single tool calls — only when context is getting large.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const result = await flushPending(ctx);
        if (!result.ok) {
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

        if (result.reason === "skipped-oversized") {
          return {
            content: [
              {
                type: "text",
                text: `Context prune skipped ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}: the summary was ${result.summaryCharCount} chars while the raw tool results were ${result.rawCharCount} chars. The original tool results were kept, and the prune frontier advanced so the next prune starts after this range.`,
              },
            ],
            details: result,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Context prune completed. Summarized ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"}. Summary size: ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars. Use context_tree_query with the toolCallIds from the summary to retrieve full outputs if needed.`,
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