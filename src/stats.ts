import type { SummarizerStats } from "./types.js";
import { CUSTOM_TYPE_STATS } from "./types.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Usage shape returned by the LLM `complete()` call.
 * Mirrors the `Usage` interface from `@mariozechner/pi-ai` but declared locally
 * so we don't need a runtime import just for the type.
 */
interface Usage {
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
}

/**
 * Accumulates cumulative token/cost stats for summarizer LLM calls.
 * Stats are persisted to the session via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`
 * and reconstructed on `session_start` / `session_tree`.
 */
export class StatsAccumulator {
  private stats: SummarizerStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    callCount: 0,
  };

  /** Add usage data from one summarizer LLM call. */
  add(usage: Usage): void {
    this.stats.totalInputTokens += usage.input ?? 0;
    this.stats.totalOutputTokens += usage.output ?? 0;
    this.stats.totalCost += usage.cost?.total ?? 0;
    this.stats.callCount += 1;
  }

  /** Return a snapshot of the current cumulative stats. */
  getStats(): SummarizerStats {
    return { ...this.stats };
  }

  /** Reset all accumulated stats to zero. */
  reset(): void {
    this.stats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      callCount: 0,
    };
  }

  /** Serialize stats for session persistence. */
  toJSON(): SummarizerStats {
    return { ...this.stats };
  }

  /** Restore stats from a previously persisted snapshot. */
  fromJSON(data: SummarizerStats): void {
    this.stats = {
      totalInputTokens: data.totalInputTokens ?? 0,
      totalOutputTokens: data.totalOutputTokens ?? 0,
      totalCost: data.totalCost ?? 0,
      callCount: data.callCount ?? 0,
    };
  }

  /**
   * Reconstruct stats from session history by scanning all custom entries
   * with customType === CUSTOM_TYPE_STATS.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.reset();
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === CUSTOM_TYPE_STATS
      ) {
        const data = (entry as any).data as SummarizerStats;
        if (data) {
          this.fromJSON(data);
        }
      }
    }
  }

  /**
   * Persist current stats to the session.
   * Each call appends a new entry; on reconstructFromSession we scan
   * all entries and apply the LAST one (since each entry is a full snapshot).
   */
  persist(pi: ExtensionAPI): void {
    pi.appendEntry(CUSTOM_TYPE_STATS, this.toJSON());
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format token counts like Pi's status line (e.g. "1.2k", "340") */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format cost like "$0.003" */
export function formatCost(n: number): string {
  if (n < 0.001 && n > 0) return `<$0.001`;
  return `$${n.toFixed(3)}`;
}

/**
 * Build the stats suffix for the status widget.
 * Returns something like " │ ↑1.2k ↓340 $0.003" or "" if no calls yet.
 */
export function statsSuffix(stats: SummarizerStats): string {
  if (stats.callCount === 0) return "";
  return ` │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
}