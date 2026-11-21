import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelIdentity } from "pi-extension-settings-tui/schema";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  if (!config.summarizerModel) {
    return {};
  }

  const level = config.summarizerModel.thinkingLevel;
  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === null => ctx.model
 * { model: "provider/model-id", thinkingLevel } => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (!config.summarizerModel) {
    return ctx.model;
  }

  const parsed = parseModelIdentity(config.summarizerModel.model);
  if (!parsed) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel.model}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const found = ctx.modelRegistry.find(parsed.provider, parsed.id);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel.model}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarizeBatch: aborted before start");

  try {
    const model = resolveModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) {
      ctx.ui.notify(`pruner: summarization failed: unknown provider \"${model.provider}\"`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    // Use the provider-owned stream API directly. The compatibility registry
    // facade still exposes auth/header resolution, but no longer exposes a
    // top-level stream() helper of its own.
    const responseStream = provider.stream(
      auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      normalizeContext({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      }),
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: options.signal,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...summarizerThinkingOptions(config),
      }
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // Ask for the final response even after an abort: providers may return
    // partial usage, which must be billed even though the summary is discarded.
    const response = await responseStream.result();
    if (response.usage) {
      try {
        options.onUsage?.(response);
      } catch {
        // Accounting must never change whether a summary succeeds.
      }
    }
    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so flushPending's catch can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarizeBatch: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    return {
      summaryText: llmText,
      usage: response.usage,
    };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, executed
 * in parallel by default or serially when `config.batchExecution === "serial"`.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for separate per-batch calls instead of a single merged call:
 *   • Each batch becomes its own summary message, so they can be rendered,
 *     browsed, and recovered independently via context_tree_query.
 *   • Parallel execution (default) keeps end-to-end latency low; serial
 *     execution can be opted into via settings to avoid overwhelming local
 *     or single-slot inference servers with concurrent requests.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];

  const runBatch = async (batch: CapturedBatch, index: number): Promise<SummarizeResult | null> => {
    options.onProgress?.(index, batches.length, batch, "start");
    const result = await summarizeBatch(batch, config, ctx, {
      signal: options.signal,
      sessionId: options.sessionId,
      onUsage: (response) => options.onUsage?.(batch, response),
      onTextProgress: (receivedChars) => {
        options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
      },
    });
    options.onProgress?.(index, batches.length, batch, result ? "done" : "skipped");
    return result;
  };

  // Single batch — delegate directly (same for serial and parallel)
  if (batches.length === 1) {
    return [await runBatch(batches[0], 0)];
  }

  // Serial — one LLM call at a time, in order. Stop on first failure because
  // flushPending discards anything after the first null and restores the tail.
  if (config.batchExecution === "serial") {
    const results: Array<SummarizeResult | null> = new Array(batches.length).fill(null);
    for (let index = 0; index < batches.length; index++) {
      const result = await runBatch(batches[index], index);
      results[index] = result;
      if (!result) break;
    }
    return results;
  }

  // Parallel (default) — one LLM call per batch, all in flight simultaneously.
  // Wait for every in-flight call even on abort, so final usage callbacks and
  // stats persistence cannot race with flushPending's finally block.
  const settled = await Promise.allSettled(
    batches.map((batch, index) => runBatch(batch, index))
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return settled.map((result) => (result.status === "fulfilled" ? result.value : null));
}
