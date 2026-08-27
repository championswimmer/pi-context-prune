/**
 * End-to-end regression test for the phantom-turn bug.
 *
 * Drives a real agent session through the SDK (the pattern pi's docs
 * recommend for testing extensions: in-memory session/settings managers,
 * extension factories via DefaultResourceLoader, and a scripted custom
 * provider) and asserts that a multi-batch prune flush does NOT start
 * extra agent turns after the model produced its final message.
 *
 * With the old per-batch steer delivery, the scripted flow below produces
 * one extra assistant message per flushed batch. With coalesced delivery,
 * the single steer message rides along in the turn that answers the
 * context_prune tool result.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// The extension resolves ~/.pi/agent/context-prune/settings.json at import
// time. Point the home directory at a temp dir before importing it.
const fakeHome = mkdtempSync(join(tmpdir(), "prune-e2e-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const settingsDir = join(fakeHome, ".pi", "agent", "context-prune");
mkdirSync(settingsDir, { recursive: true });
writeFileSync(
  join(settingsDir, "settings.json"),
  JSON.stringify({
    enabled: true,
    pruneOn: "agentic-auto",
    showPruneStatusLine: false,
  }),
);

after(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

// ── Scripted fake provider ──────────────────────────────────────────────────

type ScriptedResponse =
  | { kind: "tool"; toolCall: { id: string; name: string; arguments: any } }
  | { kind: "text"; text: string };

/** Agent-turn script. Exhausted script → final text → any further (phantom) turns are labeled. */
const agentScript: ScriptedResponse[] = [
  {
    kind: "tool",
    toolCall: {
      id: "call-1",
      name: "bash",
      arguments: { command: `node -e "console.log('one '.repeat(200))"` },
    },
  },
  {
    kind: "tool",
    toolCall: {
      id: "call-2",
      name: "bash",
      arguments: { command: `node -e "console.log('two '.repeat(200))"` },
    },
  },
  {
    kind: "tool",
    toolCall: { id: "call-3", name: "context_prune", arguments: {} },
  },
  { kind: "text", text: "All done." },
];

function nextResponse(context: any): ScriptedResponse {
  // The summarizer prompt serializes tool calls as "Tool: <name>" lines and
  // lives in a user message; agent turns never contain that marker.
  const allText = (context.messages as any[])
    .map((m) =>
      typeof m.content?.text === "string"
        ? m.content.text
        : Array.isArray(m.content)
          ? m.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
          : "",
    )
    .join("\n");
  if (/Tool: [a-z_]+/.test(allText)) {
    const tools = [...allText.matchAll(/Tool: ([a-z_]+)/g)].map((m) => m[1]);
    return { kind: "text", text: `Summary of ${tools.join(", ")}` };
  }
  return agentScript.shift() ?? { kind: "text", text: "PHANTOM TURN" };
}

// pi-ai has no import-time env dependencies; safe to import statically.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function makeFakeStream(model: any, context: any) {
  const response = nextResponse(context);
  const content =
    response.kind === "tool"
      ? [
          {
            type: "toolCall",
            id: response.toolCall.id,
            name: response.toolCall.name,
            arguments: response.toolCall.arguments,
          },
        ]
      : [{ type: "text", text: response.text }];
  const stopReason = response.kind === "tool" ? "toolUse" : "stop";

  const stream = createAssistantMessageEventStream();
  const output: any = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
  (async () => {
    stream.push({ type: "start", partial: output });
    const contentIndex = 0;
    if (response.kind === "tool") {
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      output.content = [content[0]];
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: content[0],
        partial: output,
      });
    } else {
      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: response.text,
        partial: output,
      });
      output.content = [content[0]];
      stream.push({
        type: "text_end",
        contentIndex,
        content: response.text,
        partial: output,
      });
    }
    output.stopReason = stopReason;
    stream.push({ type: "done", reason: stopReason, message: output });
    stream.end();
  })();
  return stream;
}

// ── Test ────────────────────────────────────────────────────────────────────

describe("end-to-end: coalesced summary delivery (agentic-auto)", () => {
  it("a multi-batch flush does not start extra turns after the final message", async () => {
    const agent = await import("@earendil-works/pi-coding-agent");
    const extension = await import("../index.ts");
    const {
      createAgentSession,
      ModelRuntime,
      SessionManager,
      SettingsManager,
      DefaultResourceLoader,
    } = agent as any;

    const fakeModel = {
      id: "fake-1",
      name: "Fake 1",
      provider: "fake",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };

    process.env.FAKE_API_KEY = "test-key";

    const workDir = mkdtempSync(join(tmpdir(), "prune-e2e-cwd-"));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(fakeHome, "auth.json"),
      modelsPath: join(fakeHome, "models.json"),
    });
    await modelRuntime.setRuntimeApiKey("fake", "test-key");

    const resourceLoader = new DefaultResourceLoader({
      cwd: workDir,
      agentDir: fakeHome,
      extensionFactories: [
        (pi: any) => {
          pi.registerProvider("fake", {
            name: "Fake",
            baseUrl: "http://localhost.invalid",
            apiKey: "$FAKE_API_KEY",
            api: "openai-completions",
            models: [fakeModel],
            streamSimple: (model: any, context: any) =>
              makeFakeStream(model, context),
          });
        },
        extension.default,
      ],
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    // Extension factories only register providers when the loader is reloaded
    // explicitly (createAgentSession does not reload an injected loader).
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: workDir,
      agentDir: fakeHome,
      model: fakeModel,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      tools: ["bash", "context_prune"],
      sessionManager: SessionManager.inMemory(workDir),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
      }),
    });

    // In SDK sessions the `session_start` event (which loads the extension's
    // config and activates its tools) only fires with UI bindings. Activate the
    // pruner's tool explicitly so the scripted model can call it.
    await session.setActiveToolsByName(["bash", "context_prune"]);

    try {
      await session.prompt("Run the scripted flow.");

      const messages = session.messages as any[];

      // The context_prune tool result and everything after it.
      const pruneResultIdx = messages.findIndex(
        (m) => m.role === "toolResult" && m.toolName === "context_prune",
      );
      assert.ok(
        pruneResultIdx >= 0,
        "context_prune must have been called by the scripted model",
      );

      const afterPrune = messages.slice(pruneResultIdx + 1);
      const assistantAfterPrune = afterPrune.filter(
        (m) => m.role === "assistant" && m.stopReason !== "aborted",
      );

      // Exactly ONE assistant message after the prune tool result: the final
      // "All done." turn that also carries the coalesced summary. The old
      // per-batch steer delivery produced one extra assistant message per
      // flushed batch (here: 2 batches → 2 messages).
      assert.equal(
        assistantAfterPrune.length,
        1,
        `expected exactly 1 assistant message after context_prune, got ${assistantAfterPrune.length}`,
      );
      assert.ok(
        assistantAfterPrune[0]?.content?.some(
          (c: any) => c.type === "text" && c.text.includes("All done."),
        ),
      );
      assert.ok(
        !messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content?.some(
              (c: any) => c.type === "text" && c.text.includes("PHANTOM TURN"),
            ),
        ),
        "no phantom turns may run after the final message",
      );

      // The two flushed batch summaries land as exactly ONE custom message.
      const summaries = messages.filter(
        (m) => m.role === "custom" && m.customType === "context-prune-summary",
      );
      assert.equal(
        summaries.length,
        1,
        `expected 1 summary custom message, got ${summaries.length}`,
      );
      const summaryText = JSON.stringify(summaries[0]);
      assert.ok(
        summaryText.includes("Summary of bash"),
        "both batch summaries should be in the coalesced message",
      );
    } finally {
      session.dispose();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
