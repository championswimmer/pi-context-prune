/**
 * Behavior tests for runtime summary delivery in flushPending.
 *
 * Covers the coalescing fix: a flush with N batches must send exactly ONE
 * steer message (not one per batch), index entries must only be persisted
 * after the message was delivered, oversized batches must be skipped, and
 * session delivery must stay unchanged.
 *
 * The extension is loaded with a fully mocked `pi` object; the summarizer
 * LLM call is stubbed through a fake model registry + provider.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, describe, it } from "node:test";

// ── Config isolation ────────────────────────────────────────────────────────
// config.ts resolves ~/.pi/agent/context-prune/settings.json at import time
// via os.homedir(), which honors USERPROFILE on Windows. Point it at a temp
// dir BEFORE the first dynamic import of the extension.
const fakeHome = mkdtempSync(join(tmpdir(), "ctx-prune-test-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
const settingsDir = join(fakeHome, ".pi", "agent", "context-prune");
mkdirSync(settingsDir, { recursive: true });
const settingsPath = join(settingsDir, "settings.json");

function writeSettings(pruneOn: string): void {
  writeFileSync(settingsPath, JSON.stringify({ enabled: true, pruneOn, showPruneStatusLine: false }));
}

after(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

// ── Test doubles ────────────────────────────────────────────────────────────

/** Ordered log of every persistence/delivery side effect. */
type SeqEntry =
  | { kind: "sendMessage"; msg: any; opts: any }
  | { kind: "appendEntry"; customType: string }
  | { kind: "appendCustomMessageEntry"; customType: string };

let sendMessageBehavior: ((msg: any, opts: any) => void) | undefined;

function makeHarness(branch: any[] = []) {
  const seq: SeqEntry[] = [];
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();

  const pi: any = {
    on: (type: string, handler: Function) => handlers.set(type, handler),
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: (msg: any, opts: any) => {
      seq.push({ kind: "sendMessage", msg, opts });
      sendMessageBehavior?.(msg, opts);
    },
    appendEntry: (customType: string, _data: unknown) => {
      seq.push({ kind: "appendEntry", customType });
    },
  };

  // Fake summarizer provider: echoes a distinguishable summary per batch,
  // derived from the tool name embedded in the serialized prompt.
  const fakeProvider = {
    stream: (_model: any, llmContext: any) => {
      const prompt = llmContext.messages[0]?.content?.[0]?.text ?? "";
      const toolNames = [...prompt.matchAll(/Tool: ([a-z_]+)/g)].map((m) => m[1]);
      const text = `Summary of ${toolNames.join(", ")}`;
      const finalMessage = {
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_start", partial: { content: [] } };
        },
        result: () => Promise.resolve(finalMessage),
      };
    },
  };

  const ctx: any = {
    model: { provider: "mock", id: "mock-1", contextWindow: 200000 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
      getProvider: () => fakeProvider,
      find: () => undefined,
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, custom: {} },
    sessionManager: {
      getBranch: () => branch,
      appendCustomEntry: (customType: string) => {
        seq.push({ kind: "appendEntry", customType });
        return "entry-1";
      },
      appendCustomMessageEntry: (customType: string) => {
        seq.push({ kind: "appendCustomMessageEntry", customType });
        return "msg-1";
      },
    },
  };

  return { pi, ctx, seq, handlers, tools };
}

/** Builds session branch entries: one assistant turn per tool call. */
function makeBranch(...toolCalls: Array<{ id: string; name: string; resultText: string; args?: any }>): any[] {
  const entries: any[] = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }];
  for (const tc of toolCalls) {
    entries.push({
      type: "message",
      timestamp: Date.now(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args ?? {} }],
        timestamp: Date.now(),
      },
    });
    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: [{ type: "text", text: tc.resultText }],
      },
    });
  }
  return entries;
}

async function loadExtension(config: any, harness: ReturnType<typeof makeHarness>) {
  const mod = await import("../index.ts");
  mod.default(harness.pi);
  // session_start loads config from the isolated settings file.
  await harness.handlers.get("session_start")!({}, harness.ctx);
  assert.equal(config.enabledCheck ?? true, true);
}

/** Runs one context_prune tool execution against the harness. */
async function runPruneTool(harness: ReturnType<typeof makeHarness>) {
  const tool = harness.tools.get("context_prune");
  assert.ok(tool, "context_prune tool must be registered");
  return await tool.execute("call-0", {}, undefined, undefined, harness.ctx);
}

const toolResultMessage = (tc: { id: string; name: string; resultText: string }) => ({
  role: "toolResult",
  toolCallId: tc.id,
  toolName: tc.name,
  content: [{ type: "text", text: tc.resultText }],
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runtime delivery (context_prune tool)", () => {
  before(() => writeSettings("agentic-auto"));

  it("sends ONE coalesced steer message for a multi-batch flush", async () => {
    sendMessageBehavior = undefined;
    const calls = [
      { id: "tc-1", name: "bash", resultText: "output one".repeat(20) },
      { id: "tc-2", name: "read", resultText: "output two".repeat(20) },
      { id: "tc-3", name: "grep", resultText: "output three".repeat(20) },
    ];
    const harness = makeHarness(makeBranch(...calls));
    await loadExtension({}, harness);

    const result = await runPruneTool(harness);

    // The tool-level result reports success.
    assert.equal(result.details.ok, true);
    assert.equal(result.details.reason, "flushed");
    assert.equal(result.details.batchCount, 3);

    // Exactly ONE summary message sent — not one per batch.
    const sends = harness.seq.filter((s) => s.kind === "sendMessage");
    assert.equal(sends.length, 1, `expected 1 sendMessage, got ${sends.length}`);
    const send = sends[0] as Extract<SeqEntry, { kind: "sendMessage" }>;

    assert.equal(send.opts.deliverAs, "steer");
    assert.equal(send.msg.customType, "context-prune-summary");
    assert.equal(send.msg.display, false);

    // All three batch summaries ride along in the one message.
    for (const name of ["bash", "read", "grep"]) {
      assert.ok(send.msg.content.includes(`Summary of ${name}`), `summary for ${name} missing`);
    }

    // Merged details carry refs for every tool call.
    assert.equal(send.msg.details.toolCallRefs.length, 3);
    assert.equal(send.msg.details.toolNames.length, 3);

    // Index entries are persisted AFTER the message was delivered.
    const firstSend = harness.seq.findIndex((s) => s.kind === "sendMessage");
    const indexEntries = harness.seq
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind === "appendEntry" && (s as any).customType === "context-prune-index");
    assert.equal(indexEntries.length, 3, "one index entry per batch");
    for (const { i } of indexEntries) assert.ok(i > firstSend, "index entry persisted before the summary was delivered");
  });

  it("sends no message and persists no index when delivery fails with stale ctx", async () => {
    sendMessageBehavior = () => {
      throw new Error("This extension ctx is stale");
    };
    try {
      const calls = [
        { id: "tc-1", name: "bash", resultText: "output one".repeat(20) },
        { id: "tc-2", name: "read", resultText: "output two".repeat(20) },
      ];
      const harness = makeHarness(makeBranch(...calls));
      await loadExtension({}, harness);

      const result = await runPruneTool(harness);

      // Nothing delivered → flush reports failure, tool surfaces it.
      assert.equal(result.details.ok, false);

      // Critical safety property: no index entries persisted without a
      // delivered summary (otherwise tool results would be pruned from
      // context with no replacement).
      const indexEntries = harness.seq.filter(
        (s) => s.kind === "appendEntry" && (s as any).customType === "context-prune-index"
      );
      assert.equal(indexEntries.length, 0, "index entries persisted despite failed delivery");
    } finally {
      sendMessageBehavior = undefined;
    }
  });

  it("skips batches whose summary is larger than the raw output", async () => {
    sendMessageBehavior = undefined;
    // Tiny raw output → wrapped summary is necessarily larger → batch skipped.
    const harness = makeHarness(makeBranch({ id: "tc-1", name: "bash", resultText: "x" }));
    await loadExtension({}, harness);

    const result = await runPruneTool(harness);

    assert.equal(result.details.ok, true);
    assert.equal(result.details.reason, "skipped-oversized");
    assert.equal(harness.seq.filter((s) => s.kind === "sendMessage").length, 0);
    assert.equal(
      harness.seq.filter((s) => s.kind === "appendEntry" && (s as any).customType === "context-prune-index").length,
      0
    );
  });

  it("prunes only indexed tool results in the context event", async () => {
    sendMessageBehavior = undefined;
    // tc-1 is flushed and indexed; tc-2 arrives after the flush and is never
    // part of the session branch, so it must stay in context.
    const pruned = { id: "tc-1", name: "bash", resultText: "output one".repeat(20) };
    const unpruned = { id: "tc-9", name: "read", resultText: "still raw".repeat(20) };
    const harness = makeHarness(makeBranch(pruned));
    await loadExtension({}, harness);

    await runPruneTool(harness);

    const contextHandler = harness.handlers.get("context");
    assert.ok(contextHandler);
    const outcome = await contextHandler(
      { messages: [toolResultMessage(pruned), toolResultMessage(unpruned)] },
      harness.ctx
    );
    assert.ok(outcome?.messages, "context event should return filtered messages");
    const remaining = outcome.messages.filter((m: any) => m.role === "toolResult");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].toolCallId, "tc-9", "only the indexed result is pruned");
  });
});

describe("session delivery (agent-message mode)", () => {
  it("appends one summary message per batch and sends no steer messages", async () => {
    sendMessageBehavior = undefined;
    writeSettings("agent-message");
    const calls = [
      { id: "tc-1", name: "bash", resultText: "output one".repeat(20) },
      { id: "tc-2", name: "read", resultText: "output two".repeat(20) },
    ];
    const harness = makeHarness(makeBranch(...calls));
    await loadExtension({}, harness);

    // Final assistant message (no tool calls) triggers the flush.
    const messageEnd = harness.handlers.get("message_end");
    assert.ok(messageEnd);
    await messageEnd(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      harness.ctx
    );

    assert.equal(harness.seq.filter((s) => s.kind === "sendMessage").length, 0, "session delivery must not steer");
    const summaryAppends = harness.seq.filter(
      (s) => s.kind === "appendCustomMessageEntry" && (s as any).customType === "context-prune-summary"
    );
    assert.equal(summaryAppends.length, 2, "one summary entry per batch");
  });

  it("does not flush on non-final assistant messages", async () => {
    sendMessageBehavior = undefined;
    const harness = makeHarness(makeBranch({ id: "tc-1", name: "bash", resultText: "output one".repeat(20) }));
    await loadExtension({}, harness);

    const messageEnd = harness.handlers.get("message_end");
    await messageEnd(
      { message: { role: "assistant", content: [{ type: "toolCall", id: "tc-2", name: "read", arguments: {} }] } },
      harness.ctx
    );

    assert.equal(harness.seq.filter((s) => s.kind === "appendCustomMessageEntry").length, 0);
  });
});
