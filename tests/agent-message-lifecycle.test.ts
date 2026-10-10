import { describe, expect, test } from "bun:test";
import { handleAgentEndLifecycle } from "../src/agent-message-lifecycle.ts";

function assistant(stopReason: string, text = "hi") {
  return {
    role: "assistant",
    stopReason,
    content: [{ type: "text", text }],
  };
}

describe("handleAgentEndLifecycle", () => {
  test("successful stop flushes exactly once with session delivery and active signal", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const statuses: number[] = [];

    const result = await handleAgentEndLifecycle({
      enabled: true,
      pruneOn: "agent-message",
      messages: [assistant("stop", "done")],
      pendingCount: 2,
      signal: controller.signal,
      flush: async (options) => {
        calls.push(options);
      },
      setPendingStatus: (count) => statuses.push(count),
    });

    expect(result).toBe("flushed");
    expect(calls).toEqual([{ delivery: "session", signal: controller.signal }]);
    expect(statuses).toEqual([]);
  });

  test("error/aborted/length/tool endings keep pending and do not flush", async () => {
    for (const stopReason of ["error", "aborted", "length", "toolUse"] as const) {
      const calls: unknown[] = [];
      const statuses: number[] = [];
      const result = await handleAgentEndLifecycle({
        enabled: true,
        pruneOn: "agent-message",
        messages: [assistant(stopReason)],
        pendingCount: 3,
        flush: async (options) => {
          calls.push(options);
        },
        setPendingStatus: (count) => statuses.push(count),
      });
      expect(result).toBe("kept-pending");
      expect(calls).toEqual([]);
      expect(statuses).toEqual([3]);
    }
  });

  test("omp continuation keeps pending even for a successful final reply", async () => {
    const calls: unknown[] = [];
    const statuses: number[] = [];
    const result = await handleAgentEndLifecycle({
      enabled: true,
      pruneOn: "agent-message",
      messages: [assistant("stop", "done")],
      pendingCount: 4,
      willContinue: true,
      flush: async (options) => {
        calls.push(options);
      },
      setPendingStatus: (count) => statuses.push(count),
    });

    expect(result).toBe("kept-pending");
    expect(calls).toEqual([]);
    expect(statuses).toEqual([4]);
  });

  test("later successful request after an unsuccessful run flushes retained pending", async () => {
    const calls: unknown[] = [];
    let pendingCount = 2;

    const failed = await handleAgentEndLifecycle({
      enabled: true,
      pruneOn: "agent-message",
      messages: [assistant("error")],
      pendingCount,
      flush: async () => {
        calls.push("should-not-run");
      },
      setPendingStatus: (count) => {
        pendingCount = count;
      },
    });
    expect(failed).toBe("kept-pending");
    expect(calls).toEqual([]);
    expect(pendingCount).toBe(2);

    const success = await handleAgentEndLifecycle({
      enabled: true,
      pruneOn: "agent-message",
      messages: [assistant("stop", "retry ok")],
      pendingCount,
      flush: async (options) => {
        calls.push(options);
        pendingCount = 0;
      },
      setPendingStatus: () => {
        throw new Error("should not set pending on successful flush path");
      },
    });
    expect(success).toBe("flushed");
    expect(calls).toEqual([{ delivery: "session", signal: undefined }]);
    expect(pendingCount).toBe(0);
  });

  test("disabled or non-agent-message modes do not auto-flush on agent_end", async () => {
    const calls: unknown[] = [];
    const disabled = await handleAgentEndLifecycle({
      enabled: false,
      pruneOn: "agent-message",
      messages: [assistant("stop")],
      pendingCount: 1,
      flush: async (options) => {
        calls.push(options);
      },
      setPendingStatus: () => {},
    });
    expect(disabled).toBe("idle");

    const everyTurn = await handleAgentEndLifecycle({
      enabled: true,
      pruneOn: "every-turn",
      messages: [assistant("stop")],
      pendingCount: 1,
      flush: async (options) => {
        calls.push(options);
      },
      setPendingStatus: () => {},
    });
    expect(everyTurn).toBe("kept-pending");
    expect(calls).toEqual([]);
  });
});
