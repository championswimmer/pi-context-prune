import { describe, expect, test } from "bun:test";
import { injectSummaries, pruneMessages } from "../src/pruner.ts";
import { ToolCallIndexer } from "../src/indexer.ts";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "../src/types.ts";

function toolResult(id: string, text: string) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: 1,
  };
}

function assistantWithCalls(...ids: string[]) {
  return {
    role: "assistant" as const,
    content: ids.map((id) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} })),
  };
}

function indexTool(indexer: ToolCallIndexer, id: string, resultText = "full original output") {
  indexer.getIndex().set(id, {
    toolCallId: id,
    toolName: "bash",
    args: {},
    resultText,
    isError: false,
    turnIndex: 0,
    timestamp: 1,
  });
}

function recordSummary(
  indexer: ToolCallIndexer,
  content: string,
  toolCallIds: string[],
) {
  indexer.recordSummary(content, {
    toolCallRefs: toolCallIds.map((toolCallId, i) => ({
      shortId: `t${i + 1}`,
      toolCallId,
    })),
    toolNames: toolCallIds.map(() => "bash"),
    turnIndex: 0,
    timestamp: 1,
  });
}

describe("context seam after cancel or success", () => {
  test("unindexed tool results remain in context before commit", () => {
    const indexer = new ToolCallIndexer();
    const messages = [
      assistantWithCalls("tc1"),
      toolResult("tc1", "full original output"),
    ] as any[];

    const pruned = pruneMessages(messages, indexer);
    expect(pruned).toHaveLength(2);
    expect(pruned[1]).toMatchObject({ role: "toolResult", toolCallId: "tc1" });
  });

  test("indexed tool results are omitted after successful persistence", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");

    const messages = [
      assistantWithCalls("tc1"),
      toolResult("tc1", "full original output"),
      {
        role: "custom",
        customType: CUSTOM_TYPE_SUMMARY,
        content: "summary",
        display: false,
      },
    ] as any[];

    const pruned = pruneMessages(messages, indexer);
    expect(pruned.map((m: any) => m.role)).toEqual(["assistant", "custom"]);
  });
});

describe("ToolCallIndexer commit boundary", () => {
  test("failed batch persistence does not expose a partial runtime index", () => {
    const indexer = new ToolCallIndexer();
    const batch = {
      turnIndex: 1,
      timestamp: 1,
      assistantText: "",
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "bash",
          args: {},
          resultText: "out-1",
          isError: false,
        },
      ],
    } as any;
    const pi = {
      appendEntry() {
        throw new Error("stale context");
      },
    } as any;

    expect(() => indexer.addBatch(batch, pi)).toThrow("stale context");
    expect(indexer.getIndex().size).toBe(0);
  });
});

describe("injectSummaries", () => {
  test("agentic-auto: summarized toolResult is removed and summary appears near the toolCall", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "batch-1 summary", ["tc1"]);

    const messages = [
      { role: "user", content: "go" },
      assistantWithCalls("tc1"),
      toolResult("tc1", "full original output"),
      { role: "user", content: "continue" },
    ] as any[];

    const pruned = pruneMessages(messages, indexer, "agentic-auto");
    const injected = injectSummaries(pruned, indexer);

    expect(injected.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "custom",
      "user",
    ]);
    expect(injected[2]).toMatchObject({
      role: "custom",
      customType: CUSTOM_TYPE_SUMMARY,
      content: "batch-1 summary",
      display: false,
    });
    // Near toolCall, not at the tail after the final user message
    expect(injected[injected.length - 1].role).toBe("user");
  });

  test("agentic-auto: second inject is idempotent (no duplicate summary)", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "batch-1 summary", ["tc1"]);

    const messages = [
      assistantWithCalls("tc1"),
      toolResult("tc1", "full original output"),
    ] as any[];

    const once = injectSummaries(
      pruneMessages(messages, indexer, "agentic-auto"),
      indexer,
    );
    const twice = injectSummaries(once, indexer);

    expect(twice.filter((m: any) => m.role === "custom" && m.customType === CUSTOM_TYPE_SUMMARY)).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  test("all modes inject committed summaries near the pruned toolCalls", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "batch-1 summary", ["tc1"]);

    const messages = [
      assistantWithCalls("tc1"),
      toolResult("tc1", "full original output"),
      { role: "user", content: "later" },
    ] as any[];

    // agent-message/every-turn deliver summaries to the session file only;
    // without injection the live process never shows them to the LLM.
    for (const mode of ["every-turn", "on-context-tag", "on-demand", "agent-message"] as const) {
      const pruned = pruneMessages(messages, indexer, mode);
      const result = injectSummaries(pruned, indexer);
      expect(result.map((m: any) => m.role)).toEqual(["assistant", "custom", "user"]);
      expect(result[1]).toMatchObject({
        role: "custom",
        customType: CUSTOM_TYPE_SUMMARY,
        content: "batch-1 summary",
        display: false,
      });
    }
  });

  test("summary already loaded from session file is deduped, not duplicated", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "batch-1 summary", ["tc1"]);

    const messages = [
      assistantWithCalls("tc1"),
      {
        role: "custom",
        customType: CUSTOM_TYPE_SUMMARY,
        content: "batch-1 summary",
        display: false,
        details: {
          toolCallRefs: [{ shortId: "t1", toolCallId: "tc1" }],
          toolNames: ["bash"],
          turnIndex: 0,
          timestamp: 1,
        },
      },
      { role: "user", content: "later" },
    ] as any[];

    const result = injectSummaries(pruneMessages(messages, indexer, "agent-message"), indexer);
    const summaries = result.filter(
      (m: any) => m.role === "custom" && m.customType === CUSTOM_TYPE_SUMMARY,
    );
    expect(summaries).toHaveLength(1);
    expect(result.map((m: any) => m.role)).toEqual(["assistant", "custom", "user"]);
  });

  test("summary spanning assistant turns appears after the last covered toolCall", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    indexTool(indexer, "tc2");
    recordSummary(indexer, "multi-turn summary", ["tc1", "tc2"]);

    const messages = [
      assistantWithCalls("tc1"),
      toolResult("tc1", "out-1"),
      assistantWithCalls("tc2"),
      toolResult("tc2", "out-2"),
      { role: "user", content: "later" },
    ] as any[];

    const result = injectSummaries(
      pruneMessages(messages, indexer, "agentic-auto"),
      indexer,
    );

    expect(result).toEqual([
      messages[0],
      messages[2],
      expect.objectContaining({
        customType: CUSTOM_TYPE_SUMMARY,
        content: "multi-turn summary",
      }),
      messages[4],
    ]);
  });

  test("multi-batch: each batch summary appears once, near its own toolCalls", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    indexTool(indexer, "tc2");
    recordSummary(indexer, "summary-A", ["tc1"]);
    recordSummary(indexer, "summary-B", ["tc2"]);

    const messages = [
      assistantWithCalls("tc1"),
      toolResult("tc1", "out-1"),
      { role: "user", content: "next" },
      assistantWithCalls("tc2"),
      toolResult("tc2", "out-2"),
      { role: "user", content: "tail" },
    ] as any[];

    const result = injectSummaries(
      pruneMessages(messages, indexer, "agentic-auto"),
      indexer,
    );
    const roles = result.map((m: any) => (m.role === "custom" ? `custom:${m.content}` : m.role));

    expect(roles).toEqual([
      "assistant",
      "custom:summary-A",
      "user",
      "assistant",
      "custom:summary-B",
      "user",
    ]);

    // Second pass must not stack duplicates
    const again = injectSummaries(result, indexer);
    expect(again.filter((m: any) => m.customType === CUSTOM_TYPE_SUMMARY)).toHaveLength(2);
  });

  test("summary is not injected when its toolCalls are no longer in context", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "compacted summary", ["tc1"]);

    const messages = [{ role: "user", content: "new work after compaction" }] as any[];
    const result = injectSummaries(messages, indexer);

    expect(result).toBe(messages);
    expect(result).toEqual([{ role: "user", content: "new work after compaction" }]);
  });

  test("partially indexed batch keeps original toolResults and does not inject its summary", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "partial summary", ["tc1", "tc2"]);

    const messages = [
      assistantWithCalls("tc1", "tc2"),
      toolResult("tc1", "out-1"),
      toolResult("tc2", "out-2"),
    ] as any[];

    const pruned = pruneMessages(messages, indexer, "agentic-auto");
    const result = injectSummaries(pruned, indexer);

    expect(result).toEqual(messages);
    expect(result.filter((msg: any) => msg.role === "toolResult")).toHaveLength(2);
    expect(result.some((msg: any) => msg.customType === CUSTOM_TYPE_SUMMARY)).toBe(false);
  });

  test("orphan persisted summary is removed until its whole batch index commits", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "orphan summary", ["tc1", "tc2"]);

    const orphan = {
      role: "custom" as const,
      customType: CUSTOM_TYPE_SUMMARY,
      content: "orphan summary",
      display: false,
      details: {
        toolCallRefs: [
          { shortId: "t1", toolCallId: "tc1" },
          { shortId: "t2", toolCallId: "tc2" },
        ],
      },
    };
    const messages = [
      assistantWithCalls("tc1", "tc2"),
      toolResult("tc1", "out-1"),
      toolResult("tc2", "out-2"),
      orphan,
    ] as any[];

    const result = injectSummaries(
      pruneMessages(messages, indexer, "agentic-auto"),
      indexer,
    );

    expect(result).toEqual(messages.slice(0, -1));
  });

  test("session reconstruction restores summary content and relocates it near the toolCall", () => {
    const details = {
      toolCallRefs: [{ shortId: "t7", toolCallId: "tc1" }],
    };
    const persisted = {
      role: "custom" as const,
      customType: CUSTOM_TYPE_SUMMARY,
      content: "restored summary",
      display: false,
      details,
    };
    const indexer = new ToolCallIndexer();
    indexer.reconstructFromSession({
      sessionManager: {
        getBranch: () => [
          {
            type: "custom_message",
            customType: CUSTOM_TYPE_SUMMARY,
            content: "restored summary",
            details,
          },
          {
            type: "custom",
            customType: CUSTOM_TYPE_INDEX,
            data: {
              toolCalls: [
                {
                  toolCallId: "tc1",
                  toolName: "bash",
                  args: {},
                  resultText: "full output",
                  isError: false,
                  turnIndex: 1,
                  timestamp: 1,
                },
              ],
            },
          },
        ],
      },
    } as any);

    const messages = [
      assistantWithCalls("tc1"),
      { role: "user", content: "later" },
      persisted,
    ] as any[];
    const result = injectSummaries(
      pruneMessages(messages, indexer, "agentic-auto"),
      indexer,
    );

    expect(result).toEqual([messages[0], persisted, messages[1]]);
    expect(indexer.resolveToolCallId("t7")).toBe("tc1");
  });

  test("retry replaces an earlier summary for the same toolCall batch", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "stale summary", ["tc1"]);
    recordSummary(indexer, "fresh summary", ["tc1"]);

    const result = injectSummaries(
      [assistantWithCalls("tc1")],
      indexer,
    );

    expect(result[1]).toMatchObject({
      customType: CUSTOM_TYPE_SUMMARY,
      content: "fresh summary",
    });
  });

  test("persisted summary is moved back near its toolCall after session rebuild", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "batch-1 summary", ["tc1"]);

    const persisted = {
      role: "custom" as const,
      customType: CUSTOM_TYPE_SUMMARY,
      content: "batch-1 summary",
      display: false,
      details: {
        toolCallRefs: [{ shortId: "t1", toolCallId: "tc1" }],
      },
    };
    const messages = [
      assistantWithCalls("tc1"),
      { role: "user", content: "later" },
      persisted,
    ] as any[];

    const result = injectSummaries(messages, indexer);

    expect(result).toEqual([
      messages[0],
      persisted,
      messages[1],
    ]);
  });

  test("summary already present in messages is not re-inserted", () => {
    const indexer = new ToolCallIndexer();
    indexTool(indexer, "tc1");
    recordSummary(indexer, "batch-1 summary", ["tc1"]);

    const existing = {
      role: "custom" as const,
      customType: CUSTOM_TYPE_SUMMARY,
      content: "batch-1 summary",
      display: false,
      details: {
        toolCallRefs: [{ shortId: "t1", toolCallId: "tc1" }],
      },
    };

    const messages = [
      assistantWithCalls("tc1"),
      existing,
      { role: "user", content: "tail" },
    ] as any[];

    const result = injectSummaries(messages, indexer);
    expect(result.filter((m: any) => m.customType === CUSTOM_TYPE_SUMMARY)).toHaveLength(1);
    expect(result[1]).toBe(existing);
  });
});
