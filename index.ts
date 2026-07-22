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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch, captureUnindexedBatchesFromSession, groupBatchesByMode } from "./src/batch-capture.js";
import { resolveModel, summarizeBatch } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { injectSummaries, pruneMessages } from "./src/pruner.js";
import { applyUnprunedReminder } from "./src/reminder.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import { handleViewerSessionShutdown } from "./src/viewer-server.js";
import { formatSummaryToolCallRefs, makeSummaryDetails, wrapSummaryForContext } from "./src/summary-refs.js";
import type { ContextPruneConfig, CapturedBatch, IndexEntryData, PruneFrontier, FlushOptions } from "./src/types.js";
import {
  DEFAULT_CONFIG,
  CONTEXT_PRUNE_TOOL_NAME,
  CONTEXT_TAG_TOOL_NAMES,
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
} from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { PruneFrontierTracker } from "./src/frontier.js";
import { handleAgentEndLifecycle } from "./src/agent-message-lifecycle.js";
import { batchRawCharCount } from "./src/pre-skip.js";
import { runFlushSummarizePhase } from "./src/flush-summarize-phase.js";

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
  let reminderWatermark = 0;

  type FlushResult =
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number }
    | { ok: false; reason: "empty" | "already-flushing" | "summarizer-failed" | "stale-context" | "failed" | "aborted"; error?: string };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const trimBatchToPendingRange = (batch: CapturedBatch): CapturedBatch | null => {
    const currentFrontier = frontier.get();
    let toolCalls = batch.toolCalls;

    // The indexer tells us what was successfully summarized earlier.
    toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(tc.toolCallId));
    if (toolCalls.length === 0) return null;

    // The frontier tells us the last attempted boundary even when the attempt did
    // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
    // the middle of a long tool chain, keep later tool calls from the same turn
    // instead of dropping the whole batch on the floor.
    if (!currentFrontier) return { ...batch, toolCalls };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };

    const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId);
    if (originalIndex < 0) return { ...batch, toolCalls };

    const remaining = toolCalls.slice(originalIndex + 1);
    if (remaining.length === 0) return null;
    return { ...batch, toolCalls: remaining };
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

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
    for (const record of records) {
      indexer.getIndex().set(record.toolCallId, record);
    }
  };

  // ── Helper: capture + trim + group pending batches (no LLM work) ──────────
  // Exposed to commands.ts via registerCommands so /pruner now can preview the
  // queue before opening the multi-row progress overlay.
  const capturePendingBatches = (ctx: any): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      batches = captureUnindexedBatchesFromSession(branch, indexer, [CONTEXT_PRUNE_TOOL_NAME]);
    } catch {
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  // Summarizes + indexes all pending batches.
  // Summarize phase: runFlushSummarizePhase — pooled (flushConcurrency) when
  // onProgress is set (/pruner now); otherwise unbounded parallel. Pre-skips
  // tiny batches before any LLM call.
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    // Use pre-captured batches if provided (avoids double-capture when the
    // caller previewed the queue before opening the progress overlay).
    let batches: CapturedBatch[] = options.previewedBatches ?? capturePendingBatches(ctx);

    if (batches.length === 0) return { ok: false, reason: "empty" };

    // Bail out before we drain pendingBatches so they don't need restoring.
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };

    // Draining the queue since we've captured the state via session or slice.
    // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
    // or rapid turn-ends don't result in double-summarization.
    pendingBatches.length = 0;

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
      sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, false, details);

    try {
      // Pre-skip + summarizer calls + live status (testable seam).
      const { results, preSkipFlags } = await runFlushSummarizePhase({
        batches,
        minRawCharsToSummarize: currentConfig.value.minRawCharsToSummarize,
        flushConcurrency: currentConfig.value.flushConcurrency,
        pooled: Boolean(options.onProgress),
        signal: options.signal,
        summarizeOne: (batch, _index, onTextProgress) =>
          summarizeBatch(batch, currentConfig.value, ctx, {
            signal: options.signal,
            onTextProgress,
          }),
        onStatus: (text) => setPruneStatusWidget(ctx, currentConfig.value, text),
        onProgress: options.onProgress,
        onBatchTextProgress: options.onBatchTextProgress,
      });

      // Process results in order; stop at first null on a non-pre-skip slot.
      // Batches before the first failure are persisted; remaining are restored to
      // pendingBatches so they are retried on the next flush.
      const processedBatches: CapturedBatch[] = [];
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalToolCallCount = 0;
      let prunedBatchCount = 0;
      let preSkipCount = 0;
      const oversizedBatches: CapturedBatch[] = [];
      let firstFailureIndex = -1;
      const resolved = resolveModel(currentConfig.value, ctx);
      const summarizerModel =
        resolved && typeof resolved === "object" && "provider" in resolved && "id" in resolved
          ? `${String((resolved as { provider: string }).provider)}/${String((resolved as { id: string }).id)}`
          : currentConfig.value.summarizerModel;

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        if (preSkipFlags[i]) {
          // Too small to summarize: keep originals, still count as processed for frontier.
          preSkipCount++;
          totalToolCallCount += batch.toolCalls.length;
          totalRawCharCount += batchRawCharCount(batch);
          processedBatches.push(batch);
          continue;
        }

        const result = results[i];
        if (!result) {
          firstFailureIndex = i;
          break;
        }

        const rawChars = batchRawCharCount(batch);
        const summaryRefs = indexer.allocateSummaryRefs(batch);
        const summaryText = wrapSummaryForContext(result.summaryText + formatSummaryToolCallRefs(summaryRefs));
        const shouldSkipOversized = summaryText.length > rawChars;

        statsAccum.add(result.usage);
        totalRawCharCount += rawChars;
        totalSummaryCharCount += summaryText.length;
        totalToolCallCount += batch.toolCalls.length;

        const batchDetails = makeSummaryDetails(batch, summaryRefs, summarizerModel);

        try {
          if (!shouldSkipOversized) {
            // Write one hidden summary message per turn and index its tool calls.
            // `display: false` keeps the summary in future LLM context and session
            // history without printing the full markdown block into Pi's main window.
            //
            // agentic-auto: never steer — context_prune runs while isStreaming, and
            // steer would re-wake the agent with summary-as-user. Persist to session
            // + indexer; context handler injects near pruned toolResults.
            if (delivery === "runtime" && currentConfig.value.pruneOn === "agentic-auto") {
              const sm = ctx.sessionManager as SessionAppender;
              sm.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, summaryText, false, batchDetails);
              indexer.addBatch(batch, pi);
              indexer.recordSummary(summaryText, batchDetails);
            } else if (delivery === "runtime") {
              pi.sendMessage(
                { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails },
                { deliverAs: "steer" }
              );
              indexer.addBatch(batch, pi);
              indexer.recordSummary(summaryText, batchDetails);
            } else {
              appendSummaryMessage(summaryText, batchDetails);
              persistBatchIndex(batch, appendEntry);
              indexer.recordSummary(summaryText, batchDetails);
            }
            prunedBatchCount++;
          } else {
            oversizedBatches.push(batch);
          }
        } catch (err) {
          // Persistence error mid-loop: stop here, restore this and remaining batches.
          if (isStaleContextError(err)) {
            restoreBatches(batches.slice(i));
            // Advance frontier to what we managed to persist before this point
            break;
          }
          throw err;
        }

        processedBatches.push(batch);
      }

      // Restore unprocessed batches (those at and after the first failure)
      if (firstFailureIndex >= 0) {
        restoreBatches(batches.slice(firstFailureIndex));
      }

      if (processedBatches.length === 0) {
        // Nothing was persisted (all calls failed or first call failed)
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "summarizer-failed" };
      }

      // Advance frontier to the last batch we actually processed.
      const lastBatch = processedBatches[processedBatches.length - 1];
      const lastTC = lastBatch.toolCalls[lastBatch.toolCalls.length - 1];
      // Nothing pruned (all pre-skip and/or oversized) → same outcome family as oversized.
      const nothingPruned = prunedBatchCount === 0;
      const frontierSnapshot: PruneFrontier = {
        lastAttemptedToolCallId: lastTC.toolCallId,
        lastAttemptedToolName: lastTC.toolName,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: processedBatches.length,
        attemptedToolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        outcome: nothingPruned ? "skipped-oversized" : "summarized",
      };

      try {
        if (delivery === "runtime") {
          frontier.advance(frontierSnapshot);
          frontier.persist(pi);
          statsAccum.persist(pi);
        } else {
          frontier.advance(frontierSnapshot);
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          try {
            appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
        }
      } catch (err) {
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }

      setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

      if (preSkipCount > 0) {
        // sentToSummarizer = non-pre-skip batches that reached the process loop (LLM path).
        const sentToSummarizer = processedBatches.length - preSkipCount;
        safeNotify(
          ctx,
          `pruner: skip ${preSkipCount} small · summarize ${sentToSummarizer}`,
          "info",
        );
      }

      // Notify about any oversized batches that were skipped
      for (const batch of oversizedBatches) {
        const batchRaw = batchRawCharCount(batch);
        const idx = batches.indexOf(batch);
        const batchSummaryLen = idx >= 0 ? (results[idx]?.summaryText.length ?? 0) : 0;
        safeNotify(
          ctx,
          `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — summary was ${batchSummaryLen} chars vs ${batchRaw} raw chars; frontier advanced past this range`,
          "warning"
        );
      }

      return {
        ok: true,
        reason: nothingPruned ? "skipped-oversized" : "flushed",
        batchCount: processedBatches.length,
        toolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
      };
    } catch (err) {
      restoreBatches(batches);
      // When the abort signal fired, summarizeBatch rethrows rather than
      // swallowing the error.  Don't show a UI error — the user intended this.
      if (options.signal?.aborted) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "aborted" };
      }
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
    // Note: do NOT stopViewerServer here — session switch would kill a live tree tab.
    // Cleanup is session_shutdown + module reload (globalThis handle).
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;
    reminderWatermark = 0;

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

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
    reminderWatermark = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only final turns are handled by agent_end in agent-message mode.
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
    const batch = trimBatchToPendingRange({
      ...capturedBatch,
      // Do not summarize the pruner's own housekeeping tool result. Otherwise
      // agentic-auto mode can queue the context_prune result and try to flush it
      // during agent_end, when Pi may already have invalidated the extension ctx.
      toolCalls: capturedBatch.toolCalls.filter((tc) => tc.toolName !== CONTEXT_PRUNE_TOOL_NAME),
    });
    if (!batch) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      let trigger: string;
      switch (currentConfig.value.pruneOn) {
        case "on-context-tag":
          trigger = "next context_checkpoint";
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
      if (currentConfig.value.showPruneStatusLine) {
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
        safeNotify(
          ctx,
          `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
          "info"
        );
      }
    }
  });

  // ── tool_execution_end: flush when context_checkpoint (or legacy context_tag) fires ──
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!(CONTEXT_TAG_TOOL_NAMES as readonly string[]).includes(event.toolName)) return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await flushPending(ctx, { delivery: "runtime" });
  });

  // ── agent_end: commit agent-message pruning only after a successful run ───
  // message_end also fires for error/aborted assistant messages, so it is not a
  // reliable success boundary. agent_end is awaited before Pi clears the active
  // run, so the active abort signal still works and session delivery can capture
  // the appender before awaiting the summarizer.
  pi.on("agent_end", async (event, ctx) => {
    await handleAgentEndLifecycle({
      enabled: currentConfig.value.enabled,
      pruneOn: currentConfig.value.pruneOn,
      messages: event.messages,
      pendingCount: pendingBatches.length,
      signal: ctx.signal,
      flush: (options) => flushPending(ctx, options),
      setPendingStatus: (count) => {
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${count} pending`);
      },
    });
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) {
      reminderWatermark = 0;
      return undefined;
    }

    const indexEmpty = indexer.getIndex().size === 0;
    let messages = event.messages;
    let changed = false;

    if (!indexEmpty) {
      const pruned = pruneMessages(messages, indexer, currentConfig.value.pruneOn);
      if (pruned.length !== messages.length) {
        messages = pruned;
        changed = true;
      }
    }

    // agentic-auto: inject batch summaries near pruned toolCalls (no steer).
    if (currentConfig.value.pruneOn === "agentic-auto") {
      const withSummaries = injectSummaries(messages, indexer, currentConfig.value.pruneOn);
      if (withSummaries !== messages) {
        messages = withSummaries;
        changed = true;
      }
    }

    if (
      currentConfig.value.pruneOn === "agentic-auto" &&
      currentConfig.value.remindUnprunedCount
    ) {
      const reminder = applyUnprunedReminder(messages, indexer, reminderWatermark);
      reminderWatermark = reminder.watermark;
      if (reminder.messages !== messages) {
        messages = reminder.messages;
        changed = true;
      }
    } else {
      reminderWatermark = 0;
    }

    if (!changed) return undefined;
    return { messages };
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
  registerContextPruneTool(pi, (ctx, options) => flushPending(ctx, { delivery: "runtime", ...options }));

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(pi, currentConfig, flushPending, capturePendingBatches, syncToolActivation, () => statsAccum.getStats(), indexer);

  // Viewer is process-wide (fixed port). Pi emits session_shutdown on /new,
  // /resume, /fork, reload, and quit — only quit should tear the server down.
  // Switch/reload keep the tab; handlers re-read HTML + latest from disk.
  pi.on("session_shutdown", async (event) => {
    handleViewerSessionShutdown(event.reason);
  });
}
