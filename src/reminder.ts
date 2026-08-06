/**
 * Unpruned tool-call count reminder.
 *
 * Used only in `agentic-auto` mode. Before each LLM call, computes how many
 * tool-call results in the current message list have NOT yet been summarized
 * (i.e. assistant `toolCall` blocks whose `toolCallId` is not in the indexer)
 * and appends a tiny `<coact-note>` line to the last `ToolResultMessage`'s
 * content. The note nudges the model to call the `context_prune` tool at a
 * sensible cadence.
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

const PRUNER_NOTE_OPEN = "<coact-note>";
const PRUNER_NOTE_CLOSE = "</coact-note>";

/**
 * Counts tool-call results currently in `messages` that have NOT yet been
 * summarized. A tool call is considered "unpruned" when its `toolCallId`
 * appears as an `AssistantMessage` `toolCall` content block but is absent
 * from the indexer.
 */
export function countUnprunedToolCalls(messages: any[], indexer: ToolCallIndexer): number {
  let count = 0;
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall") continue;
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
  return `${PRUNER_NOTE_OPEN}${count} uncompressed tool-call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.${PRUNER_NOTE_CLOSE}`;
}

/**
 * Returns a shallow-cloned message list with a `<coact-note>` text block
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
