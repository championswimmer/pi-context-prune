import {
  type ContextPruneConfig,
  type SummarizerStats,
  type CapturedBatch,
  type FlushOptions,
  PRUNE_ON_MODES,
  BATCHING_MODES,
  STATUS_WIDGET_ID,
  SUMMARIZER_THINKING_LEVELS,
  FLUSH_CONCURRENCY_MIN,
  FLUSH_CONCURRENCY_MAX,
  DEFAULT_CONFIG,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  saveConfig,
  normalizeFlushConcurrency,
  normalizeMinRawCharsToSummarize,
} from "./config.js";
import { formatTokens, formatCost } from "./stats.js";
import { Container, Text, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { MultiBatchLoaderOverlay } from "./multi-batch-loader.js";
import { runCancellableFlush } from "./cancellable-flush.js";
import { normalizeSummaryToolCallRefs, unwrapSummaryForDisplay } from "./summary-refs.js";
import type { ToolCallIndexer } from "./indexer.js";
import { buildViewerDocument, resolveViewerEntries } from "./viewer-document.js";
import { openViewer, publishViewerDocument } from "./viewer-server.js";

/**
 * Wraps a SettingsList with a border + title, delegating all input handling
 * to the inner list. Container alone doesn't handle input, so we must
 * forward handleInput manually.
 */
class SettingsOverlay extends Container {
  constructor(
    title: string,
    private readonly settingsList: SettingsList,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title, 0, 0));
    this.addChild(settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string) {
    this.settingsList.handleInput(data);
  }

  invalidate() {
    this.settingsList.invalidate();
  }
}

// ── Status widget text ──────────────────────────────────────────────────────

export function pruneStatusText(config: ContextPruneConfig, stats?: SummarizerStats): string {
  const mode = PRUNE_ON_MODES.find((m) => m.value === config.pruneOn)?.label ?? config.pruneOn;
  let text = `prune: ${config.enabled ? "ON" : "OFF"} (${mode})`;
  if (stats && stats.callCount > 0) {
    text += ` │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
  }
  return text;
}

export function setPruneStatusWidget(
  ctx: { ui: { setStatus: (id: string, text?: string) => void } },
  config: ContextPruneConfig,
  value?: SummarizerStats | string,
): void {
  if (!config.showPruneStatusLine) {
    ctx.ui.setStatus(STATUS_WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_WIDGET_ID, typeof value === "string" ? value : pruneStatusText(config, value));
}

// ── Subcommand list (for completions & interactive picker) ──────────────────

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — interactive settings overlay" },
  { value: "on",       label: "on        — enable context pruning" },
  { value: "off",      label: "off       — disable context pruning" },
  { value: "status",  label: "status    — show status, model, thinking, prune trigger, and status line" },
  { value: "model",   label: "model     — show or set the summarizer model" },
  { value: "thinking", label: "thinking  — show or set the summarizer thinking level" },
  { value: "prune-on", label: "prune-on  — show or set the trigger mode" },
  { value: "batching", label: "batching  — show or set the batching mode (turn / agent-message)" },
  { value: "concurrency", label: "concurrency — show or set /pruner now parallel batch limit" },
  { value: "min-chars", label: "min-chars — show or set min raw chars before summarizing" },
  { value: "stats",   label: "stats     — show cumulative summarizer token/cost stats" },
  { value: "tree",    label: "tree      — open web viewer of agent-visible conversation" },
  { value: "now",     label: "now       — flush pending tool calls immediately (cancellable overlay)" },
  { value: "help",    label: "help      — show this help" },
] as const;

// ── Help text ───────────────────────────────────────────────────────────────

const PRUNE_MODE_GUIDANCE: Record<ContextPruneConfig["pruneOn"], string> = {
  "every-turn": "Debugging only. Prunes after every tool turn, which is easiest to inspect but churns provider prompt caches the most.",
  "on-context-tag": "Good for milestone-based workflows. Flushes when context_checkpoint (legacy: context_tag) is called; requires the pi-context extension for automatic triggering.",
  "on-demand": "Maximum manual control. Nothing is pruned until you run /pruner now, so cache invalidation happens only when you choose.",
  "agent-message": "Recommended default. Batches tool work and prunes once after the final text reply, giving the best balance of automation, context savings, and cache stability.",
  "agentic-auto": "Useful for longer autonomous runs. Lets the model call context_prune, but depends on the model using it sparingly.",
};

function pruneModeGuidance(mode: ContextPruneConfig["pruneOn"]): string {
  return PRUNE_MODE_GUIDANCE[mode] ?? "Controls when summarized tool outputs replace raw tool results in future context.";
}

function pruneModeLabel(mode: ContextPruneConfig["pruneOn"]): string {
  return PRUNE_ON_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}

function summarizerThinkingLabel(level: ContextPruneConfig["summarizerThinking"]): string {
  return SUMMARIZER_THINKING_LEVELS.find((entry) => entry.value === level)?.label ?? level;
}

function summarizerThinkingDescription(level: ContextPruneConfig["summarizerThinking"]): string {
  if (level === "default") {
    return "Preserve old behavior: send no explicit thinking option for summarizer calls.";
  }
  if (level === "off") {
    return "Request no summarizer reasoning where the provider adapter supports it; some providers may fall back to their default.";
  }
  return `Request ${level} thinking/reasoning for summarizer calls where supported.`;
}

function parseModelAndThinkingArg(
  value: string,
): { model: string; thinking?: ContextPruneConfig["summarizerThinking"]; error?: string } {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex === -1) {
    return { model: value };
  }

  const model = value.slice(0, separatorIndex);
  const suffix = value.slice(separatorIndex + 1);
  const thinking = SUMMARIZER_THINKING_LEVELS.find((level) => level.value === suffix)?.value;
  if (!model || !thinking) {
    return {
      model: value,
      error: `Invalid model thinking suffix: ${suffix}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`,
    };
  }
  return { model, thinking };
}

function pruneTriggerDescription(mode: ContextPruneConfig["pruneOn"]): string {
  return `When to summarize tool outputs. Current mode: ${pruneModeLabel(mode)} (${mode}) — ${pruneModeGuidance(mode)} Press Enter/Space to cycle through modes.`;
}

function batchingModeLabel(mode: ContextPruneConfig["batchingMode"]): string {
  return BATCHING_MODES.find((m) => m.value === mode)?.label ?? mode;
}

function batchingModeDescription(mode: ContextPruneConfig["batchingMode"]): string {
  if (mode === "turn") {
    return "Per turn (default): one summary per assistant turn. Keeps summaries small and granular.";
  }
  return "Per agent message: merges all assistant turns between two user messages into one summary. Fewer, larger summaries per conversation exchange.";
}

function flushConcurrencyDescription(n: number): string {
  return `Max parallel summarizer calls for /pruner now only (1–16). Currently ${n}. Auto flush paths ignore this.`;
}

function minRawCharsDescription(n: number): string {
  if (n === 0) {
    return "Min raw tool-result chars before summarizing. Currently 0 (disabled — every batch is sent)."
  }
  return `Min raw tool-result chars before summarizing. Currently ${n}. Batches below this skip the LLM (keep originals, advance frontier).`;
}

/** Parse CLI int; returns null if not a plain integer string. */
function parseCliInt(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

function remindUnprunedCountDescription(config: ContextPruneConfig): string {
  const base = config.remindUnprunedCount ? "ON" : "OFF";
  if (config.pruneOn === "agentic-auto") {
    return `Inject a small <pruner-note> reminder when unpruned tool calls first reach 8, then 12. Currently ${base}. Only active in agentic-auto mode.`;
  }
  return `Inject a small <pruner-note> reminder at 8 and 12 unpruned tool calls. Currently ${base}, but has NO effect in '${config.pruneOn}' mode — only honored when prune trigger is 'agentic-auto'.`;
}

/** Best-effort session label for the web viewer header. */
function sessionMetaFromContext(ctx: ExtensionCommandContext): {
  sessionId: string;
  sessionLabel: string;
  timestamp: number;
} {
  const sm = ctx.sessionManager as {
    getSessionId?: () => string;
    getSessionFile?: () => string | null | undefined;
  };
  const sessionId =
    (typeof sm.getSessionId === "function" ? sm.getSessionId() : "") ||
    `session-${Date.now()}`;
  const file =
    typeof sm.getSessionFile === "function" ? sm.getSessionFile() ?? "" : "";
  const pathOrLabel = file || sessionId;
  const parts = pathOrLabel.split(/[/\\]/).filter(Boolean);
  const sessionLabel = parts[parts.length - 1] ?? pathOrLabel;
  return {
    sessionId,
    sessionLabel,
    timestamp: Date.now(),
  };
}

function pruneStatusLineDescription(config: ContextPruneConfig): string {
  const base = config.showPruneStatusLine ? "ON" : "OFF";
  if (config.showPruneStatusLine) {
    return `Show the prune footer status line and queued turn notifications. Currently ${base}.`;
  }
  return `Hide the prune footer status line and queued turn notifications. Currently ${base}.`;
}

const HELP_TEXT = `pruner — automatically summarizes tool-call outputs to keep context lean.

Usage:
  /pruner settings                         Interactive settings overlay
  /pruner on                               Enable context pruning
  /pruner off                              Disable context pruning
  /pruner status                           Show status, model, prune trigger, batching mode, and stats
  /pruner model                            Show the current summarizer model
  /pruner model <id>                       Set summarizer model (e.g. anthropic/claude-haiku-3-5)
  /pruner model <id>:<thinking>            Set summarizer model and thinking together (e.g. openai/gpt-5-mini:low)
  /pruner thinking                         Show the current summarizer thinking level
  /pruner thinking <level>                 Set summarizer thinking: default, off, minimal, low, medium, high, xhigh
  /pruner prune-on                         Show or interactively pick the trigger
  /pruner prune-on every-turn              Summarize after every tool-calling turn (debugging only; worst for prompt cache churn)
  /pruner prune-on on-context-tag          Summarize when context_checkpoint (legacy: context_tag) is called (requires pi-context extension)
  /pruner prune-on on-demand               Only summarize when /pruner now runs
  /pruner prune-on agent-message           Summarize after the agent's final text reply (default; safest for cache stability)
  /pruner prune-on agentic-auto            LLM decides when to prune via context_prune tool
  /pruner batching                         Show or interactively pick the batching granularity
  /pruner batching turn                    One summary per assistant turn (default)
  /pruner batching agent-message           One summary per user→final-agent-message span (merges all turns in a span)
  /pruner concurrency                      Show /pruner now flush concurrency (default 4)
  /pruner concurrency <n>                  Set concurrency 1–16 (only affects /pruner now)
  /pruner min-chars                        Show min raw chars gate before summarizing (default 800)
  /pruner min-chars <n>                    Set min raw chars; 0 disables pre-skip
  /pruner stats                            Show cumulative summarizer token/cost stats
  /pruner tree                             Open local web viewer of agent-visible conversation + summaries
  /pruner now                              Flush pending tool calls immediately (Esc/q cancels)
  /pruner help                             Show this help

Agentic-auto reminder:
  When prune-on is 'agentic-auto' and remindUnprunedCount is true (default), the
  extension appends a tiny <pruner-note> line when unpruned tool calls first reach
  8, then 12. This helps the LLM decide when to call context_prune. Toggle via
  /pruner settings. This setting has no effect in any other prune-on mode.

Batching mode:
  - turn (default): each assistant turn that used tools gets its own summary block. Small, granular.
  - agent-message: all assistant turns between two consecutive user messages are merged into one summary.
    Use this when a single user request triggers many back-to-back tool rounds that belong together.

Mode guidance:
  - every-turn: only for debugging / testing summary behavior. Rewrites earlier context too often and can repeatedly bust provider prompt caches.
  - on-context-tag: good if you already use pi-context save-points. Prunes on explicit milestones via context_checkpoint (legacy: context_tag).
  - on-demand: maximum manual control. Best when you want to decide exactly when to trade cache stability for shorter context.
  - agent-message: recommended default. Batches a whole tool-using run, then prunes once after the final text reply so future requests become cacheable again.
  - agentic-auto: useful for longer autonomous runs, but depends on the model using context_prune sparingly.

Why this matters:
  Frequent edits to earlier context can reduce prompt/prefix cache hits on providers that cache identical prefixes. Batched pruning is usually cheaper and faster than pruning every turn.

Related:
  - pi-context extension (provides context_checkpoint, legacy context_tag): https://github.com/ttttmr/pi-context
  - Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching

Settings are saved to ~/.pi/agent/context-prune/settings.json`;

// ── Command registration ────────────────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number }
    | { ok: false; reason: string; error?: string }
  >,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[],
  syncToolActivation: () => void,
  getStats: () => SummarizerStats,
  indexer: ToolCallIndexer,
): void {
  // Register the /pruner command
  pi.registerCommand("pruner", {
    description: "Context-prune settings and commands",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      // Parse subcommand and remaining args from the raw argument string
      const parts = args.trim().split(/\s+/);
      let subcommand = parts[0] || undefined;
      const subArgs = parts.slice(1); // e.g. ["model", "anthropic/claude-haiku-3-5"] or ["on"])

      // ── Bare /pruner → interactive picker ──
      if (!subcommand) {
        const options = SUBCOMMANDS.map((s) => s.label);
        const choice = await ctx.ui.select("pruner — choose a subcommand", options);
        if (!choice) return;
        // Extract the value (first word) from the label like "settings — interactive settings overlay"
        subcommand = choice.split(/\s+/)[0];
      }

      switch (subcommand) {
        // ── /pruner settings ── interactive overlay ──
        case "settings": {
          const config = currentConfig.value;
          const availableModels = ctx.modelRegistry?.getAvailable() ?? [];

          const items: SettingItem[] = [
            {
              id: "enabled",
              label: "Enabled",
              values: ["true", "false"],
              currentValue: String(config.enabled),
              description: "Enable or disable context pruning",
            },
            {
              id: "showPruneStatusLine",
              label: "Prune status line",
              values: ["true", "false"],
              currentValue: String(config.showPruneStatusLine),
              description: pruneStatusLineDescription(config),
            },
            {
              id: "pruneOn",
              label: "Prune trigger",
              values: PRUNE_ON_MODES.map((m) => m.value),
              currentValue: config.pruneOn,
              description: pruneTriggerDescription(config.pruneOn),
            },
            {
              id: "summarizerModel",
              label: "Summarizer model",
              values: [config.summarizerModel], // show current value as the cycling option
              currentValue: config.summarizerModel,
              description: "Model used for summarizing tool outputs — press Enter to browse models",
              submenu: (currentValue: string, done: (newValue?: string) => void) => {
                const modelItems: SettingItem[] = [
                  {
                    id: "default",
                    label: "default (active model)",
                    values: ["default"],
                    currentValue: currentValue === "default" ? "default" : "",
                    description: "Use the currently active model for summarization",
                  },
                  ...availableModels.map((m) => {
                    const displayId = `${m.provider}/${m.id}`;
                    return {
                      id: displayId,
                      label: displayId,
                      values: [displayId],
                      currentValue: currentValue === displayId ? displayId : "",
                      description: m.name || displayId,
                    };
                  }),
                ];
                return new SettingsList(
                  modelItems,
                  15,
                  getSettingsListTheme(),
                  (_id: string, newValue: string) => done(newValue),
                  () => done(undefined), // onCancel — ESC closes submenu, returns to parent
                  { enableSearch: true },
                );
              },
            },
            {
              id: "summarizerThinking",
              label: "Summarizer thinking",
              values: SUMMARIZER_THINKING_LEVELS.map((level) => level.value),
              currentValue: config.summarizerThinking,
              description: summarizerThinkingDescription(config.summarizerThinking),
            },
            {
              id: "remindUnprunedCount",
              label: "Remind unpruned count",
              values: ["true", "false"],
              currentValue: String(config.remindUnprunedCount),
              description: remindUnprunedCountDescription(config),
            },
            {
              id: "batchingMode",
              label: "Batching mode",
              values: BATCHING_MODES.map((m) => m.value),
              currentValue: config.batchingMode,
              description: batchingModeDescription(config.batchingMode),
            },
            {
              id: "flushConcurrency",
              label: "Flush concurrency",
              values: Array.from({ length: FLUSH_CONCURRENCY_MAX - FLUSH_CONCURRENCY_MIN + 1 }, (_, i) =>
                String(FLUSH_CONCURRENCY_MIN + i),
              ),
              currentValue: String(config.flushConcurrency),
              description: flushConcurrencyDescription(config.flushConcurrency),
            },
            (() => {
              const presets = ["0", "500", "800", "1000", "1500", "2000"];
              const cur = String(config.minRawCharsToSummarize);
              const values = presets.includes(cur) ? presets : [...presets, cur].sort((a, b) => Number(a) - Number(b));
              return {
                id: "minRawCharsToSummarize",
                label: "Min raw chars",
                values,
                currentValue: cur,
                description: minRawCharsDescription(config.minRawCharsToSummarize),
              };
            })(),
          ];

          let settingsList: SettingsList;
          let closeSettingsOverlay = () => {};

          const onChange = (id: string, newValue: string) => {
            const newConfig = { ...currentConfig.value };
            if (id === "enabled") {
              newConfig.enabled = newValue === "true";
            } else if (id === "showPruneStatusLine") {
              newConfig.showPruneStatusLine = newValue === "true";
              const statusLineItem = items.find((item) => item.id === "showPruneStatusLine");
              if (statusLineItem) {
                statusLineItem.description = pruneStatusLineDescription(newConfig);
              }
            } else if (id === "pruneOn") {
              newConfig.pruneOn = newValue as ContextPruneConfig["pruneOn"];
              const pruneTriggerItem = items.find((item) => item.id === "pruneOn");
              if (pruneTriggerItem) {
                pruneTriggerItem.description = pruneTriggerDescription(newConfig.pruneOn);
              }
              const remindItem = items.find((item) => item.id === "remindUnprunedCount");
              if (remindItem) {
                remindItem.description = remindUnprunedCountDescription(newConfig);
              }
            } else if (id === "summarizerModel") {
              newConfig.summarizerModel = newValue;
            } else if (id === "summarizerThinking") {
              newConfig.summarizerThinking = newValue as ContextPruneConfig["summarizerThinking"];
              const thinkingItem = items.find((item) => item.id === "summarizerThinking");
              if (thinkingItem) {
                thinkingItem.description = summarizerThinkingDescription(newConfig.summarizerThinking);
              }
            } else if (id === "remindUnprunedCount") {
              newConfig.remindUnprunedCount = newValue === "true";
              const remindItem = items.find((item) => item.id === "remindUnprunedCount");
              if (remindItem) {
                remindItem.description = remindUnprunedCountDescription(newConfig);
              }
              const pruneTriggerItem = items.find((item) => item.id === "pruneOn");
              if (pruneTriggerItem) {
                pruneTriggerItem.description = pruneTriggerDescription(newConfig.pruneOn);
              }
            } else if (id === "batchingMode") {
              newConfig.batchingMode = newValue as ContextPruneConfig["batchingMode"];
              const batchingItem = items.find((item) => item.id === "batchingMode");
              if (batchingItem) {
                batchingItem.description = batchingModeDescription(newConfig.batchingMode);
              }
            } else if (id === "flushConcurrency") {
              newConfig.flushConcurrency = normalizeFlushConcurrency(Number(newValue));
              const item = items.find((i) => i.id === "flushConcurrency");
              if (item) item.description = flushConcurrencyDescription(newConfig.flushConcurrency);
            } else if (id === "minRawCharsToSummarize") {
              newConfig.minRawCharsToSummarize = normalizeMinRawCharsToSummarize(Number(newValue));
              const item = items.find((i) => i.id === "minRawCharsToSummarize");
              if (item) item.description = minRawCharsDescription(newConfig.minRawCharsToSummarize);
            }
            currentConfig.value = newConfig;
            saveConfig(newConfig);
            setPruneStatusWidget(ctx, newConfig, getStats());
            settingsList?.invalidate();
            // Toggle context_prune tool activation when config changes
            syncToolActivation();
          };

          settingsList = new SettingsList(
            items,
            10,
            getSettingsListTheme(),
            onChange,
            () => closeSettingsOverlay(), // onCancel — close the custom overlay
            { enableSearch: false },
          );

          // Use ctx.ui.custom() to show the settings list as an overlay.
          // The factory receives (tui, theme, keybindings, done) and returns a Component.
          // Wire Escape through the SettingsList constructor's onCancel callback instead
          // of mutating private SettingsList fields.
          await ctx.ui.custom(
            (_tui, _theme, _keybindings, done) => {
              closeSettingsOverlay = () => done(undefined);
              return new SettingsOverlay("pruner settings", settingsList);
            },
            {
              overlay: true,
              overlayOptions: { width: 60 },
            },
          );
          break;
        }

        // ── /pruner on ──
        case "on": {
          currentConfig.value = { ...currentConfig.value, enabled: true };
          saveConfig(currentConfig.value);
          ctx.ui.notify("Context pruning enabled.");
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          syncToolActivation();
          break;
        }

        // ── /pruner off ──
        case "off": {
          currentConfig.value = { ...currentConfig.value, enabled: false };
          saveConfig(currentConfig.value);
          ctx.ui.notify("Context pruning disabled.");
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          syncToolActivation();
          break;
        }

        // ── /pruner status ──
        case "status": {
          const cfg = currentConfig.value;
          const mode = PRUNE_ON_MODES.find((m) => m.value === cfg.pruneOn)?.label ?? cfg.pruneOn;
          const s = getStats();
          const statsLine = s.callCount > 0
            ? `\n  --- summarizer ---\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`
            : "\n  (no summarizer calls yet)";
          ctx.ui.notify(
            `pruner status:\n  enabled:  ${cfg.enabled}\n  model:    ${cfg.summarizerModel}\n  thinking: ${summarizerThinkingLabel(cfg.summarizerThinking)} (${cfg.summarizerThinking})\n  trigger:  ${mode}\n  batching: ${batchingModeLabel(cfg.batchingMode)} (${cfg.batchingMode})\n  concurrency: ${cfg.flushConcurrency} (/pruner now only)\n  min-chars: ${cfg.minRawCharsToSummarize}${cfg.minRawCharsToSummarize === 0 ? " (off)" : ""}\n  status:   ${cfg.showPruneStatusLine ? "on" : "off"}\n  remind:   ${cfg.remindUnprunedCount ? "on" : "off"} (agentic-auto only)${statsLine}`,
          );
          break;
        }

        // ── /pruner tree ── local web conversation viewer ──
        case "tree": {
          try {
            const sm = ctx.sessionManager as {
              buildContextEntries?: () => unknown[];
              getBranch?: () => unknown[];
              getLeafId?: () => string | null;
            };
            // Compaction-aware context path only — never getEntries() (sibling branches).
            const branch = resolveViewerEntries(sm);
            const meta = sessionMetaFromContext(ctx);
            const doc = buildViewerDocument(branch, indexer, meta);
            await publishViewerDocument(doc);
            // forceOpen: user ran the command; server-up-but-no-tab used to silently skip browser.
            const { url, openedBrowser, alreadyRunning } = await openViewer({
              forceOpen: true,
            });
            const action = openedBrowser ? "opened" : alreadyRunning ? "updated" : "ready";
            const leaf =
              typeof sm.getLeafId === "function" ? sm.getLeafId() ?? "null" : "?";
            const trunc = doc.stats.truncated
              ? `, showing last ${doc.stats.messageCount}/${doc.stats.totalMessageCount}`
              : `, ${doc.stats.messageCount} rows`;
            ctx.ui.notify(
              `pruner tree: ${action} ${url}${trunc}, entries ${doc.stats.branchEntryCount}, leaf ${leaf}`,
              doc.stats.messageCount === 0 ? "warning" : "info",
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`pruner tree failed: ${message}`, "error");
          }
          break;
        }

        // ── /pruner stats ──
        case "stats": {
          const s = getStats();
          if (s.callCount === 0) {
            ctx.ui.notify("pruner stats: no summarizer calls yet.");
          } else {
            ctx.ui.notify(
              `pruner stats:\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`,
            );
          }
          break;
        }

        // ── /pruner model [value] ──
        case "model": {
          const modelArg = subArgs[0];
          if (!modelArg) {
            ctx.ui.notify(
              `Current summarizer model: ${currentConfig.value.summarizerModel}\nCurrent summarizer thinking: ${summarizerThinkingLabel(currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`,
            );
          } else {
            const parsed = parseModelAndThinkingArg(modelArg);
            if (parsed.error) {
              ctx.ui.notify(parsed.error, "warning");
              return;
            }
            currentConfig.value = {
              ...currentConfig.value,
              summarizerModel: parsed.model,
              summarizerThinking: parsed.thinking ?? currentConfig.value.summarizerThinking,
            };
            saveConfig(currentConfig.value);
            const thinkingText = parsed.thinking ? ` with thinking ${parsed.thinking}` : "";
            ctx.ui.notify(`Summarizer model set to: ${parsed.model}${thinkingText}`);
          }
          break;
        }

        // ── /pruner thinking [value] ──
        case "thinking": {
          const thinkingArg = subArgs[0];
          if (!thinkingArg) {
            ctx.ui.notify(
              `Current summarizer thinking: ${summarizerThinkingLabel(currentConfig.value.summarizerThinking)} (${currentConfig.value.summarizerThinking})`,
            );
            return;
          }
          if (SUMMARIZER_THINKING_LEVELS.some((level) => level.value === thinkingArg)) {
            currentConfig.value = {
              ...currentConfig.value,
              summarizerThinking: thinkingArg as ContextPruneConfig["summarizerThinking"],
            };
          } else {
            ctx.ui.notify(
              `Invalid summarizer thinking level: ${thinkingArg}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`,
              "warning",
            );
            return;
          }
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Summarizer thinking set to: ${currentConfig.value.summarizerThinking}`);
          break;
        }

        // ── /pruner prune-on [value] ──
        case "prune-on": {
          const modeArg = subArgs[0];
          if (!modeArg) {
            const options = PRUNE_ON_MODES.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("pruner — choose when to trigger summarization", options);
            if (!choice) return;
            // Extract the value (first word) from "every-turn — Every turn"
            const chosenValue = choice.split(/\s+/)[0] as ContextPruneConfig["pruneOn"];
            currentConfig.value = { ...currentConfig.value, pruneOn: chosenValue };
          } else {
            currentConfig.value = { ...currentConfig.value, pruneOn: modeArg as ContextPruneConfig["pruneOn"] };
          }
          saveConfig(currentConfig.value);
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          syncToolActivation();
          break;
        }

        // ── /pruner batching [value] ──
        case "batching": {
          const batchArg = subArgs[0];
          if (!batchArg) {
            const options = BATCHING_MODES.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("pruner — choose batching granularity", options);
            if (!choice) return;
            const chosenValue = choice.split(/\s+/)[0] as ContextPruneConfig["batchingMode"];
            currentConfig.value = { ...currentConfig.value, batchingMode: chosenValue };
          } else {
            if (!BATCHING_MODES.some((m) => m.value === batchArg)) {
              ctx.ui.notify(
                `Invalid batching mode: ${batchArg}. Use one of: ${BATCHING_MODES.map((m) => m.value).join(", ")}.`,
                "warning",
              );
              return;
            }
            currentConfig.value = { ...currentConfig.value, batchingMode: batchArg as ContextPruneConfig["batchingMode"] };
          }
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Batching mode set to: ${batchingModeLabel(currentConfig.value.batchingMode)}`);
          break;
        }

        // ── /pruner concurrency [n] ──
        case "concurrency": {
          const arg = subArgs[0];
          if (!arg) {
            ctx.ui.notify(
              `Flush concurrency: ${currentConfig.value.flushConcurrency} (applies to /pruner now only; default ${DEFAULT_CONFIG.flushConcurrency})`,
            );
            break;
          }
          const parsed = parseCliInt(arg);
          if (parsed == null) {
            ctx.ui.notify(
              `Invalid concurrency: ${arg}. Use an integer ${FLUSH_CONCURRENCY_MIN}–${FLUSH_CONCURRENCY_MAX}.`,
              "warning",
            );
            return;
          }
          if (parsed < FLUSH_CONCURRENCY_MIN || parsed > FLUSH_CONCURRENCY_MAX) {
            ctx.ui.notify(
              `Concurrency must be ${FLUSH_CONCURRENCY_MIN}–${FLUSH_CONCURRENCY_MAX} (got ${parsed}).`,
              "warning",
            );
            return;
          }
          currentConfig.value = {
            ...currentConfig.value,
            flushConcurrency: normalizeFlushConcurrency(parsed),
          };
          saveConfig(currentConfig.value);
          ctx.ui.notify(`Flush concurrency set to: ${currentConfig.value.flushConcurrency}`);
          break;
        }

        // ── /pruner min-chars [n] ──
        case "min-chars": {
          const arg = subArgs[0];
          if (!arg) {
            const n = currentConfig.value.minRawCharsToSummarize;
            ctx.ui.notify(
              `Min raw chars to summarize: ${n}${n === 0 ? " (disabled)" : ""} (default ${DEFAULT_CONFIG.minRawCharsToSummarize}; 0 disables)`,
            );
            break;
          }
          const parsed = parseCliInt(arg);
          if (parsed == null || parsed < 0) {
            ctx.ui.notify(
              `Invalid min-chars: ${arg}. Use an integer >= 0 (0 disables).`,
              "warning",
            );
            return;
          }
          currentConfig.value = {
            ...currentConfig.value,
            minRawCharsToSummarize: parsed,
          };
          saveConfig(currentConfig.value);
          ctx.ui.notify(
            `Min raw chars set to: ${currentConfig.value.minRawCharsToSummarize}${currentConfig.value.minRawCharsToSummarize === 0 ? " (disabled)" : ""}`,
          );
          break;
        }

        // ── /pruner now ──
        case "now": {
          if (!currentConfig.value.enabled) {
            ctx.ui.notify("Context pruning is disabled. Run /pruner on first.", "warning");
            return;
          }

          // Capture the pending queue first so we can pre-build overlay rows.
          const batches = capturePendingBatches(ctx);
          if (batches.length === 0) {
            ctx.ui.notify("pruner: nothing pending — no batches to summarize", "info");
            break;
          }

          // Input-capable multi-batch overlay with an invocation-local abort
          // controller. Esc/q abort the summarizer; the overlay stays open until
          // pending restoration finishes so no flush continues in the background.
          type FlushResult = Awaited<ReturnType<typeof flushPending>>;
          let flushResult: FlushResult | null = null;

          await ctx.ui.custom(
            (tui, theme, _kb, done) => {
              const overlay = new MultiBatchLoaderOverlay(tui, theme, batches);

              void runCancellableFlush({
                bindAbort: (abort) => {
                  overlay.onAbort = abort;
                },
                flush: (signal) =>
                  flushPending(ctx, {
                    previewedBatches: batches,
                    signal,
                    onProgress: (index, _total, _batch, stage) => {
                      if (stage === "start") overlay.markRunning(index);
                      else if (stage === "done") overlay.markDone(index);
                      else overlay.markSkipped(index);
                    },
                    onBatchTextProgress: (index, _total, _batch, receivedChars) => {
                      overlay.markReceivedChars(index, receivedChars);
                    },
                  }),
              })
                .then(({ result }) => {
                  flushResult = result;
                  done(undefined);
                })
                .catch((err) => {
                  flushResult = {
                    ok: false,
                    reason: "failed",
                    error: err instanceof Error ? err.message : String(err),
                  };
                  done(undefined);
                });

              return overlay;
            },
            { overlay: true },
          );

          setPruneStatusWidget(ctx, currentConfig.value, getStats());

          const result = flushResult;
          if (!result) {
            ctx.ui.notify("pruner: nothing flushed — failed", "warning");
            break;
          }

          if (!result.ok) {
            if (result.reason === "aborted") {
              ctx.ui.notify("pruner: cancelled — pending batches restored", "info");
              break;
            }
            const suffix = "error" in result && result.error ? ` (${result.error})` : "";
            ctx.ui.notify(`pruner: nothing flushed — ${result.reason}${suffix}`, result.reason === "empty" ? "info" : "warning");
            break;
          }

          if (result.reason === "skipped-oversized") {
            ctx.ui.notify(
              `pruner: skipped pruning ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} — summary was ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars; frontier advanced past this range`,
              "warning"
            );
            break;
          }

          ctx.ui.notify(
            `pruner: pruned ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"} — summary ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars`,
            "info"
          );
          break;
        }

        // ── /pruner help ──
        case "help":
          ctx.ui.notify(HELP_TEXT);
          break;

        // ── Unknown subcommand ──
        default:
          ctx.ui.notify(
            `Unknown subcommand: "${subcommand}". Run /pruner help for usage.`,
          );
      }
    },
  });

  // Register custom renderer for context-prune-summary messages
  pi.registerMessageRenderer("context-prune-summary", (message, { expanded }, theme) => {
    const details = message.details as {
      toolCallRefs?: { shortId: string; toolCallId: string }[];
      toolCallIds?: string[];
      turnIndex: number;
      toolNames: string[];
    };
    const turnIndex = details?.turnIndex ?? "?";
    const toolCount = normalizeSummaryToolCallRefs(details).length;
    const header = theme.fg("accent", `[pruner] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`);
    if (expanded) {
      return new Text(header + "\n" + unwrapSummaryForDisplay(message.content), 0, 0);
    }
    return new Text(header, 0, 0);
  });
}