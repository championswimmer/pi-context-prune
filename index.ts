/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save ~/.pi/agent/context-prune/settings.json
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch } from "./src/batch-capture.js";
import { summarizeBatches } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, pruneStatusText } from "./src/commands.js";
import type { ContextPruneConfig, CapturedBatch, IndexEntryData, PruneFrontier } from "./src/types.js";
import {
  DEFAULT_CONFIG,
  STATUS_WIDGET_ID,
  CONTEXT_PRUNE_TOOL_NAME,
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
} from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { PruneFrontierTracker } from "./src/frontier.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG, pruneOn: "every-turn" },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  let isFlushing = false;

  type FlushResult =
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number }
    | { ok: false; reason: "empty" | "already-flushing" | "summarizer-failed" | "stale-context" | "failed"; error?: string };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeSetStatus = (ctx: any, text: string) => {
    try {
      ctx.ui.setStatus(STATUS_WIDGET_ID, text);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) => message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const isBatchAtOrBeforeFrontier = (batch: CapturedBatch) => {
    const currentFrontier = frontier.get();
    if (!currentFrontier) return false;
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return true;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return false;
    return batch.toolCalls.some((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId);
  };

  const restoreBatches = (batches: CapturedBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  const persistBatchIndex = (batch: CapturedBatch, appendEntry: (customType: string, data?: unknown) => void) => {
    const records = batch.toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
      resultText: tc.resultText,
      isError: tc.isError,
      turnIndex: batch.turnIndex,
      timestamp: batch.timestamp,
    }));

    for (const record of records) {
      indexer.getIndex().set(record.toolCallId, record);
    }

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  };

  // Summarizes + indexes all pending batches in a single LLM call.
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  const flushPending = async (ctx: any, options: { delivery?: "runtime" | "session" } = {}): Promise<FlushResult> => {
    if (pendingBatches.length === 0) return { ok: false, reason: "empty" };
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    const batches = pendingBatches.splice(0); // drain atomically; restore on failure
    const toolCallCount = batches.reduce((sum, batch) => sum + batch.toolCalls.length, 0);
    isFlushing = true;

    const delivery = options.delivery ?? "runtime";
    let sessionManager: SessionAppender | undefined;
    if (delivery === "session") {
      try {
        sessionManager = ctx.sessionManager as unknown as SessionAppender;
      } catch (err) {
        restoreBatches(batches);
        isFlushing = false;
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }
    }

    const appendEntry = (customType: string, data?: unknown) => sessionManager!.appendCustomEntry(customType, data);
    const appendSummaryMessage = (content: string, details: unknown) =>
      sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, true, details);

    try {
      safeSetStatus(ctx, "prune: summarizing…");

      const rawCharCount = batches.reduce(
        (sum, batch) => sum + batch.toolCalls.reduce((batchSum, tc) => batchSum + tc.resultText.length, 0),
        0
      );

      const buildFrontier = (outcome: PruneFrontier["outcome"], summaryCharCount: number): PruneFrontier => {
        const lastBatch = batches[batches.length - 1];
        const lastToolCall = lastBatch.toolCalls[lastBatch.toolCalls.length - 1];
        return {
          lastAttemptedToolCallId: lastToolCall.toolCallId,
          lastAttemptedToolName: lastToolCall.toolName,
          lastAttemptedTurnIndex: lastBatch.turnIndex,
          lastAttemptedTimestamp: lastBatch.timestamp,
          attemptedBatchCount: batches.length,
          attemptedToolCallCount: toolCallCount,
          rawCharCount,
          summaryCharCount,
          outcome,
        };
      };

      // Batch all pending batches into a single LLM call
      const result = await summarizeBatches(batches, currentConfig.value, ctx);

      if (!result) {
        restoreBatches(batches);
        safeSetStatus(ctx, pruneStatusText(currentConfig.value, statsAccum.getStats()));
        return { ok: false, reason: "summarizer-failed" };
      }

      const summaryCharCount = result.summaryText.length;
      const shouldSkipOversized = summaryCharCount > rawCharCount;
      const frontierSnapshot = buildFrontier(
        shouldSkipOversized ? "skipped-oversized" : "summarized",
        summaryCharCount
      );
      const details = {
        toolCallIds: batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId)),
        toolNames: batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolName)),
        turnIndex: batches[0].turnIndex, // first turn of the batch
        timestamp: batches[batches.length - 1].timestamp, // last timestamp
      };

      let attemptRecorded = false;
      try {
        statsAccum.add(result.usage);

        if (delivery === "runtime") {
          if (!shouldSkipOversized) {
            pi.sendMessage(
              {
                customType: CUSTOM_TYPE_SUMMARY,
                content: result.summaryText,
                display: true,
                details,
              },
              { deliverAs: "steer" }
            );
            attemptRecorded = true;

            for (const batch of batches) {
              indexer.addBatch(batch, pi);
            }
          }

          frontier.advance(frontierSnapshot);
          frontier.persist(pi);
          attemptRecorded = true;
          statsAccum.persist(pi);
        } else {
          if (!shouldSkipOversized) {
            // Persist the visible summary before the index that activates pruning.
            // If persistence ever fails partway through, the safer partial state is
            // a summary without pruning rather than pruning without a summary.
            appendSummaryMessage(result.summaryText, details);
            attemptRecorded = true;

            for (const batch of batches) {
              persistBatchIndex(batch, appendEntry);
            }
          }

          frontier.advance(frontierSnapshot);
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          attemptRecorded = true;
          try {
            appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
        }
      } catch (err) {
        if (!attemptRecorded) {
          restoreBatches(batches);
        }
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }

      safeSetStatus(ctx, pruneStatusText(currentConfig.value, statsAccum.getStats()));
      if (shouldSkipOversized) {
        safeNotify(
          ctx,
          `pruner: skipped pruning ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"} — summary was ${summaryCharCount} chars vs ${rawCharCount} raw chars; frontier advanced past this range`,
          "warning"
        );
      }
      return {
        ok: true,
        reason: shouldSkipOversized ? "skipped-oversized" : "flushed",
        batchCount: batches.length,
        toolCallCount,
        rawCharCount,
        summaryCharCount,
      };
    } catch (err) {
      restoreBatches(batches);
      if (isStaleContextError(err)) {
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
    }
  };

  // ── Helper: toggle context_prune tool activation based on config ───────────
  // Uses `pi` (ExtensionRuntime) because getActiveTools/setActiveTools are
  // runtime methods, NOT part of ExtensionContext/ExtensionCommandContext.
  const syncToolActivation = () => {
    const shouldActivate = currentConfig.value.enabled && currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(activeTools.filter((t: string) => t !== CONTEXT_PRUNE_TOOL_NAME));
      }
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from ~/.pi/agent/context-prune/settings.json
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;

    // Update footer status
    ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value, statsAccum.getStats()));

    // Toggle context_prune tool activation for agentic-auto mode
    syncToolActivation();

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info"
    );
  });

  // Rebuild index and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only final turns are handled by message_end in agent-message mode.
      // In print mode, turn_end can fire after session shutdown, so do not start
      // deferred LLM work from this late lifecycle event.
      return;
    }

    const capturedBatch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );
    const batch = {
      ...capturedBatch,
      // Do not summarize the pruner's own housekeeping tool result. Otherwise
      // agentic-auto mode can queue the context_prune result and try to flush it
      // during agent_end, when Pi may already have invalidated the extension ctx.
      toolCalls: capturedBatch.toolCalls.filter((tc) => tc.toolName !== CONTEXT_PRUNE_TOOL_NAME),
    };
    if (batch.toolCalls.length === 0) return;
    if (isBatchAtOrBeforeFrontier(batch)) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      let trigger: string;
      switch (currentConfig.value.pruneOn) {
        case "on-context-tag":
          trigger = "next context_tag";
          break;
        case "agent-message":
          trigger = "agent's next text response";
          break;
        case "agentic-auto":
          trigger = "agent calling context_prune";
          break;
        default:
          trigger = "/pruner now";
          break;
      }
      safeSetStatus(ctx, `prune: ${n} pending`);
      safeNotify(
        ctx,
        `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
        "info"
      );
    }
  });

  // ── tool_execution_end: flush when context_tag fires ─────────────────────
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "context_tag") return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await flushPending(ctx, { delivery: "runtime" });
  });

  // ── message_end: flush after the final assistant response in agent-message mode ──
  // A final assistant message is the earliest reliable boundary where the agent has
  // finished using the raw tool results. flushPending captures the SessionManager
  // before awaiting summarization so print-mode shutdown cannot invalidate the
  // persistence path while the summarizer model is running.
  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (!isFinalAssistantMessage(event.message)) return;
    await flushPending(ctx, { delivery: "session" });
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0) return;
    safeSetStatus(ctx, `prune: ${pendingBatches.length} pending`);
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;
    if (indexer.getIndex().size === 0) return undefined;

    const pruned = pruneMessages(event.messages, indexer);

    // Only return a modified list if something actually changed
    if (pruned.length === event.messages.length) return undefined;
    return { messages: pruned };
  });

  // ── before_agent_start: inject system prompt for agentic-auto mode ───────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentConfig.value.enabled || currentConfig.value.pruneOn !== "agentic-auto") return undefined;
    // Append agentic-auto instructions to the system prompt
    const appended = AGENTIC_AUTO_SYSTEM_PROMPT;
    const original = event.systemPrompt ?? "";
    const newPrompt = original + "\n\n" + appended;
    return { systemPrompt: newPrompt };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register context_prune tool (always registered, activated only in agentic-auto mode) ──
  registerContextPruneTool(pi, (ctx) => flushPending(ctx, { delivery: "runtime" }));

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(pi, currentConfig, flushPending, syncToolActivation, () => statsAccum.getStats(), indexer);
}
