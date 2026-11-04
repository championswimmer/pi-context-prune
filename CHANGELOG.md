# Changelog

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
