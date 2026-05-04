import type { CapturedBatch, CapturedToolCall } from "./types.js";

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

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
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
