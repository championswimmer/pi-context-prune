import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTIC_AUTO_SYSTEM_PROMPT } from "../src/types.ts";

// Isolate settings BEFORE importing the extension so nothing touches a real home.
const testAgentDir = mkdtempSync(join(tmpdir(), "pruner-omp-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  let activeTools: string[] = [];
  const fake = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    appendEntry() {},
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => {
      activeTools = next;
    },
  };
  return {
    fake,
    handlers,
    async fire(event: string, payload: unknown) {
      const list = handlers.get(event) ?? [];
      let result: unknown;
      const ctx = {
        signal: new AbortController().signal,
        sessionManager: { getBranch: () => [] },
        ui: { setStatus() {}, notify() {} },
      };
      for (const handler of list) result = await handler(payload, ctx);
      return result;
    },
  };
}

const { default: register } = await import("../index.ts");

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true });
});

describe("omp host adaptation", () => {
  test("before_agent_start returns string[] for omp and keeps Markdown sections", async () => {
    const settingsDir = join(testAgentDir, "context-prune");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ enabled: true, pruneOn: "agentic-auto" }));

    const { fake, fire } = makeFakePi();
    register(fake as never);
    await fire("session_start", {});

    const result = await fire("before_agent_start", {
      prompt: "hi",
      systemPrompt: ["# Section A", "text, with commas"],
    });

    expect(result).toEqual({
      systemPrompt: ["# Section A", "text, with commas", AGENTIC_AUTO_SYSTEM_PROMPT],
    });
  });

  test("agent_end with willContinue keeps pending work instead of committing", async () => {
    const settingsDir = join(testAgentDir, "context-prune");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ enabled: true, pruneOn: "agent-message" }));

    const { fake, fire } = makeFakePi();
    register(fake as never);
    await fire("session_start", {});

    const result = await fire("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
      willContinue: true,
    });

    // The guard short-circuits before the summarizer path; with no pending
    // batches the lifecycle reports nothing was flushed.
    expect(result).toBeUndefined();
  });
});
