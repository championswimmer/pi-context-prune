import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendUsageLog, normalizeUsage, randomUUID } from "./usage-log.js";
import type { CapturedBatch } from "./types.js";

/** The extension context exposes a read-only session manager type, but the runtime
 * manager supports appendUsage. Capture it before any async provider work. */
export type UsageSession = Pick<SessionManager, "getSessionId"> &
  Partial<Pick<SessionManager, "appendUsage">>;

export function reportSummarizerUsage(
  session: UsageSession,
  response: AssistantMessage,
  batch: CapturedBatch,
  notifyError: (error: unknown) => void,
  writeLog = appendUsageLog,
): void {
  if (!response.usage) return;
  const provider = response.provider;
  const model = (response as AssistantMessage & { responseModel?: string }).responseModel ?? response.model;
  let entry: ReturnType<SessionManager["appendUsage"]> | undefined;
  let sessionId = "";
  try {
    sessionId = session.getSessionId();
    if (typeof session.appendUsage === "function") {
      entry = session.appendUsage(
        "context_prune", provider, model, response.usage as Usage,
        `summarizer call: ${batch.toolCalls.length} tool calls (turn ${batch.turnIndex})`,
      );
    }
  } catch (error) {
    notifyError(error);
  }
  // The shared id lets future readers of both channels de-duplicate this call.
  try {
    writeLog({
      v: 1,
      id: entry ? `${sessionId}:${entry.id}` : randomUUID(),
      ts: entry?.timestamp ?? new Date().toISOString(),
      source: "context-prune", label: "summarizer", provider, model,
      usage: normalizeUsage(response.usage), sessionId,
      ...(entry ? { usageEntryId: entry.id } : {}),
      kind: "context_prune",
    });
  } catch (error) {
    notifyError(error);
  }
}
