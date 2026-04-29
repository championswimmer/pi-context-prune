import {
  type ContextPruneConfig,
  type SummarizerStats,
  PRUNE_ON_MODES,
  STATUS_WIDGET_ID,
  SUMMARIZER_THINKING_LEVELS,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { saveConfig } from "./config.js";
import { formatTokens, formatCost } from "./stats.js";
import { Container, Text, SettingsList, type SettingItem } from "@mariozechner/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { buildPruneTree, TreeBrowser } from "./tree-browser.js";
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
  let text = `prune: ${config.enabled ? "ON" : "OFF"} (${mode})`;
  if (stats && stats.callCount > 0) {
    text += ` │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
  }
  return text;
}

// ── Subcommand list (for completions & interactive picker) ──────────────────

const SUBCOMMANDS = [
  { value: "settings", label: "settings — interactive settings overlay" },
  { value: "on",       label: "on       — enable context pruning" },
  { value: "off",      label: "off      — disable context pruning" },
  { value: "status",  label: "status   — show status, model, thinking, and prune trigger" },
  { value: "model",   label: "model    — show or set the summarizer model" },
  { value: "thinking", label: "thinking — show or set the summarizer thinking level" },
  { value: "prune-on", label: "prune-on — show or set the trigger mode" },
  { value: "stats",   label: "stats    — show cumulative summarizer token/cost stats" },
  { value: "tree",    label: "tree     — browse pruned tool calls in a foldable tree" },
  { value: "now",     label: "now      — flush pending tool calls immediately" },
  { value: "help",    label: "help     — show this help" },
] as const;

// ── Help text ───────────────────────────────────────────────────────────────

const PRUNE_MODE_GUIDANCE: Record<ContextPruneConfig["pruneOn"], string> = {
  "every-turn": "Debugging only. Prunes after every tool turn, which is easiest to inspect but churns provider prompt caches the most.",
  "on-context-tag": "Good for milestone-based workflows. Flushes when context_tag is called; requires the pi-context extension for automatic triggering.",
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

const HELP_TEXT = `pruner — automatically summarizes tool-call outputs to keep context lean.

Usage:
  /pruner settings                         Interactive settings overlay
  /pruner on                               Enable context pruning
  /pruner off                              Disable context pruning
  /pruner status                           Show status, model, prune trigger, and stats
  /pruner model                            Show the current summarizer model
  /pruner model <id>                       Set summarizer model (e.g. anthropic/claude-haiku-3-5)
  /pruner model <id>:<thinking>            Set summarizer model and thinking together (e.g. openai/gpt-5-mini:low)
  /pruner thinking                         Show the current summarizer thinking level
  /pruner thinking <level>                 Set summarizer thinking: default, off, minimal, low, medium, high, xhigh
  /pruner prune-on                         Show or interactively pick the trigger
  /pruner prune-on every-turn              Summarize after every tool-calling turn (debugging only; worst for prompt cache churn)
  /pruner prune-on on-context-tag          Summarize when context_tag is called (requires pi-context extension)
  /pruner prune-on on-demand               Only summarize when /pruner now runs
  /pruner prune-on agent-message           Summarize after the agent's final text reply (default; safest for cache stability)
  /pruner prune-on agentic-auto            LLM decides when to prune via context_prune tool
  /pruner stats                            Show cumulative summarizer token/cost stats
  /pruner tree                             Browse pruned tool calls in a foldable tree (Ctrl-O opens selected summary)
  /pruner now                              Flush pending tool calls immediately
  /pruner help                             Show this help

Mode guidance:
  - every-turn: only for debugging / testing summary behavior. Rewrites earlier context too often and can repeatedly bust provider prompt caches.
  - on-context-tag: good if you already use pi-context save-points. Prunes on explicit milestones via context_tag.
  - on-demand: maximum manual control. Best when you want to decide exactly when to trade cache stability for shorter context.
  - agent-message: recommended default. Batches a whole tool-using run, then prunes once after the final text reply so future requests become cacheable again.
  - agentic-auto: useful for longer autonomous runs, but depends on the model using context_prune sparingly.

Why this matters:
  Frequent edits to earlier context can reduce prompt/prefix cache hits on providers that cache identical prefixes. Batched pruning is usually cheaper and faster than pruning every turn.

Related:
  - pi-context extension (provides context_tag): https://github.com/ttttmr/pi-context
  - Anthropic prompt caching docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching

Settings are saved to ~/.pi/agent/context-prune/settings.json`;

// ── Command registration ────────────────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext) => Promise<{ ok: boolean; reason: string; error?: string }>,
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
          ];

          let settingsList: SettingsList;
          let closeSettingsOverlay = () => {};

          const onChange = (id: string, newValue: string) => {
            const newConfig = { ...currentConfig.value };
            if (id === "enabled") {
              newConfig.enabled = newValue === "true";
            } else if (id === "pruneOn") {
              newConfig.pruneOn = newValue as ContextPruneConfig["pruneOn"];
              const pruneTriggerItem = items.find((item) => item.id === "pruneOn");
              if (pruneTriggerItem) {
                pruneTriggerItem.description = pruneTriggerDescription(newConfig.pruneOn);
              }
            } else if (id === "summarizerModel") {
              newConfig.summarizerModel = newValue;
            } else if (id === "summarizerThinking") {
              newConfig.summarizerThinking = newValue as ContextPruneConfig["summarizerThinking"];
              const thinkingItem = items.find((item) => item.id === "summarizerThinking");
              if (thinkingItem) {
                thinkingItem.description = summarizerThinkingDescription(newConfig.summarizerThinking);
              }
            }
            currentConfig.value = newConfig;
            saveConfig(newConfig);
            ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(newConfig, getStats()));
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
          ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value, getStats()));
          syncToolActivation();
          break;
        }

        // ── /pruner off ──
        case "off": {
          currentConfig.value = { ...currentConfig.value, enabled: false };
          saveConfig(currentConfig.value);
          ctx.ui.notify("Context pruning disabled.");
          ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value, getStats()));
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
            `pruner status:\n  enabled:  ${cfg.enabled}\n  model:    ${cfg.summarizerModel}\n  thinking: ${summarizerThinkingLabel(cfg.summarizerThinking)} (${cfg.summarizerThinking})\n  trigger:  ${mode}${statsLine}`,
          );
          break;
        }

        // ── /pruner tree ── foldable tree browser ──
        case "tree": {
          const roots = buildPruneTree(ctx, indexer);
          if (roots.length === 0) {
            ctx.ui.notify("No pruned tool calls found in this session.", "info");
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
          ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value, getStats()));
          syncToolActivation();
          break;
        }

        // ── /pruner now ──
        case "now": {
          if (!currentConfig.value.enabled) {
            ctx.ui.notify("Context pruning is disabled. Run /pruner on first.", "warning");
            return;
          }
          const result = await flushPending(ctx);
          if (!result.ok) {
            const suffix = result.error ? ` (${result.error})` : "";
            ctx.ui.notify(`pruner: nothing flushed — ${result.reason}${suffix}`, result.reason === "empty" ? "info" : "warning");
          }
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
    const details = message.details as { turnIndex: number; toolCallIds: string[]; toolNames: string[] };
    const turnIndex = details?.turnIndex ?? "?";
    const toolCount = details?.toolCallIds?.length ?? 0;
    const header = theme.fg("accent", `[pruner] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`);
    if (expanded) {
      return new Text(header + "\n" + message.content, 0, 0);
    }
    return new Text(header, 0, 0);
  });
}