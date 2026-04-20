---
name: 000-context-prune-extension-initial-version
description: Build the first working Pi extension that summarizes tool-call batches, optionally prunes raw tool outputs from future context, and exposes a context_tree_query escape hatch back to the original session tree.
steps:
  - phase: discovery-and-design
    steps:
      - "- [ ] step 1: confirm the v1 extension layout and target path, using a project-local Pi extension under .pi/extensions/context-prune/ so /reload works during development"
      - "- [ ] step 2: lock down the v1 interpretation of a summarization batch as one completed assistant tool-calling turn, based on Pi's turn_end event shape and steer-message injection timing"
      - "- [ ] step 3: define the extension state model, separating runtime state, persisted session metadata, and persisted user configuration"
      - "- [ ] step 4: decide the v1 config format for pruning enabled state and summarizer model, preferring a contextPrune block in project .pi/settings.json only if direct JSON merge is safe and stable enough"
      - "- [ ] step 5: specify the summary message format, including mandatory toolCallIds, concise outcome bullets, and enough structure for the model to know when to call context_tree_query"
      - "- [ ] step 6: document the main public-API constraints discovered from Pi docs, especially that pruning should happen in the context event rather than by mutating session history"
  - phase: extension-scaffold-and-config
    steps:
      - "- [ ] step 1: scaffold the extension entrypoint and helper modules under .pi/extensions/context-prune/ with clear separation for config, summarization, indexing, pruning, commands, and UI"
      - "- [ ] step 2: add a small local package.json if needed for TypeScript ergonomics and any runtime dependencies, while keeping the initial version dependency-light"
      - "- [ ] step 3: implement config load and save helpers that read project settings, merge only the context-prune-specific keys, and preserve unrelated settings content"
      - "- [ ] step 4: define the persisted config schema for enabled on/off state and summarizer model value, where summarizerModel can be either default or an explicit provider/model id"
      - "- [ ] step 5: restore config and runtime caches on session_start so the extension behaves consistently across reload, resume, and fork flows"
      - "- [ ] step 6: add extension-level status text or lightweight notifications so the user can see whether pruning is active and which summarizer mode is selected"
  - phase: summarizer-model-selection-and-batch-capture
    steps:
      - "- [ ] step 1: implement model resolution logic that maps summarizerModel=default to the current active Pi model and maps explicit provider/model values through ctx.modelRegistry"
      - "- [ ] step 2: implement auth resolution for the summarizer path using ctx.modelRegistry.getApiKeyAndHeaders, with clear fallbacks and user-visible errors when a configured model is unavailable"
      - "- [ ] step 3: build a batch-capture helper that takes the completed assistant message plus its tool results and serializes only that tool-call batch into summarizer-friendly text"
      - "- [ ] step 4: define a dedicated summarizer prompt that asks for a compact structured summary of what happened, what mattered, and which toolCallIds can be queried later"
      - "- [ ] step 5: decide whether the initial version should summarize only when pruning is enabled or always summarize and only hide raw tool outputs when enabled, then implement that policy consistently"
      - "- [ ] step 6: explicitly document the v1 meaning of default summarizer mode, likely as using the current active model and credentials rather than literally reusing the live agent loop internals"
  - phase: summary-injection-and-session-metadata
    steps:
      - "- [ ] step 1: detect completed tool-calling turns from turn_end by checking for non-empty toolResults and collecting the assistant tool-call blocks with their ids"
      - "- [ ] step 2: generate one summary message for that completed batch and inject it with pi.sendMessage using steer delivery so it lands before the next LLM call"
      - "- [ ] step 3: register a custom message type such as context-prune-summary and include machine-readable details metadata like toolCallIds, tool names, timestamps, and source turn information"
      - "- [ ] step 4: register a custom message renderer so summaries are readable in the TUI and expandable for debugging without overwhelming the default transcript"
      - "- [ ] step 5: ensure the summary content itself contains the toolCallIds in plain text so the model can directly reference them in future context_tree_query calls"
      - "- [ ] step 6: verify the ordering guarantees in practice so the summary custom_message appears between the tool-call batch and the next assistant response, matching the intended user experience"
  - phase: pruning-pipeline-and-original-history-access
    steps:
      - "- [ ] step 1: implement the context event handler to rebuild a pruned message list from ctx.sessionManager.getBranch rather than relying only on event.messages, because the extension needs access to raw session entries and summary metadata"
      - "- [ ] step 2: define the pruning rule so that when pruning is on, summarized tool-result outputs are removed from future LLM context while the summary custom_message remains"
      - "- [ ] step 3: decide whether v1 also hides the original assistant tool-call block or only hides tool results, and choose the option that preserves toolCallIds without making the summary redundant"
      - "- [ ] step 4: implement a lookup index from summary metadata back to original toolCallIds so the pruning pass knows exactly which tool results are represented by each summary"
      - "- [ ] step 5: add the context_tree_query tool that accepts an array of toolCallIds and returns the original tool name, arguments, result text, error state, and any useful surrounding metadata in one call"
      - "- [ ] step 6: apply proper truncation to context_tree_query output so large recovered tool outputs remain usable without blowing up the active context again"
      - "- [ ] step 7: add promptSnippet and promptGuidelines for context_tree_query so the model knows this is the supported escape hatch back to detailed original tool history"
  - phase: commands-ui-and-original-tree-browser
    steps:
      - "- [ ] step 1: implement the /context-prune command with subcommands for on, off, status, and model selection, keeping the command syntax simple and explicit"
      - "- [ ] step 2: persist command-driven config changes immediately so /context-prune on, /context-prune off, and summarizer model changes survive reloads and future sessions"
      - "- [ ] step 3: implement /context-prune original-tree as a dedicated browser for the raw unpruned session tree, likely by reusing TreeSelectorComponent or a thin custom wrapper over ctx.sessionManager.getTree()"
      - "- [ ] step 4: make the original-tree browser clearly communicate that it shows the untouched underlying session history rather than the pruned LLM context view"
      - "- [ ] step 5: add lightweight user feedback for command execution, including current mode, current summarizer model, and failures to resolve requested models"
      - "- [ ] step 6: decide whether the command should also support an interactive no-args settings view for toggling on/off and choosing the summarizer model without typing long ids"
  - phase: validation-hardening-and-docs
    steps:
      - "- [ ] step 1: create a reproducible manual test matrix covering pruning off, pruning on, default summarizer, explicit summarizer model, reload, resume, and tree browsing"
      - "- [ ] step 2: validate that the session file still contains the original tool results even after pruning is enabled, proving that only context building changed and not historical storage"
      - "- [ ] step 3: validate that a model can recover detailed raw tool output through a single context_tree_query call containing multiple toolCallIds"
      - "- [ ] step 4: validate that summary messages are inserted in the intended order and that future turns receive summaries instead of raw tool outputs when pruning is enabled"
      - "- [ ] step 5: add repo documentation describing the extension architecture, config format, supported commands, and known v1 limitations"
      - "- [ ] step 6: note explicit follow-up items for later iterations, such as better summary grouping across multiple tool-calling turns, tighter settings integration, and richer original-tree UX"
---

# 000-context-prune-extension-initial-version

## Phase 1 — Discovery and Design
- [ ] step 1: confirm the v1 extension layout and target path, using a project-local Pi extension under `.pi/extensions/context-prune/` so `/reload` works during development
- [ ] step 2: lock down the v1 interpretation of a summarization batch as one completed assistant tool-calling turn, based on Pi's `turn_end` event shape and steer-message injection timing
- [ ] step 3: define the extension state model, separating runtime state, persisted session metadata, and persisted user configuration
- [ ] step 4: decide the v1 config format for pruning enabled state and summarizer model, preferring a `contextPrune` block in project `.pi/settings.json` only if direct JSON merge is safe and stable enough
- [ ] step 5: specify the summary message format, including mandatory `toolCallIds`, concise outcome bullets, and enough structure for the model to know when to call `context_tree_query`
- [ ] step 6: document the main public-API constraints discovered from Pi docs, especially that pruning should happen in the `context` event rather than by mutating session history

## Phase 2 — Extension Scaffold and Config
- [ ] step 1: scaffold the extension entrypoint and helper modules under `.pi/extensions/context-prune/` with clear separation for config, summarization, indexing, pruning, commands, and UI
- [ ] step 2: add a small local `package.json` if needed for TypeScript ergonomics and any runtime dependencies, while keeping the initial version dependency-light
- [ ] step 3: implement config load and save helpers that read project settings, merge only the context-prune-specific keys, and preserve unrelated settings content
- [ ] step 4: define the persisted config schema for enabled on/off state and summarizer model value, where `summarizerModel` can be either `default` or an explicit `provider/model` id
- [ ] step 5: restore config and runtime caches on `session_start` so the extension behaves consistently across reload, resume, and fork flows
- [ ] step 6: add extension-level status text or lightweight notifications so the user can see whether pruning is active and which summarizer mode is selected

## Phase 3 — Summarizer Model Selection and Batch Capture
- [ ] step 1: implement model resolution logic that maps `summarizerModel=default` to the current active Pi model and maps explicit `provider/model` values through `ctx.modelRegistry`
- [ ] step 2: implement auth resolution for the summarizer path using `ctx.modelRegistry.getApiKeyAndHeaders`, with clear fallbacks and user-visible errors when a configured model is unavailable
- [ ] step 3: build a batch-capture helper that takes the completed assistant message plus its tool results and serializes only that tool-call batch into summarizer-friendly text
- [ ] step 4: define a dedicated summarizer prompt that asks for a compact structured summary of what happened, what mattered, and which `toolCallIds` can be queried later
- [ ] step 5: decide whether the initial version should summarize only when pruning is enabled or always summarize and only hide raw tool outputs when enabled, then implement that policy consistently
- [ ] step 6: explicitly document the v1 meaning of `default` summarizer mode, likely as using the current active model and credentials rather than literally reusing the live agent loop internals

## Phase 4 — Summary Injection and Session Metadata
- [ ] step 1: detect completed tool-calling turns from `turn_end` by checking for non-empty `toolResults` and collecting the assistant tool-call blocks with their ids
- [ ] step 2: generate one summary message for that completed batch and inject it with `pi.sendMessage` using steer delivery so it lands before the next LLM call
- [ ] step 3: register a custom message type such as `context-prune-summary` and include machine-readable `details` metadata like `toolCallIds`, tool names, timestamps, and source turn information
- [ ] step 4: register a custom message renderer so summaries are readable in the TUI and expandable for debugging without overwhelming the default transcript
- [ ] step 5: ensure the summary content itself contains the `toolCallIds` in plain text so the model can directly reference them in future `context_tree_query` calls
- [ ] step 6: verify the ordering guarantees in practice so the summary `custom_message` appears between the tool-call batch and the next assistant response, matching the intended user experience

## Phase 5 — Pruning Pipeline and Original History Access
- [ ] step 1: implement the `context` event handler to rebuild a pruned message list from `ctx.sessionManager.getBranch()` rather than relying only on `event.messages`, because the extension needs access to raw session entries and summary metadata
- [ ] step 2: define the pruning rule so that when pruning is on, summarized tool-result outputs are removed from future LLM context while the summary `custom_message` remains
- [ ] step 3: decide whether v1 also hides the original assistant tool-call block or only hides tool results, and choose the option that preserves `toolCallIds` without making the summary redundant
- [ ] step 4: implement a lookup index from summary metadata back to original `toolCallIds` so the pruning pass knows exactly which tool results are represented by each summary
- [ ] step 5: add the `context_tree_query` tool that accepts an array of `toolCallIds` and returns the original tool name, arguments, result text, error state, and any useful surrounding metadata in one call
- [ ] step 6: apply proper truncation to `context_tree_query` output so large recovered tool outputs remain usable without blowing up the active context again
- [ ] step 7: add `promptSnippet` and `promptGuidelines` for `context_tree_query` so the model knows this is the supported escape hatch back to detailed original tool history

## Phase 6 — Commands, UI, and Original Tree Browser
- [ ] step 1: implement the `/context-prune` command with subcommands for `on`, `off`, `status`, and model selection, keeping the command syntax simple and explicit
- [ ] step 2: persist command-driven config changes immediately so `/context-prune on`, `/context-prune off`, and summarizer model changes survive reloads and future sessions
- [ ] step 3: implement `/context-prune original-tree` as a dedicated browser for the raw unpruned session tree, likely by reusing `TreeSelectorComponent` or a thin custom wrapper over `ctx.sessionManager.getTree()`
- [ ] step 4: make the original-tree browser clearly communicate that it shows the untouched underlying session history rather than the pruned LLM context view
- [ ] step 5: add lightweight user feedback for command execution, including current mode, current summarizer model, and failures to resolve requested models
- [ ] step 6: decide whether the command should also support an interactive no-args settings view for toggling on/off and choosing the summarizer model without typing long ids

## Phase 7 — Validation, Hardening, and Docs
- [ ] step 1: create a reproducible manual test matrix covering pruning off, pruning on, default summarizer, explicit summarizer model, reload, resume, and tree browsing
- [ ] step 2: validate that the session file still contains the original tool results even after pruning is enabled, proving that only context building changed and not historical storage
- [ ] step 3: validate that a model can recover detailed raw tool output through a single `context_tree_query` call containing multiple `toolCallIds`
- [ ] step 4: validate that summary messages are inserted in the intended order and that future turns receive summaries instead of raw tool outputs when pruning is enabled
- [ ] step 5: add repo documentation describing the extension architecture, config format, supported commands, and known v1 limitations
- [ ] step 6: note explicit follow-up items for later iterations, such as better summary grouping across multiple tool-calling turns, tighter settings integration, and richer original-tree UX

## Notes from Pi docs research

- Pi extensions are best placed in `.pi/extensions/` for auto-discovery and `/reload` support.
- The main public hooks relevant to this feature are `turn_end`, `context`, `session_start`, `registerTool`, `registerCommand`, `sendMessage`, and `registerMessageRenderer`.
- The clean way to keep full original history while pruning only the next request context is to leave the session file untouched and prune only in the `context` event.
- `turn_end` exposes the completed assistant message and its `toolResults`, which is enough to build a per-batch summarization request.
- `pi.sendMessage(..., { deliverAs: "steer" })` is the hook that can place a summary into the conversation before the next LLM call.
- Pi's public extension docs do not expose a first-class custom settings API. A practical v1 option is to store a `contextPrune` block in project `.pi/settings.json` and manage it via direct JSON merge, since Pi's settings manager preserves unknown keys when rewriting settings files.
- The raw session tree already remains intact when pruning is done at context-build time, so `/context-prune original-tree` is primarily a convenience browser over original session entries rather than a second storage system.
- The public API seems able to support `default` as “use the current active model for summarization,” but it may not support literally reusing the in-flight agent session as a hidden side-channel summarizer. That should be treated as a documented v1 behavior decision.
