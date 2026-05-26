import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

/**
 * Path to the extension's own settings file, independent of any project.
 * Resolved against pi's agent directory so it honors `PI_CODING_AGENT_DIR`
 * (defaults to `~/.pi/agent`). Each pi preset directory therefore gets its
 * own context-prune config — including its own summarizer model.
 */
export const SETTINGS_PATH = join(getAgentDir(), "context-prune", "settings.json");

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

/** Reads `<agent-dir>/context-prune/settings.json` and returns the config (or defaults). */
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
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes the full config to `<agent-dir>/context-prune/settings.json`. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
}
