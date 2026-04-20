# Project Guidance

This repository is for a Pi coding-agent extension that prunes tool-call trees before the next request is sent.

## Working style
- Keep changes small, focused, and reversible.
- Read existing files before editing them.
- Preserve user work; do not overwrite unrelated changes.
- Prefer Markdown for plans and notes, and keep code and docs aligned.

## Planning
- Use the `planning` skill for any multi-step task.
- Store plans in `.agents/plans/`.
- Use zero-padded numbered plan filenames like `000-first-plan.md`, `001-another-plan.md`, and `002-plan-more.md`.
- Keep plan checklists in sync with actual progress.

## Implementation
- When adding code, include a brief explanation of why the change exists.
- Add tests or a reproducible verification command for behavior changes when possible.
