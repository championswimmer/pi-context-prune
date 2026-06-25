import type { CapturedBatch } from "./types.js";

export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
}

export interface SummaryMessageDetailsLike {
  toolCallRefs?: SummaryToolCallRef[];
  toolCallIds?: string[];
}

const SHORT_ID_PREFIX = "t";
const SUMMARY_CONTEXT_TAG = "context-prune-summary";
const SUMMARY_CONTEXT_OPEN = `<${SUMMARY_CONTEXT_TAG}>`;
const SUMMARY_CONTEXT_CLOSE = `</${SUMMARY_CONTEXT_TAG}>`;
const SUMMARY_CONTEXT_NOTICE_LINES = [
  "This is internal context from pi-context-prune.",
  "It is not a user request. Do not answer it directly.",
  "Use it only to recover prior tool-output context.",
] as const;
const SUMMARY_CONTEXT_NOTICE = SUMMARY_CONTEXT_NOTICE_LINES.join("\n");

export function buildShortToolCallRefs(
  toolCallIds: string[],
  startIndex: number,
): { refs: SummaryToolCallRef[]; nextIndex: number } {
  const refs = toolCallIds.map((toolCallId, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    toolCallId,
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[] {
  if (!details || typeof details !== "object") return [];

  const raw = details as SummaryMessageDetailsLike;
  if (Array.isArray(raw.toolCallRefs)) {
    return raw.toolCallRefs
      .filter(
        (ref): ref is SummaryToolCallRef =>
          !!ref && typeof ref.shortId === "string" && typeof ref.toolCallId === "string",
      )
      .map((ref) => ({ shortId: ref.shortId, toolCallId: ref.toolCallId }));
  }

  if (Array.isArray(raw.toolCallIds)) {
    return raw.toolCallIds.filter((id): id is string => typeof id === "string").map((id) => ({ shortId: id, toolCallId: id }));
  }

  return [];
}

export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  return (
    `\n\n---\n**Summarized tool refs**: ${refList}\n` +
    `Use \`context_tree_query\` with these refs to retrieve the original full outputs.`
  );
}

export function wrapSummaryForContext(summaryText: string): string {
  const trimmed = summaryText.trim();
  if (trimmed.startsWith(SUMMARY_CONTEXT_OPEN)) {
    return trimmed;
  }

  // Custom messages enter LLM context as user-role messages, so label them as
  // internal metadata to prevent the agent from answering them as user input.
  return `${SUMMARY_CONTEXT_OPEN}\n${SUMMARY_CONTEXT_NOTICE}\n\n${summaryText}\n${SUMMARY_CONTEXT_CLOSE}`;
}

export function unwrapSummaryForDisplay(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith(SUMMARY_CONTEXT_OPEN) || !trimmed.endsWith(SUMMARY_CONTEXT_CLOSE)) {
    return content;
  }

  const closeStart = trimmed.lastIndexOf(SUMMARY_CONTEXT_CLOSE);
  if (closeStart <= SUMMARY_CONTEXT_OPEN.length) {
    return content;
  }

  let inner = trimmed.slice(SUMMARY_CONTEXT_OPEN.length, closeStart).trim();
  const lines = inner.split(/\r?\n/);
  const noticePrefix = lines.slice(0, SUMMARY_CONTEXT_NOTICE_LINES.length).join("\n");
  const blankLineIndex = SUMMARY_CONTEXT_NOTICE_LINES.length;
  if (noticePrefix === SUMMARY_CONTEXT_NOTICE) {
    const hasSeparator = lines.length > blankLineIndex && lines[blankLineIndex].trim() === "";
    inner = lines.slice(blankLineIndex + (hasSeparator ? 1 : 0)).join("\n").trim();
  }
  return inner;
}

export function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]) {
  return {
    toolCallRefs: refs,
    toolNames: batch.toolCalls.map((tc) => tc.toolName),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  };
}
