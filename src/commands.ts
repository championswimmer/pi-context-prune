import {
  type ContextPruneConfig,
  type SummarizerStats,
  type CapturedBatch,
  type FlushOptions,
  type FlushResult,
  PRUNE_ON_MODES,
  BATCHING_MODES,
  STATUS_WIDGET_ID,
  PROGRESS_WIDGET_ID,
  SUMMARIZER_THINKING_LEVELS,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "./config.js";
import { formatTokens, formatCost, formatCharProgress } from "./stats.js";
import { Container, Text, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { buildPruneTree, TreeBrowser } from "./tree-browser.js";
import { normalizeSummaryToolCallRefs, unwrapSummaryForDisplay } from "./summary-refs.js";
import { RAW_TOKEN_THRESHOLD_STEP, quantizeRawTokenThreshold } from "./prune-threshold.js";
import { getSupportedThinkingLevels } from "./summarizer.js";
import type { ToolCallIndexer } from "./indexer.js";

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
  let text = `CoACT: ${config.enabled ? "ON" : "OFF"} (${mode})`;
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
  { value: "on",       label: "on        — enable CoACT" },
  { value: "off",      label: "off       — disable CoACT" },
  { value: "status",  label: "status    — show status, model, thinking, trigger, and status line" },
  { value: "model",   label: "model     — show or set the summarizer model" },
  { value: "thinking", label: "thinking  — show or set the summarizer thinking level" },
  { value: "trigger",  label: "trigger   — show or set the compression trigger mode" },
  { value: "batching", label: "batching  — show or set the batching mode (turn / agent-message)" },
  { value: "stats",   label: "stats     — show cumulative summarizer token/cost stats" },
  { value: "tree",    label: "tree      — browse compressed tool calls in a foldable tree" },
  { value: "now",     label: "now       — flush pending tool calls immediately (widget progress)" },
  { value: "help",    label: "help      — show this help" },
] as const;

// ── Help text ───────────────────────────────────────────────────────────────

const PRUNE_MODE_GUIDANCE: Record<ContextPruneConfig["pruneOn"], string> = {
  "every-turn": "Debugging only. Compresses after every tool turn, which is easiest to inspect but churns provider prompt caches the most.",
  "on-context-tag": "Good for milestone-based workflows. Flushes when context_checkpoint (legacy: context_tag) is called; requires the pi-context extension for automatic triggering.",
  "on-demand": "Maximum manual control. Nothing is compressed until you run /CoACT now, so cache invalidation happens only when you choose.",
  "agent-message": "Recommended default. Batches tool work and compresses once after the final text reply, giving the best balance of automation, context savings, and cache stability.",
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
  return `When to compress tool outputs. Current mode: ${pruneModeLabel(mode)} (${mode}) — ${pruneModeGuidance(mode)} Press Enter/Space to cycle through modes.`;
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

const MIN_RAW_TOKEN_PRESETS = [0, 50, 100, 200, 300, 500, 1000];

function minRawTokenThresholdDescription(threshold: number): string {
  if (threshold <= 0) {
    return "Summarize every batch (disabled). Press Enter/Space to cycle in 50-token steps.";
  }
  return `Skip batches whose raw tool output is below ${threshold} tokens (no summarizer LLM call). Steps in 50-token increments; press Enter/Space to cycle.`;
}

function remindUnprunedCountDescription(config: ContextPruneConfig): string {
  const base = config.remindUnprunedCount ? "ON" : "OFF";
  if (config.pruneOn === "agentic-auto") {
    return `Inject a small <coact-note> reminder before each LLM call telling the model how many uncompressed tool calls are in context. Currently ${base}. Only active in agentic-auto mode.`;
  }
  return `Inject a small <coact-note> reminder before each LLM call. Currently ${base}, but has NO effect in '${config.pruneOn}' mode — only honored when the trigger is 'agentic-auto'.`;
}

function pruneStatusLineDescription(config: ContextPruneConfig): string {
  const base = config.showPruneStatusLine ? "ON" : "OFF";
  if (config.showPruneStatusLine) {
    return `Show the CoACT footer status line and queued turn notifications. Currently ${base}.`;
  }
  return `Hide the CoACT footer status line and queued turn notifications. Currently ${base}.`;
}

const HELP_TEXT = `CoACT — action-preserving observation compression for coding agents.
Automatically summarizes tool-call outputs to keep context lean.

Usage:
  /CoACT settings                         Interactive settings overlay
  /CoACT on                               Enable CoACT
  /CoACT off                              Disable CoACT
  /CoACT status                           Show status, model, trigger, batching mode, and stats
  /CoACT model                            Show the current summarizer model
  /CoACT model <id>                       Set summarizer model (e.g. anthropic/claude-haiku-3-5)
  /CoACT model <id>:<thinking>            Set summarizer model and thinking together (e.g. openai/gpt-5-mini:low)
  /CoACT thinking                         Show the current summarizer thinking level
  /CoACT thinking <level>                 Set summarizer thinking: default, off, minimal, low, medium, high, xhigh
  /CoACT trigger                          Show or interactively pick the trigger mode
  /CoACT trigger every-turn               Summarize after every tool-calling turn (debugging only; worst for prompt cache churn)
  /CoACT trigger on-context-tag           Summarize when context_checkpoint (legacy: context_tag) is called (requires pi-context extension)
  /CoACT trigger on-demand                Only summarize when /CoACT now runs
  /CoACT trigger agent-message            Summarize after the agent's final text reply (default; safest for cache stability)
  /CoACT trigger agentic-auto             LLM decides when to compress via context_prune tool
  /CoACT batching                         Show or interactively pick the batching granularity
  /CoACT batching turn                    One summary per assistant turn (default)
  /CoACT batching agent-message           One summary per user→final-agent-message span (merges all turns in a span)
  /CoACT stats                            Show cumulative summarizer token/cost stats
  /CoACT tree                             Browse compressed tool calls in a foldable tree (Ctrl-O opens selected summary)
  /CoACT now                              Flush pending tool calls immediately (shows live footer progress)
  /CoACT help                             Show this help

Agentic-auto reminder:
  When the trigger is 'agentic-auto' and remindUnprunedCount is true (default), the
  extension appends a tiny <coact-note> line to the last toolResult before each
  LLM call telling the model how many uncompressed tool calls have piled up. This
  helps the LLM decide when to call context_prune. Toggle via /CoACT settings.
  This setting has no effect in any other trigger mode.

Batching mode:
  - turn (default): each assistant turn that used tools gets its own summary block. Small, granular.
  - agent-message: all assistant turns between two consecutive user messages are merged into one summary.
    Use this when a single user request triggers many back-to-back tool rounds that belong together.

Min raw tokens (minRawTokenThreshold):
  Skip the summarizer LLM call for any batch whose raw tool-output is below this many
  TOKENS (0 = always summarize). A tiny batch's summary is almost always larger
  than the raw content, so skipping avoids wasted calls while still advancing the compression
  frontier past those turns. Steps in 50-token increments; cycle in /CoACT settings.

Mode guidance:
  - every-turn: only for debugging / testing summary behavior. Rewrites earlier context too often and can repeatedly bust provider prompt caches.
  - on-context-tag: good if you already use pi-context save-points. Compresses on explicit milestones via context_checkpoint (legacy: context_tag).
  - on-demand: maximum manual control. Best when you want to decide exactly when to trade cache stability for shorter context.
  - agent-message: recommended default. Batches a whole tool-using run, then compresses once after the final text reply so future requests become cacheable again.
  - agentic-auto: useful for longer autonomous runs, but depends on the model using context_prune sparingly.

Why this matters:
  Frequent edits to earlier context can reduce prompt/prefix cache hits on providers that cache identical prefixes. Batched compression is usually cheaper and faster than compressing every turn.

Related:
  - pi-context extension (provides context_checkpoint, legacy context_tag): https://github.com/ttttmr/pi-context
  - Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching

Settings are saved to ~/.pi/agent/context-prune/settings.json`;

// ── Pruner progress widget ────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

type RowStatus = "pending" | "running" | "done" | "skipped" | "below-threshold";

interface WidgetRow {
  label: string;
  toolCallCount: number;
  rawChars: number;
  status: RowStatus;
  receivedChars: number;
}

/**
 * Registers a multi-row progress widget above the editor for /CoACT now.
 * Returns helpers to update row state and clear the widget when done.
 * Each row shows a spinner, label, tool-call count, and live summary char count.
 */
function startPrunerWidget(
  ctx: ExtensionCommandContext,
  batches: CapturedBatch[],
): {
  updateRow: (index: number, status: RowStatus, chars?: number) => void;
  clearWidget: () => void;
} {
  const total = batches.length;
  const rows: WidgetRow[] = batches.map((b, i) => ({
    label: `Batch ${i + 1}/${total}`,
    toolCallCount: b.toolCalls.length,
    rawChars: b.toolCalls.reduce((sum, tc) => sum + tc.resultText.length, 0),
    status: "pending",
    receivedChars: 0,
  }));

  // Capture tui reference from the factory so updateRow can call requestRender.
  let requestRender: (() => void) | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;

  const hasRunningRows = () => rows.some((row) => row.status === "running");

  const stopAnimationLoop = () => {
    if (!animationTimer) return;
    clearInterval(animationTimer);
    animationTimer = undefined;
  };

  // The widget only re-renders when Pi is asked to draw again. Drive a tiny
  // timer while any row is running so the spinner advances even before the
  // summarizer streams its first text chunk.
  const ensureAnimationLoop = () => {
    if (animationTimer || !requestRender || !hasRunningRows()) return;
    animationTimer = setInterval(() => {
      if (!hasRunningRows()) {
        stopAnimationLoop();
        return;
      }
      requestRender?.();
    }, SPINNER_INTERVAL_MS);
    animationTimer.unref?.();
  };

  const syncAnimationLoop = () => {
    if (hasRunningRows()) {
      ensureAnimationLoop();
    } else {
      stopAnimationLoop();
    }
    requestRender?.();
  };

  ctx.ui.setWidget(
    PROGRESS_WIDGET_ID,
    (tui, _theme) => {
      requestRender = () => tui.requestRender();
      syncAnimationLoop();
      return {
        invalidate() {},
        render(_width: number): string[] {
          return rows.map((row) => {
            const count = `${row.toolCallCount} tool call${row.toolCallCount === 1 ? "" : "s"}`;
            if (row.status === "running") {
              const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
              const chars =
                row.receivedChars > 0
                  ? ` · ${formatCharProgress(row.receivedChars, row.rawChars)}`
                  : "";
              return `${frame} ${row.label} · ${count}${chars}`;
            } else if (row.status === "done") {
              return `✓ ${row.label} · ${count} · ${formatCharProgress(row.receivedChars, row.rawChars)}`;
            } else if (row.status === "skipped") {
              return `⚠ ${row.label} · ${count} · skipped`;
            } else if (row.status === "below-threshold") {
              return `○ ${row.label} · ${count} · below threshold`;
            } else {
              return `○ ${row.label} · ${count} · pending`;
            }
          });
        },
      };
    },
    { placement: "aboveEditor" },
  );

  return {
    updateRow(index: number, status: RowStatus, chars?: number) {
      if (index >= 0 && index < rows.length) {
        rows[index].status = status;
        if (chars !== undefined) rows[index].receivedChars = chars;
        syncAnimationLoop();
      }
    },
    clearWidget() {
      stopAnimationLoop();
      requestRender = undefined;
      ctx.ui.setWidget(PROGRESS_WIDGET_ID, undefined);
    },
  };
}

// ── Command registration ────────────────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<FlushResult>,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[],
  syncToolActivation: () => void,
  getStats: () => SummarizerStats,
  indexer: ToolCallIndexer,
): void {
  // Register the /CoACT command
  pi.registerCommand("CoACT", {
    description: "CoACT — context compression settings and commands",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      // Parse subcommand and remaining args from the raw argument string
      const parts = args.trim().split(/\s+/);
      let subcommand = parts[0] || undefined;
      const subArgs = parts.slice(1); // e.g. ["model", "anthropic/claude-haiku-3-5"] or ["on"])

      // ── Bare /CoACT → interactive picker ──
      if (!subcommand) {
        const options = SUBCOMMANDS.map((s) => s.label);
        const choice = await ctx.ui.select("CoACT — choose a subcommand", options);
        if (!choice) return;
        // Extract the value (first word) from the label like "settings — interactive settings overlay"
        subcommand = choice.split(/\s+/)[0];
      }

      switch (subcommand) {
        // ── /CoACT settings ── interactive overlay ──
        case "settings": {
          const config = currentConfig.value;
          const availableModels = ctx.modelRegistry?.getAvailable() ?? [];

          const items: SettingItem[] = [
            {
              id: "enabled",
              label: "Enabled",
              values: ["true", "false"],
              currentValue: String(config.enabled),
              description: "Enable or disable CoACT",
            },
            {
              id: "showPruneStatusLine",
              label: "CoACT status line",
              values: ["true", "false"],
              currentValue: String(config.showPruneStatusLine),
              description: pruneStatusLineDescription(config),
            },
            {
              id: "pruneOn",
              label: "Trigger mode",
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
              values: getSupportedThinkingLevels(currentConfig.value, ctx).map((l) => l.value),
              currentValue: config.summarizerThinking,
              description: summarizerThinkingDescription(config.summarizerThinking),
            },
            {
              id: "remindUnprunedCount",
              label: "Remind uncompressed count",
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
              id: "minRawTokenThreshold",
              label: "Min raw tokens",
              values: MIN_RAW_TOKEN_PRESETS.map(String),
              currentValue: String(config.minRawTokenThreshold),
              description: minRawTokenThresholdDescription(config.minRawTokenThreshold),
            },
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
            } else if (id === "minRawTokenThreshold") {
              newConfig.minRawTokenThreshold = quantizeRawTokenThreshold(Number(newValue) || 0);
              const minRawItem = items.find((item) => item.id === "minRawTokenThreshold");
              if (minRawItem) {
                minRawItem.description = minRawTokenThresholdDescription(newConfig.minRawTokenThreshold);
              }
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
              return new SettingsOverlay("CoACT settings", settingsList);
            },
            {
              overlay: true,
              overlayOptions: { width: 60 },
            },
          );
          break;
        }

        // ── /CoACT on ──
        case "on": {
          currentConfig.value = { ...currentConfig.value, enabled: true };
          saveConfig(currentConfig.value);
          ctx.ui.notify("CoACT enabled.");
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          syncToolActivation();
          break;
        }

        // ── /CoACT off ──
        case "off": {
          currentConfig.value = { ...currentConfig.value, enabled: false };
          saveConfig(currentConfig.value);
          ctx.ui.notify("CoACT disabled.");
          setPruneStatusWidget(ctx, currentConfig.value, getStats());
          syncToolActivation();
          break;
        }

        // ── /CoACT status ──
        case "status": {
          const cfg = currentConfig.value;
          const mode = PRUNE_ON_MODES.find((m) => m.value === cfg.pruneOn)?.label ?? cfg.pruneOn;
          const s = getStats();
          const statsLine = s.callCount > 0
            ? `\n  --- summarizer ---\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`
            : "\n  (no summarizer calls yet)";
          ctx.ui.notify(
            `CoACT status:\n  enabled:  ${cfg.enabled}\n  model:    ${cfg.summarizerModel}\n  thinking: ${summarizerThinkingLabel(cfg.summarizerThinking)} (${cfg.summarizerThinking})\n  trigger:  ${mode}\n  batching: ${batchingModeLabel(cfg.batchingMode)} (${cfg.batchingMode})\n  min raw:  ${cfg.minRawTokenThreshold > 0 ? `${cfg.minRawTokenThreshold} tokens` : "off"}\n  status:   ${cfg.showPruneStatusLine ? "on" : "off"}\n  remind:   ${cfg.remindUnprunedCount ? "on" : "off"} (agentic-auto only)${statsLine}`,
          );
          break;
        }

        // ── /CoACT tree ── foldable tree browser ──
        case "tree": {
          const roots = buildPruneTree(ctx, indexer);
          if (roots.length === 0) {
            ctx.ui.notify("No compressed tool calls found in this session.", "info");
            break;
          }

          await ctx.ui.custom(
            (_tui, theme, _keybindings, done) => {
              const browser = new TreeBrowser(roots, theme, () => done(undefined));
              return browser;
            },
            {
              overlay: true,
              overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" },
            },
          );
          break;
        }

        // ── /CoACT stats ──
        case "stats": {
          const s = getStats();
          if (s.callCount === 0) {
            ctx.ui.notify("CoACT stats: no summarizer calls yet.");
          } else {
            ctx.ui.notify(
              `CoACT stats:\n  calls:       ${s.callCount}\n  input:       ${formatTokens(s.totalInputTokens)} tokens\n  output:      ${formatTokens(s.totalOutputTokens)} tokens\n  cost:        ${formatCost(s.totalCost)}`,
            );
          }
          break;
        }

        // ── /CoACT model [value] ──
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

        // ── /CoACT thinking [value] ──
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

        // ── /CoACT trigger [value] ──
        case "trigger": {
          const modeArg = subArgs[0];
          if (!modeArg) {
            const options = PRUNE_ON_MODES.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("CoACT — choose when to trigger summarization", options);
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

        // ── /CoACT batching [value] ──
        case "batching": {
          const batchArg = subArgs[0];
          if (!batchArg) {
            const options = BATCHING_MODES.map((m) => `${m.value} — ${m.label}`);
            const choice = await ctx.ui.select("CoACT — choose batching granularity", options);
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

        // ── /CoACT now ──
        case "now": {
          if (!currentConfig.value.enabled) {
            ctx.ui.notify("CoACT is disabled. Run /CoACT on first.", "warning");
            return;
          }

          // Capture the pending queue first so we can pre-build the widget rows.
          const batches = capturePendingBatches(ctx);
          if (batches.length === 0) {
            ctx.ui.notify("CoACT: nothing pending — no batches to summarize", "info");
            break;
          }

          // Open the progress widget above the editor — one row per batch.
          const { updateRow, clearWidget } = startPrunerWidget(ctx, batches);

          const result = await flushPending(ctx, {
            previewedBatches: batches,
            onProgress: (index, _total, _batch, stage) => {
              if (stage === "start") {
                updateRow(index, "running", 0);
              } else if (stage === "done") {
                updateRow(index, "done");
              } else if (stage === "below-threshold") {
                updateRow(index, "below-threshold");
              } else {
                updateRow(index, "skipped");
              }
            },
            onBatchTextProgress: (index, _total, _batch, receivedChars) => {
              updateRow(index, "running", receivedChars);
            },
          });

          // Remove the widget and restore the normal footer status.
          clearWidget();
          setPruneStatusWidget(ctx, currentConfig.value, getStats());

          if (!result.ok) {
            const suffix = "error" in result && result.error ? ` (${result.error})` : "";
            ctx.ui.notify(`CoACT: nothing flushed — ${result.reason}${suffix}`, result.reason === "empty" ? "info" : "warning");
            break;
          }

          if (result.reason === "skipped-below-threshold") {
            ctx.ui.notify(
              `CoACT: skipped ${result.belowThresholdBatchCount} batch${result.belowThresholdBatchCount === 1 ? "" : "es"} (${result.belowThresholdToolCallCount} tool call${result.belowThresholdToolCallCount === 1 ? "" : "s"}, ${result.rawCharCount} raw chars) — below minRawTokenThreshold (${currentConfig.value.minRawTokenThreshold} tokens); frontier advanced past this range`,
              "info"
            );
            break;
          }

          if (result.reason === "skipped-oversized" || result.reason === "skipped-mixed") {
            const oversizeLine = `CoACT: skipped ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} — summary was ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars; frontier advanced past this range`;
            if (result.reason === "skipped-mixed" && result.belowThresholdBatchCount > 0) {
              ctx.ui.notify(
                `${oversizeLine}\n(${result.belowThresholdBatchCount} batch${result.belowThresholdBatchCount === 1 ? "" : "es"} also skipped — below minRawTokenThreshold)`,
                "warning"
              );
            } else {
              ctx.ui.notify(oversizeLine, "warning");
            }
            break;
          }

          ctx.ui.notify(
            `CoACT: compressed ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"} — summary ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars`,
            "info"
          );
          break;
        }

        // ── /CoACT help ──
        case "help":
          ctx.ui.notify(HELP_TEXT);
          break;

        // ── Unknown subcommand ──
        default:
          ctx.ui.notify(
            `Unknown subcommand: "${subcommand}". Run /CoACT help for usage.`,
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
    const header = theme.fg("accent", `[CoACT] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`);
    if (expanded) {
      return new Text(header + "\n" + unwrapSummaryForDisplay(message.content), 0, 0);
    }
    return new Text(header, 0, 0);
  });
}