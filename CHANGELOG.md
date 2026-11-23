# Changelog

## 3.1.0

### Changed
- Switched packaging from an `esbuild` single-file bundle to compiled ESM JavaScript and TypeScript declarations (`.js` + `.d.ts` + source/declaration maps) emitted by `tsc` into `dist/`.
- Added `types` and conditional `exports` in `package.json`, moved `pi-extension-settings-tui` to runtime `dependencies`, and declared `typebox` in `peerDependencies`.
- Updated `scripts/test-usage.mjs`, `scripts/test-status.mjs`, and `scripts/check-package.mjs` to verify and run against the compiled `dist/` output without `esbuild`.

## 3.0.0

### Breaking Changes
- **Minimum Pi version**: Requires `@earendil-works/pi-coding-agent >= 1.5.0`.
- **Unified `summarizerModel` format**: Replaced separate string `summarizerModel` and `summarizerThinking` keys with a unified `summarizerModel` object (`{ model, thinkingLevel } | null`). Existing v2.x settings files are automatically migrated in place on startup (removing `summarizerThinking` and mapping legacy `"default"` thinking to `"off"` when paired with an explicit model).

### Added
- Declarative TUI settings dialog powered by `pi-extension-settings-tui` with `General`, `Summarizer`, and `Display` tabs, provenance indicators, and Restore defaults.
- Global (`~/.pi/agent/context-prune/settings.json`) and trust-gated Project (`<cwd>/.pi/context-prune/settings.json`) scopes with scope switching.
- Unified 2-step Scoped/All fuzzy model + thinking picker for selecting a summarizer model.
- Fullscreen mouse support and automatic RPC fallback for `/pruner settings`.
- `notifySkipped` toggle in the `Display` tab.
- `max` thinking level support (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

### Changed
- Override-only hardened JSON persistence (`0o700`/`0o600` atomic writes, symlink/size/secret-key guards, optimistic concurrency) via `pi-extension-settings-tui`.

## 2.2.0

### Added
- Three footer display modes in `/pruner settings`: Hidden, Status only, and Status + cost (input/output tokens and dollars).
- Experimental **[labs] Use Nerd Font icon** setting for scissors and turn-count icons. Disabled by default; requires a Nerd Font in the terminal.

### Changed
- Replace the text footer prefix with a scissors icon and use a turn icon for pending counts in both the footer and queued notices.
- Keep optional cumulative token/cost details visible during pending and summarizing states.
- Preserve existing footer visibility settings and default to standard Unicode icons (`✂`, `↻`).

Implementation: [af4321f](https://github.com/championswimmer/pi-context-prune/commit/af4321f). These changes landed directly on main; the follow-up changelog PR records them without rewriting history.

### Verification
- Build and package validation pass.
- All 14 regression tests pass, including display modes, Unicode/Nerd Font icons, and backward-compatible settings persistence.
