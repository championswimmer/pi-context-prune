/**
 * Shared types for the context-prune extension.
 *
 * Design decisions (Phase 1):
 *
 * SUMMARIZATION BATCH (Ph1 step 2):
 *   One batch = one completed assistant turn with tool calls, captured from
 *   the `turn_end` event when event.toolResults.length > 0.
 *   event.message = AssistantMessage (contains ToolCall content blocks with ids)
 *   event.toolResults = ToolResultMessage[] (one per tool call in this turn)
 *
 * STATE MODEL (Ph1 step 3):
 *   - Runtime state: Map<toolCallId, ToolCallRecord> rebuilt on session_start
 *   - Session metadata: pi.appendEntry("context-prune-index", IndexEntryData)
 *     stored once per summarized batch; NOT in LLM context
 *   - User config: .pi/settings.json → "contextPrune" key (JSON merge safe,
 *     Pi preserves unknown keys when rewriting settings files)
 *
 * CONFIG FORMAT (Ph1 step 4):
 *   { "contextPrune": { "enabled": false, "summarizerModel": "default" } }
 *   summarizerModel: "default" = use current active model (ctx.model)
 *                   "provider/model-id" = explicit model via ctx.modelRegistry.find()
 *
 * SUMMARY MESSAGE FORMAT (Ph1 step 5):
 *   customType: "context-prune-summary"
 *   content: markdown with one bullet per tool call + toolCallIds footer
 *   details: SummaryMessageDetails (toolCallIds, toolNames, turnIndex, timestamp)
 *   The content itself includes the toolCallIds in plain text so the model can
 *   reference them in future context_tree_query calls without needing details.
 *
 * API CONSTRAINTS (Ph1 step 6):
 *   - Pruning MUST happen in the `context` event via { messages: filtered },
 *     never by mutating session history (pi.appendEntry / session file untouched)
 *   - Summary injection uses pi.sendMessage(..., { deliverAs: "steer" }) from
 *     inside the turn_end handler so it lands before the next LLM call
 *   - Original full tool outputs are preserved in IndexEntryData (session custom
 *     entries) and accessible via context_tree_query at any time
 *   - v1 prunes only ToolResultMessage entries; the AssistantMessage tool-call
 *     blocks (which carry the toolCallIds) are intentionally kept so the model
 *     can still reference them when calling context_tree_query
 *   - "default" summarizer = ctx.model (current active model + its credentials),
 *     NOT a hidden side-channel. It makes an explicit LLM call from turn_end.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** customType for summary custom_message entries (appear in LLM context) */
export const CUSTOM_TYPE_SUMMARY = "context-prune-summary";

/** customType for index persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_INDEX = "context-prune-index";

/** customType for stats persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_STATS = "context-prune-stats";

/** Footer status widget ID */
export const STATUS_WIDGET_ID = "context-prune";

/** Name of the context_prune tool (injected only when agentic-auto mode is active) */
export const CONTEXT_PRUNE_TOOL_NAME = "context_prune";

/** System prompt injected when agentic-auto mode is active */
export const AGENTIC_AUTO_SYSTEM_PROMPT = `[Context Prune — Agentic Auto Mode]
You have access to the context_prune tool. Use it to summarize and compact preceding tool-call results from context.

Why use context_prune:
- Pruning reduces the size of the context, which lets you work on longer and more complex problems without hitting context limits.
- Summaries keep the key information accessible while freeing up space for new reasoning and tool calls.

When to use context_prune:
- After completing a group of 8–10 related tool calls (e.g., a multi-step file edit, search, or analysis sequence).
- When context is getting large and you want to keep it manageable for future reasoning.
- You should use context_prune at least once after every 12–15 tool calls to prevent context from growing indefinitely.

When NOT to use context_prune:
- Do NOT call it after every 2–3 tool calls. Only use it after a meaningful batch of work is done.
- Do NOT call it for trivial or single tool calls.

What happens when you call context_prune:
- All pending tool-call results are summarized into concise bullet points.
- The original full outputs are removed from context but preserved in the session index.
- You can retrieve the full original output at any time using the context_tree_query tool with the toolCallIds listed in the summary.`;

// ── Config ─────────────────────────────────────────────────────────────────

/**
 * When summarization (and context pruning) is triggered.
 * - "every-turn"     : after every assistant turn that calls tools
 * - "on-context-tag" : batches up turns and flushes when the model calls context_tag
 * - "on-demand"      : only when the user runs /pruner now
 * - "agent-message"  : batches up turns and flushes when the agent sends a final text response
 *                       (a turn with no tool calls), or when the agent loop ends (default)
 * - "agentic-auto"   : the LLM agent decides when to prune by calling the context_prune tool;
 *                       the tool is only active in this mode and guided by prompt instructions
 */
export type PruneOn = "every-turn" | "on-context-tag" | "on-demand" | "agent-message" | "agentic-auto";

/** Choices for the prune-on setting (used by commands and settings overlay) */
export const PRUNE_ON_MODES: { value: PruneOn; label: string }[] = [
  { value: "every-turn", label: "Every turn" },
  { value: "on-context-tag", label: "On context tag" },
  { value: "on-demand", label: "On demand" },
  { value: "agent-message", label: "On agent message" },
  { value: "agentic-auto", label: "Agentic auto" },
];

/** Extension config stored in ~/.pi/agent/context-prune/settings.json */
export interface ContextPruneConfig {
  /** Whether to prune raw tool outputs from future LLM context */
  enabled: boolean;
  /**
   * Which model to use for summarization.
   * "default" = current active Pi model (ctx.model)
   * "provider/model-id" = explicit model (e.g. "anthropic/claude-haiku-3-5")
   */
  summarizerModel: string;
  /** When to trigger summarization and pruning */
  pruneOn: PruneOn;
}

export const DEFAULT_CONFIG: ContextPruneConfig = {
  enabled: false,
  summarizerModel: "default",
  pruneOn: "agent-message",
};

// ── Captured batch ─────────────────────────────────────────────────────────

/** A single tool call + its result as captured from turn_end */
export interface CapturedToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
}

/**
 * One complete batch from a single turn_end event.
 * Represents one assistant turn that contained tool calls.
 */
export interface CapturedBatch {
  turnIndex: number;
  timestamp: number;
  /** Any non-tool-call text from the assistant message (may be empty) */
  assistantText: string;
  toolCalls: CapturedToolCall[];
}

// ── Index record ───────────────────────────────────────────────────────────

/**
 * A single tool call record stored in the runtime index.
 * Contains the full original tool output for context_tree_query recovery.
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Full original result text (potentially large; truncated only at query time) */
  resultText: string;
  isError: boolean;
  turnIndex: number;
  timestamp: number;
}

// ── Session persistence types ──────────────────────────────────────────────

/**
 * Data stored via pi.appendEntry(CUSTOM_TYPE_INDEX, data).
 * One entry per summarized batch; reconstructed into the runtime index on session_start.
 */
export interface IndexEntryData {
  toolCalls: ToolCallRecord[];
}

/**
 * Details stored in the custom summary message's `details` field.
 * Machine-readable metadata so renderers and extensions can inspect summaries.
 */
export interface SummaryMessageDetails {
  toolCallIds: string[];
  toolNames: string[];
  turnIndex: number;
  timestamp: number;
}

// ── Summarizer stats ────────────────────────────────────────────────────────

/**
 * Cumulative token/cost stats for summarizer LLM calls.
 * Persisted via pi.appendEntry(CUSTOM_TYPE_STATS, ...) so stats survive
 * restarts and branch navigation.
 */
export interface SummarizerStats {
  /** Cumulative input tokens across all summarizer calls */
  totalInputTokens: number;
  /** Cumulative output tokens across all summarizer calls */
  totalOutputTokens: number;
  /** Cumulative cost in USD across all summarizer calls */
  totalCost: number;
  /** Number of summarizer LLM calls made */
  callCount: number;
}

/**
 * Result of a summarization call — the summary text plus LLM usage data.
 */
export interface SummarizeResult {
  summaryText: string;
  /** Usage data from the LLM response (tokens + cost) */
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}
