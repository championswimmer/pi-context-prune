import type { Component } from "@earendil-works/pi-tui";
import { Markdown, getKeybindings, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";
import { normalizeSummaryToolCallRefs, unwrapSummaryForDisplay } from "./summary-refs.js";
import type { ToolCallIndexer } from "./indexer.js";

// ── Tree node types ─────────────────────────────────────────────────────────

export interface TreeNode {
  id: string;
  label: string;
  children: TreeNode[];
  expanded: boolean;
  depth: number;
  isLeaf: boolean;
  /** Optional extra detail shown when expanded (e.g. result preview) */
  detail?: string;
  /** Character count of this node's content (result text for tools, summary text for summaries) */
  charCount?: number;
}

interface VisibleRow {
  node: TreeNode;
  index: number;
}

interface SummaryOverlayState {
  title: string;
  text: string;
  scrollOffset: number;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function padToWidth(str: string, width: number): string {
  const vis = visibleWidth(str);
  if (vis >= width) return str;
  return str + " ".repeat(width - vis);
}

function isCtrlO(data: string): boolean {
  return matchesKey(data, "ctrl+o") || data === "\u000f";
}

// ── Box drawing ─────────────────────────────────────────────────────────────

function boxLines(
  lines: string[],
  width: number,
  title: string,
  theme: Theme,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const result: string[] = [];

  // Top border with title
  const titlePrefix = title ? `─ ${title} ` : "";
  const titleVis = visibleWidth(titlePrefix);
  const topFill = "─".repeat(Math.max(0, innerWidth - titleVis));
  result.push("┌" + titlePrefix + topFill + "┐");

  // Content lines
  for (const line of lines) {
    result.push("│" + padToWidth(line, innerWidth) + "│");
  }

  // Bottom border
  result.push("└" + "─".repeat(innerWidth) + "┘");

  return result;
}

// ── Tree data builder ───────────────────────────────────────────────────────

/**
 * Scans the current session branch for prune-summary entries and builds a
 * foldable tree where each summary is a parent node and its pruned tool calls
 * are children.  Tool call records are looked up via the indexer.
 *
 * Each node carries a `charCount` so the UI can show how many characters the
 * summary replaced (making it obvious whether pruning is saving space).
 */
export function buildPruneTree(
  ctx: ExtensionCommandContext,
  indexer: ToolCallIndexer,
): TreeNode[] {
  const branch = ctx.sessionManager.getBranch();
  const roots: TreeNode[] = [];
  let summaryIndex = 0;

  for (const entry of branch) {
    if (entry.type !== "custom_message") continue;
    const customEntry = entry as any;
    if (customEntry.customType !== CUSTOM_TYPE_SUMMARY) continue;

    const details = customEntry.details as {
      toolCallRefs?: { shortId: string; toolCallId: string }[];
      toolCallIds?: string[];
      toolNames: string[];
      turnIndex: number;
      timestamp: number;
    } | undefined;

    const toolCallRefs = normalizeSummaryToolCallRefs(details);
    const turnIndex = details?.turnIndex ?? "?";
    const timestamp = details?.timestamp
      ? new Date(details.timestamp).toLocaleString()
      : "";

    const children: TreeNode[] = [];
    for (const ref of toolCallRefs) {
      const record = indexer.getRecord(ref.toolCallId);
      if (!record) continue;
      children.push(toolCallNode(record, 1));
    }

    const storedSummaryText =
      typeof customEntry.content === "string" ? customEntry.content : "";
    const summaryText = unwrapSummaryForDisplay(storedSummaryText);
    const summaryChars = summaryText.length;
    const totalOriginalChars = children.reduce(
      (sum, c) => sum + (c.charCount ?? 0),
      0,
    );

    const header = `[pruner] Turn ${turnIndex} summary (${children.length} tool${children.length === 1 ? "" : "s"} · ${formatChars(summaryChars)} chars · original ${formatChars(totalOriginalChars)})`;
    const label = timestamp ? `${header} · ${timestamp}` : header;

    roots.push({
      id: `summary-${summaryIndex++}`,
      label,
      children,
      expanded: false,
      depth: 0,
      isLeaf: children.length === 0,
      detail: summaryText || undefined,
      charCount: summaryChars,
    });
  }

  return roots;
}

function toolCallNode(record: ToolCallRecord, depth: number): TreeNode {
  const argsText = Object.entries(record.args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  const charCount = record.resultText.length;
  const label = `${record.toolName}(${argsText}) · ${formatChars(charCount)} chars${record.isError ? " [error]" : ""}`;
  const resultPreview = record.resultText.slice(0, 200).replace(/\s+/g, " ");
  return {
    id: record.toolCallId,
    label,
    children: [],
    expanded: false,
    depth,
    isLeaf: true,
    detail: resultPreview,
    charCount,
  };
}

// ── TreeBrowser component ───────────────────────────────────────────────────

export class TreeBrowser implements Component {
  private flatRows: VisibleRow[] = [];
  private selectedIndex = 0;
  private theme: Theme;
  private onDone: () => void;
  private summaryOverlay: SummaryOverlayState | null = null;

  constructor(
    private readonly roots: TreeNode[],
    theme: Theme,
    onDone: () => void,
  ) {
    this.theme = theme;
    this.onDone = onDone;
    this.rebuildFlatRows();
  }

  invalidate(): void {
    this.rebuildFlatRows();
  }

  private rebuildFlatRows(): void {
    this.flatRows = [];
    let index = 0;
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        this.flatRows.push({ node, index: index++ });
        if (node.expanded && node.children.length > 0) {
          walk(node.children);
        }
      }
    };
    walk(this.roots);
    if (this.selectedIndex >= this.flatRows.length) {
      this.selectedIndex = Math.max(0, this.flatRows.length - 1);
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (this.summaryOverlay) {
      if (kb.matches(data, "tui.select.up")) {
        this.summaryOverlay.scrollOffset = Math.max(0, this.summaryOverlay.scrollOffset - 1);
      } else if (kb.matches(data, "tui.select.down")) {
        this.summaryOverlay.scrollOffset += 1;
      } else if (kb.matches(data, "tui.select.cancel") || data === "q" || isCtrlO(data)) {
        this.summaryOverlay = null;
      }
      return;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.flatRows.length - 1
          : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === this.flatRows.length - 1
          ? 0
          : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      const row = this.flatRows[this.selectedIndex];
      if (row && !row.node.isLeaf) {
        row.node.expanded = !row.node.expanded;
        this.rebuildFlatRows();
      }
    } else if (isCtrlO(data)) {
      this.openSelectedSummary();
    } else if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onDone();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);

    let baseLines: string[];
    if (this.flatRows.length === 0) {
      const msg = this.theme.fg("muted", "(no pruned tool calls in this session)");
      baseLines = boxLines([msg], width, "Pruned Tool Calls", this.theme);
    } else {
      const contentLines: string[] = [
        this.theme.fg("dim", "Enter/Space expand • Ctrl-O open summary • Esc/q close"),
        "",
      ];
      for (let i = 0; i < this.flatRows.length; i++) {
        const row = this.flatRows[i];
        const line = this.renderRow(row.node, innerWidth, i === this.selectedIndex);
        contentLines.push(line);
      }

      baseLines = boxLines(contentLines, width, "Pruned Tool Calls", this.theme);
    }

    if (!this.summaryOverlay) {
      return baseLines;
    }

    return this.renderWithSummaryOverlay(baseLines, width);
  }

  private openSelectedSummary(): void {
    const row = this.flatRows[this.selectedIndex];
    if (!row || row.node.isLeaf || !row.node.detail) {
      return;
    }

    this.summaryOverlay = {
      title: row.node.label,
      text: row.node.detail,
      scrollOffset: 0,
    };
  }

  private renderWithSummaryOverlay(baseLines: string[], width: number): string[] {
    const overlay = this.summaryOverlay;
    if (!overlay) return baseLines;

    const overlayWidth = Math.max(60, width - 2);
    const overlayInnerWidth = Math.max(1, overlayWidth - 2);
    const markdown = new Markdown(overlay.text, 1, 0, getMarkdownTheme());
    const markdownLines = markdown.render(Math.max(1, overlayInnerWidth));
    const reservedLines = 5;
    const maxContentHeight = Math.max(12, Math.min(markdownLines.length, baseLines.length + 8));
    const maxScroll = Math.max(0, markdownLines.length - maxContentHeight);
    overlay.scrollOffset = Math.min(overlay.scrollOffset, maxScroll);

    const visibleContent = markdownLines.slice(
      overlay.scrollOffset,
      overlay.scrollOffset + maxContentHeight,
    );

    const footer = this.theme.fg(
      "dim",
      `↑/↓ scroll • Ctrl-O/Esc/q close${maxScroll > 0 ? ` • ${overlay.scrollOffset + 1}-${Math.min(overlay.scrollOffset + maxContentHeight, markdownLines.length)} / ${markdownLines.length}` : ""}`,
    );
    const overlayLines = boxLines(
      [
        this.theme.fg("accent", truncateToWidth(overlay.title, overlayInnerWidth, "…", false)),
        this.theme.fg("dim", "Pruned summary message"),
        "",
        ...visibleContent,
        "",
        footer,
      ],
      overlayWidth,
      "Pruned Summary",
      this.theme,
    );

    const canvasHeight = Math.max(baseLines.length, overlayLines.length + 2);
    const blankLine = " ".repeat(width);
    const composed = Array.from({ length: canvasHeight }, (_, index) => baseLines[index] ?? blankLine);
    const startRow = Math.max(0, Math.floor((canvasHeight - overlayLines.length) / 2));
    const leftPad = Math.max(0, Math.floor((width - overlayWidth) / 2));
    const rightPad = Math.max(0, width - leftPad - overlayWidth);

    for (let i = 0; i < overlayLines.length && startRow + i < composed.length; i++) {
      composed[startRow + i] = " ".repeat(leftPad) + overlayLines[i] + " ".repeat(rightPad);
    }

    return composed;
  }

  private renderRow(
    node: TreeNode,
    width: number,
    isSelected: boolean,
  ): string {
    const indent = "  ".repeat(node.depth);
    const prefix = node.isLeaf
      ? "  "
      : node.expanded
        ? "▾ "
        : "▸ ";

    let text: string;
    if (node.isLeaf) {
      text = this.theme.fg("text", node.label);
    } else {
      text = this.theme.fg("accent", node.label);
    }

    const fullLine = indent + prefix + text;
    const plainText = indent + prefix + node.label;
    const visibleLen = visibleWidth(plainText);

    let rendered: string;
    if (visibleLen > width) {
      rendered = truncateToWidth(fullLine, width, "…", false);
    } else {
      rendered = fullLine;
    }

    if (isSelected) {
      const padLen = width - visibleWidth(rendered);
      if (padLen > 0) {
        rendered += " ".repeat(padLen);
      }
      rendered = this.theme.bg("selectedBg", rendered);
    }

    return rendered;
  }
}
