import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";
import { quantizeRawTokenThreshold } from "./prune-threshold.js";

/** Path to the extension's own settings file, independent of any project. */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "context-prune", "settings.json");

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

/**
 * Resolve minRawTokenThreshold, migrating the legacy char-based value when the
 * new token field is absent. Old `minRawCharThreshold` (chars) is converted to
 * tokens (~chars/4, the standard English/code approximation) then snapped to
 * the token step. Once the new field is present it wins outright.
 */
function resolveMinRawTokenThreshold(merged: Partial<ContextPruneConfig>): number {
  if (typeof merged.minRawTokenThreshold === "number" && Number.isFinite(merged.minRawTokenThreshold)) {
    return quantizeRawTokenThreshold(merged.minRawTokenThreshold);
  }
  if (typeof merged.minRawCharThreshold === "number" && Number.isFinite(merged.minRawCharThreshold)) {
    // Legacy char value -> tokens (~4 chars/token).
    return quantizeRawTokenThreshold(merged.minRawCharThreshold / 4);
  }
  return DEFAULT_CONFIG.minRawTokenThreshold;
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

/** Reads ~/.pi/agent/context-prune/settings.json and returns the config (or defaults). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const existing = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...existing };
    return {
      ...merged,
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
      showPruneStatusLine:
        typeof merged.showPruneStatusLine === "boolean"
          ? merged.showPruneStatusLine
          : DEFAULT_CONFIG.showPruneStatusLine,
      pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
      summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
        ? merged.summarizerThinking
        : DEFAULT_CONFIG.summarizerThinking,
      remindUnprunedCount:
        typeof merged.remindUnprunedCount === "boolean"
          ? merged.remindUnprunedCount
          : DEFAULT_CONFIG.remindUnprunedCount,
      batchingMode: merged.batchingMode === "agent-message" ? "agent-message" : DEFAULT_CONFIG.batchingMode,
      minRawTokenThreshold: resolveMinRawTokenThreshold(merged),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes the full config to ~/.pi/agent/context-prune/settings.json. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
}
