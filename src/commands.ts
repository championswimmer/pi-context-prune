import {
  type ContextPruneConfig,
  type SummarizerStats,
  PRUNE_ON_MODES,
  STATUS_WIDGET_ID,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { saveConfig } from "./config.js";
import { formatTokens, formatCost } from "./stats.js";
import { Container, type Component, Text, SettingsList, type SettingItem } from "@mariozechner/pi-tui";
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
  { value: "status",  label: "status   — show status, model, and prune trigger" },
  { value: "model",   label: "model    — show or set the summarizer model" },
  { value: "prune-on", label: "prune-on — show or set the trigger mode" },
  { value: "stats",   label: "stats    — show cumulative summarizer token/cost stats" },
  { value: "tree",    label: "tree     — browse pruned tool calls in a foldable tree" },
  { value: "now",     label: "now      — flush pending tool calls immediately" },
  { value: "help",    label: "help     — show this help" },
] as const;

// ── Help text ───────────────────────────────────────────────────────────────

const HELP_TEXT = `pruner — automatically summarizes tool-call outputs to keep context lean.

Usage:
  /pruner settings                        Interactive settings overlay
  /pruner on                               Enable context pruning
  /pruner off                              Disable context pruning
  /pruner status                           Show status, model, prune trigger, and stats
  /pruner model                            Show the current summarizer model
  /pruner model <id>                       Set summarizer model (e.g. anthropic/claude-haiku-3-5)
  /pruner prune-on                         Show or interactively pick the trigger
  /pruner prune-on every-turn              Summarize after every tool-calling turn (default)
  /pruner prune-on on-context-tag          Summarize when context_tag is called
  /pruner prune-on on-demand               Only summarize when /pruner now runs
  /pruner prune-on agent-message           Summarize when the agent sends a final text response
  /pruner prune-on agentic-auto            LLM decides when to prune via context_prune tool
  /pruner stats                            Show cumulative summarizer token/cost stats
  /pruner tree                             Browse pruned tool calls in a foldable tree
  /pruner now                              Flush pending tool calls immediately
  /pruner help                             Show this help

Settings are saved to ~/.pi/agent/context-prune/settings.json`;

// ── Command registration ────────────────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: (ctx: ExtensionCommandContext) => void,
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
              description: "When to summarize tool outputs",
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
          ];

          const onChange = (id: string, newValue: string) => {
            const newConfig = { ...currentConfig.value };
            if (id === "enabled") {
              newConfig.enabled = newValue === "true";
            } else if (id === "pruneOn") {
              newConfig.pruneOn = newValue as ContextPruneConfig["pruneOn"];
            } else if (id === "summarizerModel") {
              newConfig.summarizerModel = newValue;
            }
            currentConfig.value = newConfig;
            saveConfig(newConfig);
            ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(newConfig, getStats()));
            // Toggle context_prune tool activation when config changes
            syncToolActivation();
          };

          const settingsList = new SettingsList(
            items,
            10,
            getSettingsListTheme(),
            onChange,
            () => {}, // onCancel — just close the overlay
            { enableSearch: false },
          );

          // Use ctx.ui.custom() to show the settings list as an overlay.
          // The factory receives (tui, theme, keybindings, done) and returns a Component.
          // When done() is called (by pressing Escape via SettingsList's onCancel),
          // the custom UI closes and the promise resolves.
          await ctx.ui.custom(
            (_tui, _theme, _keybindings, done) => {
              // Wrap onCancel to call done() so the custom UI closes when Escape is pressed
              const originalOnCancel = settingsList.onCancel;
              settingsList.onCancel = () => {
                originalOnCancel();
                done(undefined);
              };

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
            `pruner status:\n  enabled: ${cfg.enabled}\n  model:   ${cfg.summarizerModel}\n  trigger: ${mode}${statsLine}`,
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
            ctx.ui.notify(`Current summarizer model: ${currentConfig.value.summarizerModel}`);
          } else {
            currentConfig.value = { ...currentConfig.value, summarizerModel: modelArg };
            saveConfig(currentConfig.value);
            ctx.ui.notify(`Summarizer model set to: ${modelArg}`);
          }
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
          flushPending(ctx);
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