---
name: release
description: Creates a repository release for this Pi package. Use when the user asks to do a major, minor, or patch release, bump the package version, create and push a git tag, and publish to npm through the repo's tag-driven GitHub Actions workflow.
---

# Release

Use this skill when asked to release this package, especially through `/release major`, `/release minor`, or `/release patch`.

## Repository-specific release model

This repository already publishes to npm from GitHub Actions.

- Workflow: `.github/workflows/release.yml`
- Trigger: pushing a semver tag like `v1.2.3`
- Publish mechanism: the GitHub Actions job runs `npm publish --access public --provenance`

Because npm publishing is tag-driven in CI for this repo, **do not run `npm publish` locally during a normal release**. The correct way to "make npm publish happen" here is:

1. bump the version
2. create the release commit and git tag
3. push `main`
4. push the tag to GitHub
5. optionally verify the GitHub Actions publish workflow started or succeeded

Running `npm publish` locally as well would race with or duplicate the CI release.

## Inputs

Accepted release types:
- `major`
- `minor`
- `patch`

If the user does not specify one of those three values, ask for clarification.

## Safety checks before releasing

Before running the release script, confirm all of the following:

- the repo working tree is clean
- the release should go from `main`
- the local checkout can fast-forward cleanly from `origin/main`
- the current package version comes from `package.json`
- the release workflow file still exists at `.github/workflows/release.yml`

If any of those checks fail, stop and explain why.

## Preferred execution path

Use the helper script in this skill:

```bash
bash skills/release/scripts/release.sh <major|minor|patch>
```

Examples:

```bash
bash skills/release/scripts/release.sh patch
bash skills/release/scripts/release.sh minor
bash skills/release/scripts/release.sh major
```

For a no-side-effects validation run, use:

```bash
bash skills/release/scripts/release.sh --dry-run patch
```

## What the helper script does

The script is the authoritative release path for this repo. It:

1. validates the requested bump type
2. ensures the working tree is clean
3. fetches from `origin`
4. switches to `main` if needed
5. fast-forwards `main` from `origin/main`
6. runs `npm run build --if-present`
7. runs `npm run check --if-present`
8. runs `npm version <type> -m "Release %s"`
9. pushes `main`
10. pushes the newly created tag
11. prints the new version and reminds you that GitHub Actions will publish to npm

## After the script succeeds

Report back with:

- the old version
- the new version
- the created tag
- confirmation that `main` and the tag were pushed
- a note that npm publication is performed by `.github/workflows/release.yml` after the tag push

If `gh` is available and the user asked for verification, you may inspect the latest run for the `Release to npm` workflow. If not, state that the tag push has triggered the publish workflow and that final confirmation should come from GitHub Actions.

## Failure handling

If the script fails:

- do not guess
- quote the failing command or the relevant stderr
- explain whether the release partially completed
- if `npm version` already created a commit/tag but push failed, tell the user exactly what happened before attempting cleanup

## Notes

- This skill is paired with the prompt template at `prompts/release.md` so the user can invoke it with `/release <major|minor|patch>`.
- Keep release responses concise and operational.
