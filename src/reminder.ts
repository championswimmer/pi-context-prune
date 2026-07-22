/**
 * Unpruned tool-call count reminder.
 *
 * Used only in `agentic-auto` mode. Before each LLM call, computes how many
 * tool-call results in the current message list have NOT yet been summarized
 * (i.e. assistant `toolCall` blocks whose `toolCallId` is not in the indexer).
 * It appends a tiny `<pruner-note>` only when that count first reaches 8 or 12,
 * so the note nudges the model without repeating on every LLM call.
 *
 * Why annotate the last toolResult instead of injecting a new message:
 *   - Preserves user/assistant/toolResult role alternation. A synthetic
 *     appended message would break the alternation mid-loop and some
 *     providers reject it.
 *   - Keeps prompt-cache prefix hits — only the very last message's text
 *     changes per turn. The static prefix (system prompt, tools, earlier
 *     turns) stays cache-hot.
 *   - The model naturally reads the most recent tool result before its next
 *     decision, so the note is seen at exactly the right moment.
 *
 * The annotator only fires when the last message is a `ToolResultMessage`.
 * At loop boundaries (last message is a user message or a final assistant
 * text response) the reminder is irrelevant and skipped.
 */

import type { ToolCallIndexer } from "./indexer.js";
import { CONTEXT_PRUNE_TOOL_NAME } from "./types.js";

const PRUNER_NOTE_OPEN = "<pruner-note>";
const PRUNER_NOTE_CLOSE = "</pruner-note>";
const FIRST_REMINDER_THRESHOLD = 8;
const FINAL_REMINDER_THRESHOLD = 12;

/**
 * Counts tool-call results currently in `messages` that have NOT yet been
 * summarized. A tool call is considered "unpruned" when its `toolCallId`
 * appears as an `AssistantMessage` `toolCall` content block but is absent
 * from the indexer. The `context_prune` housekeeping call is excluded.
 */
export function countUnprunedToolCalls(messages: any[], indexer: ToolCallIndexer): number {
  let count = 0;
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
      if (block.name === CONTEXT_PRUNE_TOOL_NAME) continue;
      const id = block.toolCallId ?? block.id;
      if (!id) continue;
      if (!indexer.isSummarized(id)) count++;
    }
  }
  return count;
}

/**
 * Builds the human-readable reminder line. Wrapped in a tag-like sentinel so
 * the model can clearly distinguish it from real tool output.
 */
export function buildReminderText(count: number): string {
  return `${PRUNER_NOTE_OPEN}${count} unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.${PRUNER_NOTE_CLOSE}`;
}

/**
 * Returns a shallow-cloned message list with a `<pruner-note>` text block
 * appended to the last `ToolResultMessage` content. If `count <= 0` or the
 * last message is not a `ToolResultMessage`, returns `messages` unchanged.
 *
 * The clone is intentionally shallow except for the mutated message and its
 * `content` array, both of which are cloned so we do not mutate Pi's deep-
 * copied event payload in surprising ways.
 */
export function annotateWithUnprunedCount(messages: any[], count: number): any[] {
  if (count <= 0) return messages;
  if (messages.length === 0) return messages;

  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || last.role !== "toolResult") return messages;
  if (!Array.isArray(last.content)) return messages;

  const reminder = { type: "text", text: buildReminderText(count) };
  const clonedLast = {
    ...last,
    content: [...last.content, reminder],
  };

  const out = messages.slice();
  out[lastIndex] = clonedLast;
  return out;
}

/**
 * Adds a reminder only when unpruned work crosses the 8- or 12-call boundary.
 * The watermark resets after the batch is pruned, so later work can be reminded.
 */
export function applyUnprunedReminder(
  messages: any[],
  indexer: ToolCallIndexer,
  watermark: number,
): { messages: any[]; watermark: number } {
  const count = countUnprunedToolCalls(messages, indexer);
  const threshold =
    count >= FINAL_REMINDER_THRESHOLD
      ? FINAL_REMINDER_THRESHOLD
      : count >= FIRST_REMINDER_THRESHOLD
        ? FIRST_REMINDER_THRESHOLD
        : 0;

  if (threshold === 0) return { messages, watermark: 0 };
  if (threshold <= watermark) return { messages, watermark };

  const annotated = annotateWithUnprunedCount(messages, count);
  return annotated === messages
    ? { messages, watermark }
    : { messages: annotated, watermark: threshold };
}
