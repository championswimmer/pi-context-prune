/**
 * agent-message automatic flush policy for agent_end.
 * Keeps the lifecycle decision out of the extension entry so tests can drive
 * the public commit boundary without spinning up a full Pi session.
 */

import { shouldSummarizeAgentMessageOnAgentEnd } from "./agent-end-guard.js";

export type AgentMessageFlushOptions = {
  delivery: "session";
  signal?: AbortSignal;
};

export type AgentEndLifecycleResult = "flushed" | "kept-pending" | "idle";

/**
 * On agent_end in agent-message mode:
 * - omp continuation (`willContinue === true`) → keep pending, do not commit
 * - successful final stop → flush once with the active run signal
 * - any other ending → keep pending batches and surface the pending count
 *
 * Non-agent-message modes never flush here; they only refresh pending status.
 */
export async function handleAgentEndLifecycle(args: {
  enabled: boolean;
  pruneOn: string;
  messages: unknown[];
  pendingCount: number;
  /** omp marks agent_end events that schedule a follow-up run (auto-retry, empty-stop retry). */
  willContinue?: boolean;
  signal?: AbortSignal;
  flush: (options: AgentMessageFlushOptions) => Promise<unknown>;
  setPendingStatus: (count: number) => void;
}): Promise<AgentEndLifecycleResult> {
  if (!args.enabled) return "idle";

  // A continuation is coming: the run is not actually finished, so keep the
  // original tool results pending for the next attempt instead of committing.
  if (args.willContinue) {
    if (args.pendingCount > 0) args.setPendingStatus(args.pendingCount);
    return "kept-pending";
  }

  if (args.pruneOn === "agent-message" && shouldSummarizeAgentMessageOnAgentEnd(args.messages)) {
    await args.flush({ delivery: "session", signal: args.signal });
    return "flushed";
  }

  if (args.pendingCount > 0) {
    args.setPendingStatus(args.pendingCount);
    return "kept-pending";
  }

  return "idle";
}
