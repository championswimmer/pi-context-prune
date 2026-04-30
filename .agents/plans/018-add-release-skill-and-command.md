---
name: 018-add-release-skill-and-command
description: Add a reusable Pi release skill plus a /release prompt template that performs semver bumps, tagging, pushing, and tag-driven npm publishing for this package.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect the current package manifest and release workflow"
      - "- [x] step 2: confirm how Pi skills and prompt templates are discovered in packages"
      - "- [x] step 3: design a repo-safe release workflow that matches /release major|minor|patch"
  - phase: implementation
    steps:
      - "- [x] step 1: add a release skill with repo-specific release instructions"
      - "- [x] step 2: add a helper script that automates the version bump, git tag, and pushes"
      - "- [x] step 3: add a /release prompt template wired to the skill"
      - "- [x] step 4: update package.json so the skill and prompt are loaded from the package"
  - phase: validation
    steps:
      - "- [x] step 1: run safe validation for the helper script and confirm the manifest changes"
      - "- [x] step 2: review the diff for correctness and keep the plan in sync"
---

# 018-add-release-skill-and-command

## Phase 1 — Discovery
- [x] step 1: inspect the current package manifest and release workflow
- [x] step 2: confirm how Pi skills and prompt templates are discovered in packages
- [x] step 3: design a repo-safe release workflow that matches /release major|minor|patch

## Phase 2 — Implementation
- [x] step 1: add a release skill with repo-specific release instructions
- [x] step 2: add a helper script that automates the version bump, git tag, and pushes
- [x] step 3: add a /release prompt template wired to the skill
- [x] step 4: update package.json so the skill and prompt are loaded from the package

## Phase 3 — Validation
- [x] step 1: run safe validation for the helper script and confirm the manifest changes
- [x] step 2: review the diff for correctness and keep the plan in sync
