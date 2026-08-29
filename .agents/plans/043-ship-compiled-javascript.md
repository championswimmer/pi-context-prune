---
name: 043-ship-compiled-javascript
description: Build and publish pi-context-prune as a compiled ESM JavaScript bundle, then release version 1.4.0.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: inspect issue #27 and the current package, build, and release configuration"
      - "- [x] step 2: research npm lifecycle and compiled Node ESM packaging guidance"
      - "- [x] step 3: choose a single-file esbuild bundle with Pi runtime packages externalized"
  - phase: implementation
    steps:
      - "- [x] step 1: add the esbuild pipeline and point the Pi manifest at dist/index.js"
      - "- [x] step 2: restrict npm package contents to compiled output and package documentation"
      - "- [x] step 3: add an automated package-content check and generated-output ignore rule"
  - phase: validation
    steps:
      - "- [x] step 1: install dependencies and run the build and package checks"
      - "- [x] step 2: inspect the bundle and npm dry-run contents for compiled-JS-only delivery"
      - "- [x] step 3: smoke-test loading the compiled ESM entrypoint with Pi"
  - phase: delivery
    steps:
      - "- [x] step 1: commit the implementation and push main"
      - "- [ ] step 2: run the repository release mechanism with npm version minor to create v1.4.0"
      - "- [ ] step 3: verify the release tag push and GitHub Actions publication workflow"
---

# 043-ship-compiled-javascript

## Outcome

Publish a package whose Pi extension entrypoint is a generated `dist/index.js` ESM bundle instead of raw TypeScript, while preserving runtime access to Pi-provided packages and providing a repeatable package-content check.

## Approach

Use `esbuild` directly to bundle `index.ts` and all local modules into one Node ESM artifact. Externalize the three `@earendil-works/*` Pi runtime packages, but bundle `@sinclair/typebox` so the native ESM artifact does not depend on the runtime's package naming/version layout. Generate a source map, publish only `dist/` plus package documentation, and use `prepack` to guarantee a fresh artifact for npm packaging. This is preferable to plain `tsc` here because issue #27 specifically reports high overhead from loading many modules and a native-ESM TypeBox resolution mismatch.

## Phase 1 — Discovery
- [x] step 1: inspect issue #27 and the current package, build, and release configuration
- [x] step 2: research npm lifecycle and compiled Node ESM packaging guidance
- [x] step 3: choose a single-file esbuild bundle with Pi runtime packages externalized

## Phase 2 — Implementation
- [x] step 1: add the esbuild pipeline and point the Pi manifest at dist/index.js
- [x] step 2: restrict npm package contents to compiled output and package documentation
- [x] step 3: add an automated package-content check and generated-output ignore rule

## Phase 3 — Validation
- [x] step 1: install dependencies and run the build and package checks
- [x] step 2: inspect the bundle and npm dry-run contents for compiled-JS-only delivery
- [x] step 3: smoke-test loading the compiled ESM entrypoint with Pi

## Phase 4 — Delivery
- [x] step 1: commit the implementation and push main
- [ ] step 2: run the repository release mechanism with npm version minor to create v1.4.0
- [ ] step 3: verify the release tag push and GitHub Actions publication workflow
