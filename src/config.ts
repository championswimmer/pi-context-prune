import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  defineSettings,
  field,
  isValidModelThinkingLevel,
  parseModelIdentity,
  type ModelSelection,
  type SettingsScope,
} from "pi-extension-settings-tui/schema";
import {
  createSettingsStore,
  type LoadedSettings,
  type SettingsStore,
  type SettingsStoreOptions,
} from "pi-extension-settings-tui/store";
import type { ContextPruneConfig, PruneOn } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES } from "./types.js";

/** Relative settings file mirrored across <agentDir>/ and <cwd>/.pi/. */
const SETTINGS_FILE = "context-prune/settings.json";

/** Path to the extension's global settings file. */
export const SETTINGS_PATH = join(getAgentDir(), "context-prune", "settings.json");

const PRUNE_MODE_GUIDANCE: Record<PruneOn, string> = {
  "every-turn":
    "Debugging only. Prunes after every tool turn, which is easiest to inspect but churns provider prompt caches the most.",
  "on-context-tag":
    "Good for milestone-based workflows. Flushes when context_checkpoint (legacy: context_tag) is called; requires the pi-context extension for automatic triggering.",
  "on-demand":
    "Maximum manual control. Nothing is pruned until you run /pruner now, so cache invalidation happens only when you choose.",
  "agent-message":
    "Good when you want an automatic, cache-stable flush after the final text reply instead of letting the model choose.",
  "agentic-auto":
    "Recommended default. Lets the model call context_prune at logical task boundaries, but works best when it uses the tool sparingly.",
};

export function formatSummarizerModel(selection: ModelSelection | null): string {
  if (!selection) return "Active model (default)";
  return `${selection.model} (${selection.thinkingLevel})`;
}

/**
 * In-place v2.x -> v3 settings migration:
 * - Converts legacy string `summarizerModel` (`"default"` or `"provider/model-id"`)
 *   + separate `summarizerThinking` into the unified `ModelSelection | null` format.
 * - Maps legacy `summarizerThinking: "default"` (or missing/invalid) to `"off"` when
 *   paired with an explicit model so cheap background summarization does not suddenly
 *   start spending reasoning tokens on upgrade.
 * - Drops the obsolete `summarizerThinking` key.
 */
function migrateLegacySettings(raw: Record<string, unknown>): Record<string, unknown> {
  const hasLegacyStringModel = typeof raw.summarizerModel === "string";
  const hasLegacyThinkingKey = Object.prototype.hasOwnProperty.call(raw, "summarizerThinking");

  if (!hasLegacyStringModel && !hasLegacyThinkingKey) {
    return raw;
  }

  const next: Record<string, unknown> = { ...raw };
  const legacyThinking = next.summarizerThinking;
  delete next.summarizerThinking;

  if (hasLegacyStringModel) {
    const rawModel = (raw.summarizerModel as string).trim();
    if (!rawModel || rawModel === "default" || !parseModelIdentity(rawModel)) {
      next.summarizerModel = null;
    } else {
      const thinkingLevel = isValidModelThinkingLevel(legacyThinking) ? legacyThinking : "off";
      next.summarizerModel = {
        model: rawModel,
        thinkingLevel,
      } satisfies ModelSelection;
    }
  }

  return next;
}

export const contextPruneSettingsSchema = defineSettings({
  id: "context-prune",
  title: "Context Prune Settings",
  description: "Configure automatic tool-output pruning and summarization.",
  version: 3,
  settingsFile: SETTINGS_FILE,
  scopes: ["global", "project"],
  defaultScope: "global",
  saveMode: "immediate",
  migrate: (raw) => migrateLegacySettings(raw),
  tabs: [
    { id: "general", label: "General", description: "Pruning state, trigger mode, and reminders" },
    { id: "summarizer", label: "Summarizer", description: "Model, thinking level, and batching" },
    { id: "display", label: "Display", description: "Footer status, icons, and notices" },
  ],
  fields: {
    enabled: field.boolean<ContextPruneConfig>({
      tab: "general",
      label: "Enabled",
      default: DEFAULT_CONFIG.enabled,
      trueLabel: "On",
      falseLabel: "Off",
      description: (values) =>
        values.enabled
          ? "Context pruning is active. Summarized tool outputs are pruned from future LLM context."
          : "Context pruning is off. Toggle on to summarize and prune completed tool outputs.",
    }),
    pruneOn: field.enum<PruneOn, ContextPruneConfig>({
      tab: "general",
      label: "Prune trigger",
      default: DEFAULT_CONFIG.pruneOn,
      display: "picker",
      description: (values) => {
        const label = PRUNE_ON_MODES.find((m) => m.value === values.pruneOn)?.label ?? values.pruneOn;
        return `${label} (${values.pruneOn}) — ${PRUNE_MODE_GUIDANCE[values.pruneOn]}`;
      },
      options: [
        {
          value: "agentic-auto",
          label: "Agentic auto",
          description: PRUNE_MODE_GUIDANCE["agentic-auto"],
          tone: "accent",
        },
        {
          value: "agent-message",
          label: "On agent message",
          description: PRUNE_MODE_GUIDANCE["agent-message"],
          tone: "success",
        },
        {
          value: "on-demand",
          label: "On demand",
          description: PRUNE_MODE_GUIDANCE["on-demand"],
        },
        {
          value: "on-context-tag",
          label: "On context tag",
          description: PRUNE_MODE_GUIDANCE["on-context-tag"],
        },
        {
          value: "every-turn",
          label: "Every turn",
          description: PRUNE_MODE_GUIDANCE["every-turn"],
          tone: "warn",
        },
      ],
    }),
    remindUnprunedCount: field.boolean<ContextPruneConfig>({
      tab: "general",
      label: "Remind unpruned count",
      default: DEFAULT_CONFIG.remindUnprunedCount,
      trueLabel: "On",
      falseLabel: "Off",
      format: (val, values) =>
        val ? (values && values.pruneOn !== "agentic-auto" ? "On (inactive)" : "On") : "Off",
      tone: (val, values) =>
        val ? (values && values.pruneOn !== "agentic-auto" ? "muted" : "success") : "muted",
      description: (values) => {
        const base = values.remindUnprunedCount ? "ON" : "OFF";
        if (values.pruneOn === "agentic-auto") {
          return `Inject a small <pruner-note> reminder before each LLM call telling the model how many unpruned tool calls are in context. Currently ${base}. Only active in agentic-auto mode.`;
        }
        return `Inject a small <pruner-note> reminder before each LLM call. Currently ${base}, but has NO effect in '${values.pruneOn}' mode — only honored when prune trigger is 'agentic-auto'.`;
      },
    }),

    summarizerModel: field.model<ContextPruneConfig>({
      tab: "summarizer",
      label: "Summarizer model",
      default: DEFAULT_CONFIG.summarizerModel,
      allowClear: true,
      emptyLabel: "Active model (default)",
      emptyDescription: "Use the currently active Pi session model and its default thinking",
      defaultThinkingLevel: "off",
      description: (values) =>
        values.summarizerModel
          ? `Using ${values.summarizerModel.model} (thinking: ${values.summarizerModel.thinkingLevel}) to summarize tool outputs. Press Enter to change model/thinking or reset to active model.`
          : "Using the currently active Pi session model with its default thinking. Press Enter to pick a faster/cheaper summarizer model and thinking level.",
    }),
    batchingMode: field.enum<"turn" | "agent-message", ContextPruneConfig>({
      tab: "summarizer",
      label: "Batching mode",
      default: DEFAULT_CONFIG.batchingMode,
      description: (values) =>
        values.batchingMode === "turn"
          ? "Per turn: one summary per assistant turn. Debugging only — mainly for inspecting pruning behavior, not normal use."
          : "Per agent message (default): merges all assistant turns between two user messages into one summary. Recommended for normal use.",
      options: [
        {
          value: "agent-message",
          label: "Per agent message",
          description: "Merge all assistant turns between two user messages into one summary",
          tone: "accent",
        },
        {
          value: "turn",
          label: "Per turn",
          description: "One summary per assistant turn (debugging only)",
          tone: "warn",
        },
      ],
    }),
    batchExecution: field.enum<"parallel" | "serial", ContextPruneConfig>({
      tab: "summarizer",
      label: "Batch calls",
      default: DEFAULT_CONFIG.batchExecution,
      description: (values) =>
        values.batchExecution === "serial"
          ? "Serial: summarize pending batches one at a time. Avoids concurrent requests on local or rate-limited setups."
          : "Parallel (default): summarize multiple pending batches concurrently. Faster on cloud APIs; switch to serial for local or rate-limited setups.",
      options: [
        {
          value: "parallel",
          label: "Parallel",
          description: "Summarize multiple pending batches concurrently",
          tone: "accent",
        },
        {
          value: "serial",
          label: "Serial",
          description: "Summarize one batch at a time (safe for local/rate-limited servers)",
        },
      ],
    }),

    showPruneStatusLine: field.boolean<ContextPruneConfig>({
      tab: "display",
      label: "Prune status line",
      default: DEFAULT_CONFIG.showPruneStatusLine,
      trueLabel: "Visible",
      falseLabel: "Hidden",
      description: (values) =>
        values.showPruneStatusLine
          ? "Footer status widget and queued turn notifications are visible."
          : "Footer status widget is hidden and queued turn notifications are suppressed (pruning still runs normally).",
    }),
    showPruneStatusCost: field.boolean<ContextPruneConfig>({
      tab: "display",
      label: "Show tokens & cost",
      default: DEFAULT_CONFIG.showPruneStatusCost,
      trueLabel: "On",
      falseLabel: "Off",
      visibleWhen: (values) => values.showPruneStatusLine,
      description: (values) =>
        values.showPruneStatusCost
          ? "Include cumulative summarizer input/output tokens and dollar cost in the visible footer."
          : "Show only pruning mode, pending turns, and summarizing state in the footer (hide tokens & cost).",
    }),
    useNerdFontIcons: field.boolean<ContextPruneConfig>({
      tab: "display",
      label: "Use Nerd Font icons",
      default: DEFAULT_CONFIG.useNerdFontIcons,
      experimental: true,
      trueLabel: "On",
      falseLabel: "Off",
      description:
        "Use Nerd Font scissors and turn icons in status displays. Requires a Nerd Font in your terminal; off uses standard Unicode icons.",
    }),
    showStartupNotice: field.boolean<ContextPruneConfig>({
      tab: "display",
      label: "Startup notice",
      default: DEFAULT_CONFIG.showStartupNotice,
      trueLabel: "On",
      falseLabel: "Off",
      description: (values) =>
        values.showStartupNotice
          ? 'Show the passive startup notice when the pruner loads (for example: "pruner loaded — pruning ON | model: ..."). Manual command output and errors still appear.'
          : "Hide the passive startup notice when the pruner loads. Manual command output and errors still appear.",
    }),
    notifySkipped: field.boolean<ContextPruneConfig>({
      tab: "display",
      label: "Notify skipped prunes",
      default: DEFAULT_CONFIG.notifySkipped,
      trueLabel: "On",
      falseLabel: "Off",
      description:
        "Show a warning notification when pruning is skipped because the summary was larger than the raw tool output it would replace.",
    }),
  },
});

export function createPrunerSettingsStore(
  options?: SettingsStoreOptions,
): SettingsStore<typeof contextPruneSettingsSchema.fields> {
  return createSettingsStore(contextPruneSettingsSchema, {
    agentDir: getAgentDir(),
    ...options,
  });
}

/** Loads effective config (defaults -> global -> trusted project), optionally persisting in-place v2->v3 migrations. */
export async function loadConfigWithMeta(
  options?: {
    readonly cwd?: string;
    readonly trustedProject?: boolean;
    readonly persistMigration?: boolean;
  },
): Promise<LoadedSettings<ContextPruneConfig>> {
  const store = createPrunerSettingsStore({ cwd: options?.cwd });
  return store.load({
    trustedProject: options?.trustedProject ?? false,
    persistMigration: options?.persistMigration ?? false,
  });
}

/** Reads effective config from ~/.pi/agent/context-prune/settings.json (+ trusted project overrides) or defaults on error. */
export async function loadConfig(
  options?: {
    readonly cwd?: string;
    readonly trustedProject?: boolean;
    readonly persistMigration?: boolean;
  },
): Promise<ContextPruneConfig> {
  try {
    const loaded = await loadConfigWithMeta(options);
    return loaded.effective;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Persists override diffs for the given config to the target scope (defaults to global). */
export async function saveConfig(
  config: ContextPruneConfig,
  options?: {
    readonly cwd?: string;
    readonly scope?: SettingsScope;
    readonly trustedProject?: boolean;
  },
): Promise<void> {
  const store = createPrunerSettingsStore({ cwd: options?.cwd });
  await store.save(config, {
    scope: options?.scope ?? "global",
    trustedProject: options?.trustedProject ?? false,
    force: true,
  });
}

/**
 * Patches specific config keys via CLI subcommands.
 * If the current project is trusted and already overrides any patched key, updates project scope
 * so the command takes immediate effect; otherwise writes to global scope.
 */
export async function patchConfig(
  partial: Partial<ContextPruneConfig>,
  options?: {
    readonly cwd?: string;
    readonly scope?: SettingsScope;
    readonly trustedProject?: boolean;
  },
): Promise<{ config: ContextPruneConfig; scope: SettingsScope }> {
  const trustedProject = options?.trustedProject ?? false;
  const store = createPrunerSettingsStore({ cwd: options?.cwd });

  let scope: SettingsScope = options?.scope ?? "global";
  if (!options?.scope && trustedProject) {
    const current = await store.load({ trustedProject: true });
    const hasProjectOverride = Object.keys(partial).some((key) => {
      if (!Object.hasOwn(current.provenance, key)) return false;
      const prov = current.provenance[key as keyof typeof current.provenance];
      return prov === "project" || prov === "both";
    });
    if (hasProjectOverride) {
      scope = "project";
    }
  }

  const result = await store.patch(partial, {
    scope,
    trustedProject,
    force: true,
  });
  return { config: result.loaded.effective, scope: result.savedScope };
}
