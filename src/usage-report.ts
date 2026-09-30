import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch } from "./types.js";

/** The extension context exposes a read-only session manager type, but the runtime
 * manager supports appendUsage. Capture it before any async provider work. */
export type UsageSession = Pick<SessionManager, "getSessionId"> &
  Partial<Pick<SessionManager, "appendUsage">>;

/**
 * Record one summarizer LLM call as a Pi `type: "usage"` session entry so Pi's
 * footer, `/session`, and pi-stats (>=0.5.0, which reads Pi usage entries directly)
 * all see the spend exactly once.
 *
 * Called from the `onUsage` hook in summarizer.ts, which fires as soon as the
 * provider returns a final AssistantMessage — before any stopReason check, text
 * extraction, or throw/null return — so failed, oversized, and aborted-with-usage
 * calls are all billed. Errors are reported via notifyError and never fail a prune.
 */
export function reportSummarizerUsage(
  session: UsageSession,
  response: AssistantMessage,
  batch: CapturedBatch,
  notifyError: (error: unknown) => void,
): void {
  if (!response.usage) return;
  const provider = response.provider;
  const model = (response as AssistantMessage & { responseModel?: string }).responseModel ?? response.model;
  try {
    if (typeof session.appendUsage === "function") {
      session.appendUsage(
        "context_prune", provider, model, response.usage as Usage,
        `summarizer call: ${batch.toolCalls.length} tool calls (turn ${batch.turnIndex})`,
      );
    }
  } catch (error) {
    notifyError(error);
  }
}
