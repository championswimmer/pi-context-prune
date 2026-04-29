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
