import type { CapturedBatch, CapturedToolCall, BatchingMode } from "./types.js";

/**
 * Converts turn_end event data into a CapturedBatch.
 * @param message      AssistantMessage (content: Array of TextContent|ThinkingContent|ToolCall)
 * @param toolResults  ToolResultMessage[]
 */
export function captureBatch(
  message: any,
  toolResults: any[],
  turnIndex: number,
  timestamp: number
): CapturedBatch {
  const content: any[] = Array.isArray(message?.content) ? message.content : [];

  // Collect assistant prose text
  const assistantText = content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

  // Collect tool calls, matching each to its result
  const toolCalls: CapturedToolCall[] = content
    .filter((block: any) => block.type === "toolCall")
    .map((block: any) => {
      const match = toolResults.find((result: any) => result.toolCallId === block.id);

      let resultText = "(no result)";
      let isError = false;

      if (match) {
        const resultContent: any[] = Array.isArray(match.content) ? match.content : [];
        resultText = resultContent
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        isError = match.isError ?? false;
      }

      return {
        toolCallId: block.id,
        toolName: block.name,
        args: block.input ?? block.args ?? block.arguments ?? {},
        resultText,
        isError,
      } satisfies CapturedToolCall;
    });

  return { turnIndex, timestamp, assistantText, toolCalls };
}

/**
 * Scans a session branch for unsummarized tool results and groups them into CapturedBatches.
 * Useful for capturing results from the current in-progress turn when a prune is triggered.
 *
 * @param branch            The session message branch (from ctx.sessionManager.getBranch())
 * @param indexer           The pruner indexer to check for already-summarized IDs
 * @param excludeToolNames  Optional tool names to skip (e.g. context_prune itself)
 */
export function captureUnindexedBatchesFromSession(
  branch: any[],
  indexer: { isSummarized(id: string): boolean },
  excludeToolNames: string[] = []
): CapturedBatch[] {
  // branch is SessionEntry[]. Each message entry has { type: "message", message: AgentMessage }.
  // We must unwrap the SessionEntry wrapper before accessing role/toolCallId.
  const resultMap = new Map<string, any>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "toolResult" && m.toolCallId) {
      resultMap.set(m.toolCallId, m);
    }
  }

  const batches: CapturedBatch[] = [];
  // turnCounter increments for EVERY assistant message (not just prunable ones).
  // This makes turnIndex stable across multiple prune cycles: pruning removes
  // ToolResultMessages from the context event but leaves AssistantMessages in the
  // session branch, so the count of all assistant messages never decreases and
  // always matches Pi's own event.turnIndex numbering.
  let turnCounter = 0;

  // userTurnGroup increments on every user message seen while walking the branch.
  // All assistant tool-call batches between two consecutive user messages share the
  // same userTurnGroup. This is used by groupBatchesByMode to merge turns within
  // a single user → final-agent-message span when batchingMode === "agent-message".
  let userTurnGroup = 0;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;

    // Advance userTurnGroup on every user message so all subsequent assistant
    // batches get a new group number.
    if (msg.role === "user") {
      userTurnGroup++;
      continue;
    }

    if (msg.role !== "assistant") continue;

    // Stable turn index: count every assistant message regardless of pruning state
    const currentTurnIndex = turnCounter++;

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolCallBlocks = content.filter((c: any) => c.type === "toolCall");

    // Find tool calls that have results in this branch and are not yet summarized
    const readyToPrune = toolCallBlocks.filter((tc: any) => {
      const id = tc.id;
      if (!id) return false;
      if (indexer.isSummarized(id)) return false;
      if (excludeToolNames.includes(tc.name)) return false;
      return resultMap.has(id);
    });

    if (readyToPrune.length > 0) {
      const results = readyToPrune.map((tc: any) => resultMap.get(tc.id));
      const readyIds = new Set(readyToPrune.map((tc: any) => tc.id));
      // We pass the full message but then trim back down to only the tool calls
      // whose results already exist in the session. This lets agentic-auto prune
      // an intermediate completed subset in the middle of a longer tool chain
      // without accidentally capturing later unresolved calls from the same
      // assistant message as "(no result)" placeholders.
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : (msg.timestamp ?? Date.now());
      const batch = captureBatch(msg, results, currentTurnIndex, ts);
      batches.push({
        ...batch,
        toolCalls: batch.toolCalls.filter((tc) => readyIds.has(tc.toolCallId)),
        // Tag with the current group so flushPending can merge by mode
        userTurnGroup,
      });
    }
  }

  return batches;
}

/** Serializes a single CapturedBatch into readable text for the summarizer LLM. */
export function serializeBatchForSummarizer(batch: CapturedBatch): string {
  const parts: string[] = [];

  if (batch.assistantText) {
    parts.push(`Assistant said: ${batch.assistantText}\n`);
  }

  const toolParts = batch.toolCalls.map((tc) => {
    const status = tc.isError ? "ERROR" : "OK";
    const argsJson = JSON.stringify(tc.args, null, 2);

    let resultText = tc.resultText;
    const MAX_CHARS = 2000;
    if (resultText.length > MAX_CHARS) {
      const remaining = resultText.length - MAX_CHARS;
      resultText = resultText.slice(0, MAX_CHARS) + ` ...[${remaining} chars truncated]`;
    }

    return `Tool: ${tc.toolName}(${argsJson})\nResult (${status}): ${resultText}`;
  });

  parts.push(toolParts.join("\n---\n"));

  return parts.join("\n");
}

/**
 * Serializes multiple CapturedBatches into a single readable text block for the summarizer LLM.
 * Each batch is rendered as a separate "Turn" section with a header indicating the turn index.
 */
export function serializeBatchesForSummarizer(batches: CapturedBatch[]): string {
  return batches
    .map((batch, i) => {
      const header = `=== Turn ${batch.turnIndex}${i > 0 ? ` (batch ${i + 1})` : ""} ===`;
      const body = serializeBatchForSummarizer(batch);
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

/**
 * Groups CapturedBatches according to the chosen batching mode.
 *
 * - "turn"          : returns the input array unchanged (one summary per assistant turn).
 * - "agent-message" : merges all consecutive batches that share the same `userTurnGroup`
 *                     into a single CapturedBatch, producing one summary per
 *                     user → final-agent-message span.
 *
 * Batches without a `userTurnGroup` (e.g. from the live `turn_end` capture path) are
 * always passed through one-per-batch regardless of mode — grouping only applies to
 * batches captured from the session branch scan.
 *
 * Merge rules:
 *   - `assistantText` = non-empty values joined with "\n\n"
 *   - `toolCalls`     = concatenation in original order
 *   - `turnIndex`     = last batch's turnIndex (latest turn in the group)
 *   - `timestamp`     = last batch's timestamp
 *   - `userTurnGroup` = shared group value of the merged batches
 */
export function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode): CapturedBatch[] {
  if (mode !== "agent-message") return batches;

  const out: CapturedBatch[] = [];
  // current tracks the mutable merged batch being built for the current group.
  // We spread into a plain object so we can mutate it without affecting the source.
  let current: CapturedBatch & { userTurnGroup: number } | null = null;

  for (const batch of batches) {
    // Batches without a group key are passed through individually; they break
    // any open merge group too since we can't confidently assign them a span.
    if (batch.userTurnGroup === undefined) {
      current = null;
      out.push(batch);
      continue;
    }

    if (current !== null && current.userTurnGroup === batch.userTurnGroup) {
      // Same span — merge into the current accumulated batch
      const textParts = [current.assistantText, batch.assistantText].filter(Boolean);
      current.assistantText = textParts.join("\n\n");
      current.toolCalls = current.toolCalls.concat(batch.toolCalls);
      // Advance to the latest turn metadata
      current.turnIndex = batch.turnIndex;
      current.timestamp = batch.timestamp;
    } else {
      // New group — create a fresh accumulated batch (shallow copy so mutations
      // to `current` do not bleed back into the original `batch` object)
      current = { ...batch, userTurnGroup: batch.userTurnGroup };
      out.push(current);
    }
  }

  return out;
}
