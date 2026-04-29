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
export function registerContextPruneTool(
  pi: ExtensionAPI,
  flushPending: (ctx: ExtensionContext) => Promise<void>,
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
        await flushPending(ctx);
        return {
          content: [
            {
              type: "text",
              text: "Context prune completed. Pending tool-call results have been summarized and pruned from context. Use context_tree_query with the toolCallIds from the summary to retrieve full outputs if needed.",
            },
          ],
          details: {},
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Context prune failed: ${err.message}`,
            },
          ],
          details: {},
        };
      }
    },
  });
}