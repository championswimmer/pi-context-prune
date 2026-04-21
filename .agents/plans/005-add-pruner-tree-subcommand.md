---
name: 005-add-pruner-tree-subcommand
description: Add a /pruner tree subcommand that opens a foldable tree browser showing all pruned tool calls grouped under their prune summaries, styled like Pi's internal context tree.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: understand Pi's TUI Component interface and overlay system"
      - "- [x] step 2: review how session entries store summary and index data"
      - "- [x] step 3: identify theme colors and rendering patterns used in the extension"
  - phase: implementation
    steps:
      - "- [x] step 4: create src/tree-browser.ts with a foldable TreeBrowser Component"
      - "- [x] step 5: add tree data builder that scans session branch for summaries and correlates with indexer records"
      - "- [x] step 6: add /pruner tree subcommand to commands.ts with overlay integration"
      - "- [x] step 7: update SUBCOMMANDS, help text, and argument completions"
      - "- [x] step 8: wire tree browser into index.ts (pass indexer to registerCommands)"
  - phase: validation
    steps:
      - "- [ ] step 9: run TypeScript type check (no local tsc available; code reviewed manually)"
      - "- [x] step 10: verify /pruner help shows the new tree subcommand"
      - "- [ ] step 11: verify /pruner tree opens the overlay (manual test)"
---

# 005-add-pruner-tree-subcommand

## Phase 1 — Discovery

- [x] step 1: understand Pi's TUI Component interface and overlay system
- [x] step 2: review how session entries store summary and index data
- [x] step 3: identify theme colors and rendering patterns used in the extension

## Phase 2 — Implementation

- [x] step 4: create src/tree-browser.ts with a foldable TreeBrowser Component
- [x] step 5: add tree data builder that scans session branch for summaries and correlates with indexer records
- [x] step 6: add /pruner tree subcommand to commands.ts with overlay integration
- [x] step 7: update SUBCOMMANDS, help text, and argument completions
- [x] step 8: wire tree browser into index.ts (pass indexer to registerCommands)

## Phase 3 — Validation

- [ ] step 9: run TypeScript type check (no local tsc available; code reviewed manually)
- [x] step 10: verify /pruner help shows the new tree subcommand
- [ ] step 11: verify /pruner tree opens the overlay (manual test)

---

## Design Notes

### Tree Browser Component

The `TreeBrowser` implements the `Component` interface from `@mariozechner/pi-tui`:
- **Navigation**: ↑/↓ moves selection, Space/Enter toggles expand/collapse, q/Esc closes
- **Visual style**: Indentation per depth level, `▸` for collapsed nodes, `▾` for expanded nodes
- **Colors**: Summary nodes use `accent`, tool call nodes use `text`, selected row uses `selectedBg` via `theme.bg`
- **Structure**: Each prune summary is a parent node; its pruned tool calls are child nodes

### Data Model

```
TreeNode {
  id: string
  label: string
  children: TreeNode[]
  expanded: boolean
  depth: number
  isLeaf: boolean
  details?: { toolName, args, resultTextPreview }
}
```

### Data Collection

1. Scan `ctx.sessionManager.getBranch()` for entries with `customType === CUSTOM_TYPE_SUMMARY`
2. For each summary entry, read `details.toolCallIds`
3. Look up each `toolCallId` in the `ToolCallIndexer` to get full `ToolCallRecord`
4. Build `TreeNode` hierarchy: one parent per summary, children per tool call

### Why use the indexer instead of scanning index entries directly?

The indexer already maintains a `Map<toolCallId, ToolCallRecord>` reconstructed from session entries. Reusing it avoids duplicating the correlation logic and ensures consistency with `context_tree_query`.

### Files to modify

1. **`src/tree-browser.ts`** — New file: `TreeBrowser` component + `buildPruneTree` data builder
2. **`src/commands.ts`** — Add `tree` case to switch, update `SUBCOMMANDS` and `HELP_TEXT`
3. **`index.ts`** — Pass `indexer` to `registerCommands`
