---
name: planning
description: Create and execute phased implementation plans stored in .agents/plans using numbered markdown files with YAML front matter and checklist steps.
---

# Planning

Use this skill whenever work should be organized into explicit phases and tracked as a plan file.

## Plan location

- Store all plans in `.agents/plans/`.
- Use numbered, zero-padded filenames in order, such as:
  - `000-first-plan.md`
  - `001-another-plan.md`
  - `002-plan-more.md`
- Keep the number stable once a plan exists. Do not renumber old plans.
- Choose the next available number by scanning existing plan files.

## Plan format

Every plan must be a Markdown file with YAML front matter containing:

- `name`
- `description`
- `steps`

`steps` must be a YAML array that represents phases. Each phase should contain a phase name and a checklist of steps.

Recommended structure:

```yaml
---
name: 000-first-plan
description: Build the pruning extension skeleton.
steps:
  - phase: discovery
    steps:
      - "- [ ] step 1: inspect the repo structure"
      - "- [ ] step 2: identify the extension entry points"
  - phase: implementation
    steps:
      - "- [ ] step 1: implement the pruning logic"
      - "- [ ] step 2: wire the pruning into context preparation"
  - phase: validation
    steps:
      - "- [ ] step 1: add or update tests"
      - "- [ ] step 2: verify the final behavior"
---
```

## Body format

The Markdown body should mirror the phased structure for readability.
Keep the body and front matter aligned so the plan stays easy to execute.

```md
# 000-first-plan

## Phase 1 — Discovery
- [ ] step 1: inspect the repo structure
- [ ] step 2: identify the extension entry points

## Phase 2 — Implementation
- [ ] step 1: implement the pruning logic
- [ ] step 2: wire the pruning into context preparation

## Phase 3 — Validation
- [ ] step 1: add or update tests
- [ ] step 2: verify the final behavior
```

## How to make a plan

1. Inspect the current repo state.
2. Define the outcome in one sentence.
3. Split the work into phases.
4. Break each phase into small checklist items.
5. Save the plan as a numbered Markdown file in `.agents/plans/`.
6. Keep checklist items concrete and actionable.

## How to execute a plan

1. Read the entire plan before making changes.
2. Work through one phase at a time.
3. Complete checklist items in order.
4. Mark finished items with `- [x]` in both the body and the front matter if the plan is being kept in sync there.
5. If scope changes, update the current plan before continuing.
6. Do not move to the next phase until the current phase is done.
7. After implementation, verify the result and leave the plan updated.

## Rules

- Use checklist syntax for each step: `- [ ] step 1: ...` when open, `- [x] step 1: ...` when complete.
- Keep phases distinct; do not mix steps from different phases in the same block.
- Prefer short, atomic steps that can be completed and checked off independently.
- If a task is too large, add another phase instead of making a giant step.
- Keep the front matter and the visible Markdown body aligned.
