import { complete } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig, SummarizeResult } from "./types.js";
import { serializeBatchForSummarizer, serializeBatchesForSummarizer } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

/** System prompt for batched summarization (multiple turns in one call). */
const BATCHED_SYSTEM_PROMPT = `You are summarizing multiple turns of tool calls made by an AI coding assistant.
For each turn, provide a concise summary of all tool calls in that turn:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Group by turn. Be concise.`;

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<SummarizeResult | null> {
  try {
    const model = resolveModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`pruner: summarization failed: ${auth.error}`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers }
    );

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const idList = toolCallIds.map((id) => `\`${id}\``).join(", ");
    const footer =
      `\n\n---\n**Summarized toolCallIds**: ${idList}\n` +
      `Use \`context_tree_query\` with these IDs to retrieve the original full outputs.`;

    return {
      summaryText: llmText + footer,
      usage: response.usage,
    };
  } catch (err: any) {
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches in a single LLM call.
 * Returns formatted markdown string, or null on failure.
 * On success, the footer lists ALL toolCallIds across all batches.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext
): Promise<SummarizeResult | null> {
  if (batches.length === 0) return null;
  // Single batch — delegate to the single-batch path for a simpler prompt
  if (batches.length === 1) return summarizeBatch(batches[0], config, ctx);

  try {
    const model = resolveModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`pruner: summarization failed: ${auth.error}`, "error");
      return null;
    }

    const serialized = serializeBatchesForSummarizer(batches);
    const userMessage =
      BATCHED_SYSTEM_PROMPT + "\n\n<tool-call-batches>\n" + serialized + "\n</tool-call-batches>";

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers }
    );

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Collect ALL toolCallIds across all batches for the footer
    const allToolCallIds = batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId));
    const idList = allToolCallIds.map((id) => `\`${id}\``).join(", ");
    const footer =
      `\n\n---\n**Summarized toolCallIds**: ${idList}\n` +
      `Use \`context_tree_query\` with these IDs to retrieve the original full outputs.`;

    return {
      summaryText: llmText + footer,
      usage: response.usage,
    };
  } catch (err: any) {
    ctx.ui.notify(
      `pruner: batch summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}
