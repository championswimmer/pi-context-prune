import { CUSTOM_TYPE_SUMMARY } from "./types.js";

interface CompactToolCallIndex {
  isSummarized(toolCallId: string): boolean;
  getRecord(toolCallId: string): { toolName?: string; args?: any } | undefined;
}

export interface CompactSanitizeStats {
  changed: boolean;
  droppedToolResults: number;
  replacedToolCalls: number;
  summaryMessagesSeen: number;
  beforeChars: number;
  afterChars: number;
}

export interface CompactSanitizeResult<TMessage = any> {
  messages: TMessage[];
  stats: CompactSanitizeStats;
}

const emptyStats = (): CompactSanitizeStats => ({
  changed: false,
  droppedToolResults: 0,
  replacedToolCalls: 0,
  summaryMessagesSeen: 0,
  beforeChars: 0,
  afterChars: 0,
});

function roughChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function shortValue(value: unknown, max = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) return undefined;
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

function compactToolCallLabel(block: any, indexer: CompactToolCallIndex): string {
  const record = indexer.getRecord(block.id);
  const toolName = record?.toolName ?? block.name ?? "tool";
  const args = record?.args ?? block.arguments ?? {};
  const path = typeof args?.path === "string" ? args.path : undefined;
  const command = typeof args?.command === "string" ? shortValue(args.command, 140) : undefined;
  const extra = path ? ` path=${path}` : command ? ` command=${command}` : "";

  return [
    `[context-prune: omitted summarized ${toolName} tool call ${block.id}${extra}.`,
    `Its raw arguments/result were already replaced by a context-prune-summary message;`,
    `use context_tree_query if the original output is needed.]`,
  ].join(" ");
}

function sanitizeAssistantMessage(message: any, indexer: CompactToolCallIndex, stats: CompactSanitizeStats): any {
  if (!Array.isArray(message?.content)) return message;

  let changed = false;
  const content = message.content.map((block: any) => {
    if (block?.type === "toolCall" && typeof block.id === "string" && indexer.isSummarized(block.id)) {
      changed = true;
      stats.replacedToolCalls += 1;
      return { type: "text", text: compactToolCallLabel(block, indexer) };
    }
    return block;
  });

  if (!changed) return message;
  stats.changed = true;
  return { ...message, content };
}

/**
 * Build the view Pi should send to its compaction summarizer after this extension
 * has already summarized tool results. The session tree still contains the raw
 * results, so native /compact would otherwise re-send them and can exceed the
 * model window. We keep the pruner summary messages and remove only data that is
 * recoverable via the context-prune index.
 */
export function sanitizeMessagesForCompact<TMessage = any>(
  messages: TMessage[],
  indexer: CompactToolCallIndex
): CompactSanitizeResult<TMessage> {
  const stats = emptyStats();
  stats.beforeChars = roughChars(messages);

  const sanitized: any[] = [];

  for (const message of messages as any[]) {
    if (message?.role === "custom" && message.customType === CUSTOM_TYPE_SUMMARY) {
      stats.summaryMessagesSeen += 1;
    }

    if (message?.role === "toolResult" && typeof message.toolCallId === "string" && indexer.isSummarized(message.toolCallId)) {
      stats.changed = true;
      stats.droppedToolResults += 1;
      continue;
    }

    if (message?.role === "assistant") {
      sanitized.push(sanitizeAssistantMessage(message, indexer, stats));
      continue;
    }

    sanitized.push(message);
  }

  stats.afterChars = roughChars(sanitized);
  return { messages: (stats.changed ? sanitized : messages) as TMessage[], stats };
}

export function mergeCompactSanitizeStats(...items: CompactSanitizeStats[]): CompactSanitizeStats {
  const merged = emptyStats();
  for (const item of items) {
    merged.changed ||= item.changed;
    merged.droppedToolResults += item.droppedToolResults;
    merged.replacedToolCalls += item.replacedToolCalls;
    merged.summaryMessagesSeen += item.summaryMessagesSeen;
    merged.beforeChars += item.beforeChars;
    merged.afterChars += item.afterChars;
  }
  return merged;
}
