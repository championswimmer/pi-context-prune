import { stream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUMMARIZER_THINKING_LEVELS } from "./types.js";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
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
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

/** Ordered reasoning efforts (least → most intensive), matching pi-ai's Effort enum. */
const EFFORT_ORDER: SummarizerThinking[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve the summarizer model WITHOUT firing UI notifications (silent).
 * Returns null when it cannot be resolved (caller falls back gracefully).
 */
function lookupSummarizerModel(config: ContextPruneConfig, ctx: ExtensionContext): any | null {
  if (config.summarizerModel === "default") {
    return ctx.model ?? null;
  }
  const slash = config.summarizerModel.indexOf("/");
  if (slash === -1) return null;
  const provider = config.summarizerModel.slice(0, slash);
  const modelId = config.summarizerModel.slice(slash + 1);
  if (!provider || !modelId) return null;
  try {
    return ctx.modelRegistry?.find?.(provider, modelId) ?? ctx.modelRegistry?.get?.(provider, modelId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Thinking levels the current summarizer model actually supports, derived from
 * its enriched `model.thinking` metadata (minLevel..maxLevel range, or explicit
 * `levels`). Always offers "default" (inherit) and "off". Falls back to the full
 * list when the model or its thinking metadata can't be resolved, so the overlay
 * never breaks. Used by the /CoACT settings overlay to show only valid choices.
 */
export function getSupportedThinkingLevels(
  config: ContextPruneConfig,
  ctx: ExtensionContext,
): { value: SummarizerThinking; label: string }[] {
  const fallback = SUMMARIZER_THINKING_LEVELS;
  const model = lookupSummarizerModel(config, ctx);
  const thinking = model?.thinking;
  if (!thinking) return fallback;

  let efforts: SummarizerThinking[];
  if (Array.isArray(thinking.levels) && thinking.levels.length > 0) {
    efforts = thinking.levels as SummarizerThinking[];
  } else if (thinking.minLevel && thinking.maxLevel) {
    const lo = EFFORT_ORDER.indexOf(thinking.minLevel as SummarizerThinking);
    const hi = EFFORT_ORDER.indexOf(thinking.maxLevel as SummarizerThinking);
    if (lo === -1 || hi === -1 || lo > hi) return fallback;
    efforts = EFFORT_ORDER.slice(lo, hi + 1);
  } else {
    return fallback;
  }

  const supported = new Set<SummarizerThinking>(["default", "off", ...efforts]);
  const filtered = SUMMARIZER_THINKING_LEVELS.filter((l) => supported.has(l.value));
  // Always show the current value even if (somehow) outside the supported range,
  // so the overlay reflects reality and the user can cycle off it.
  if (config.summarizerThinking && !filtered.some((l) => l.value === config.summarizerThinking)) {
    const cur = SUMMARIZER_THINKING_LEVELS.find((l) => l.value === config.summarizerThinking);
    if (cur) filtered.push(cur);
  }
  return filtered.length > 0 ? filtered : fallback;
}

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
      `CoACT: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `CoACT: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
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
      ctx.ui.notify(`CoACT: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    // Pass the abort signal so the underlying fetch is cancelled immediately
    // when the user presses Esc while the tool is running.
    const responseStream = stream(
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
      { apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, ...summarizerThinkingOptions(config) }
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

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");

    const response = await responseStream.result();
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
      `CoACT: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      })
    )
  );
}
