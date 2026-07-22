import { describe, expect, test } from "bun:test";
import { ToolCallIndexer } from "../src/indexer.ts";
import { applyUnprunedReminder } from "../src/reminder.ts";
import { CONTEXT_PRUNE_TOOL_NAME } from "../src/types.ts";

function messagesWithCalls(count: number, toolName = "bash") {
  const calls = Array.from({ length: count }, (_, index) => ({
    type: "toolCall" as const,
    id: `call-${index + 1}`,
    name: toolName,
    arguments: {},
  }));

  return [
    { role: "assistant" as const, content: calls },
    {
      role: "toolResult" as const,
      toolCallId: calls.at(-1)?.id,
      toolName,
      content: [{ type: "text" as const, text: "result" }],
      isError: false,
    },
  ];
}

function reminderText(messages: any[]): string {
  const last = messages.at(-1);
  return last.content.at(-1)?.text ?? "";
}

describe("applyUnprunedReminder", () => {
  test("does not count context_prune housekeeping calls", () => {
    const messages = messagesWithCalls(1, CONTEXT_PRUNE_TOOL_NAME);

    const result = applyUnprunedReminder(messages, new ToolCallIndexer(), 0);

    expect(result.messages).toBe(messages);
    expect(result.watermark).toBe(0);
  });

  test("notifies once at 8 and 12 calls, then resets after pruning", () => {
    const indexer = new ToolCallIndexer();
    const belowThreshold = applyUnprunedReminder(messagesWithCalls(7), indexer, 0);
    const first = applyUnprunedReminder(messagesWithCalls(8), indexer, belowThreshold.watermark);
    const repeated = applyUnprunedReminder(messagesWithCalls(10), indexer, first.watermark);
    const final = applyUnprunedReminder(messagesWithCalls(12), indexer, repeated.watermark);
    const overdue = applyUnprunedReminder(messagesWithCalls(14), indexer, final.watermark);
    const reset = applyUnprunedReminder([], indexer, overdue.watermark);

    expect(belowThreshold.watermark).toBe(0);
    expect(first.watermark).toBe(8);
    expect(reminderText(first.messages)).toContain("8 unpruned tool call result(s)");
    expect(repeated.watermark).toBe(8);
    expect(reminderText(repeated.messages)).toBe("result");
    expect(final.watermark).toBe(12);
    expect(reminderText(final.messages)).toContain("12 unpruned tool call result(s)");
    expect(overdue.watermark).toBe(12);
    expect(reminderText(overdue.messages)).toBe("result");
    expect(reset.watermark).toBe(0);
  });
});
