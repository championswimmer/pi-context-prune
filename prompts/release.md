---
description: Create and push a semver release for this package
argument-hint: "<major|minor|patch>"
---
Perform a $1 release for this repository.

Before doing anything else:
- Read `skills/release/SKILL.md` completely and follow it.
- Use `bash skills/release/scripts/release.sh $1` as the primary execution path.
- Treat `.github/workflows/release.yml` as the npm publish mechanism for this repo after the tag is pushed.

After the release finishes, report:
- old version
- new version
- created tag
- whether `main` and the tag were pushed successfully
- that the npm publish workflow was triggered by the tag push
