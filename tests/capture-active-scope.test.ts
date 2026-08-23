import { describe, expect, test } from "bun:test";
import { captureUnindexedBatchesFromSession } from "../src/batch-capture.ts";
import type { CapturedBatch } from "../src/types.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function msgEntry(role: "user" | "assistant" | "toolResult", opts: Partial<{ toolCallId: string; toolName: string; calls: { id: string; name?: string }[]; text: string }>): any {
  if (role === "user") {
    return { type: "message", message: { role: "user", content: [{ type: "text", text: opts.text ?? "go" }] } };
  }
  if (role === "toolResult") {
    return {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: opts.toolCallId!,
        toolName: opts.toolName ?? "bash",
        content: [{ type: "text", text: opts.text ?? "result" }],
        isError: false,
      },
    };
  }
  return {
    type: "message",
    message: {
      role: "assistant",
      content: (opts.calls ?? []).map((c) => ({ type: "toolCall", id: c.id, name: c.name ?? "bash", input: {} })),
    },
  };
}

/** Build a branch: user → assistant(calls) → toolResults, returning the entry array. */
function branchWithTurn(calls: string[]): any[] {
  const entries: any[] = [];
  entries.push(msgEntry("user", {}));
  entries.push(msgEntry("assistant", { calls: calls.map((id) => ({ id })) }));
  for (const id of calls) entries.push(msgEntry("toolResult", { toolCallId: id }));
  return entries;
}

function capturedIds(batches: CapturedBatch[]): string[] {
  return batches.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId));
}

function emptyIndexer() {
  const summarized = new Set<string>();
  return { isSummarized: (id: string) => summarized.has(id) };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("captureUnindexedBatchesFromSession — activeToolCallIds scope", () => {
  test("no whitelist: captures all unsummarized (backward compat)", () => {
    const branch = branchWithTurn(["tc1", "tc2"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer());
    expect(capturedIds(batches).sort()).toEqual(["tc1", "tc2"]);
  });

  test("whitelist restricts to active ids only", () => {
    const branch = branchWithTurn(["tc1", "tc2", "tc3"]);
    const active = new Set(["tc1", "tc3"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer(), [], active);
    expect(capturedIds(batches).sort()).toEqual(["tc1", "tc3"]);
  });

  test("empty whitelist captures nothing", () => {
    const branch = branchWithTurn(["tc1", "tc2"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer(), [], new Set());
    expect(batches).toHaveLength(0);
  });

  test("already-summarized ids are excluded even if in whitelist", () => {
    const branch = branchWithTurn(["tc1", "tc2"]);
    const summarized = new Set(["tc1"]);
    const indexer = { isSummarized: (id: string) => summarized.has(id) };
    const batches = captureUnindexedBatchesFromSession(branch, indexer, [], new Set(["tc1", "tc2"]));
    expect(capturedIds(batches)).toEqual(["tc2"]);
  });

  test("turnIndex stays based on full branch, not whitelist", () => {
    // Two assistant turns; whitelist only includes turn 2's call.
    const branch = [
      ...branchWithTurn(["old"]),
      ...branchWithTurn(["new"]),
    ];
    const batches = captureUnindexedBatchesFromSession(
      branch,
      emptyIndexer(),
      [],
      new Set(["new"]),
    );
    expect(batches).toHaveLength(1);
    // turnCounter is 0-based over all assistant messages; "old" is turn 0, "new" is turn 1.
    expect(batches[0]!.turnIndex).toBe(1);
  });

  test("excludeToolNames still applies with whitelist", () => {
    const branch = [
      msgEntry("user", {}),
      msgEntry("assistant", { calls: [{ id: "context_prune_call", name: "context_prune" }, { id: "real" }] }),
      msgEntry("toolResult", { toolCallId: "context_prune_call" }),
      msgEntry("toolResult", { toolCallId: "real" }),
    ];
    const batches = captureUnindexedBatchesFromSession(
      branch,
      emptyIndexer(),
      ["context_prune"],
      new Set(["context_prune_call", "real"]),
    );
    expect(capturedIds(batches)).toEqual(["real"]);
  });
});

// ── Compaction / tree / fork scenarios via synthetic branch ──────────────────
//
// These model the real Pi semantics: getBranch() returns the full path,
// buildContextEntries() returns only entries after the latest compaction's
// firstKeptEntryId (plus the compaction entry itself).

function compactionEntry(firstKeptEntryId: string): any {
  return { type: "compaction", summary: "compacted", tokensBefore: 1000, firstKeptEntryId };
}

function entryId(type: string, id: string): any {
  return { type: "message", id, parentId: null, message: { role: type } };
}

describe("compaction-aware capture scenarios", () => {
  // Build a branch where tc_old is before compaction, tc_new is after.
  // buildContextEntries() would return [compaction, assistant_new, toolResult_new].
  function compactedBranch() {
    return [
      msgEntry("user", {}),
      msgEntry("assistant", { calls: [{ id: "tc_old" }] }),
      msgEntry("toolResult", { toolCallId: "tc_old", text: "old result" }),
      compactionEntry("e_after_compact"),
      msgEntry("assistant", { calls: [{ id: "tc_new" }] }),
      msgEntry("toolResult", { toolCallId: "tc_new", text: "new result" }),
    ];
  }

  test("compaction removes pre-compaction tool results from active scope", () => {
    const branch = compactedBranch();
    // Simulate buildContextEntries: only post-compaction entries are active.
    const active = new Set(["tc_new"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer(), [], active);
    expect(capturedIds(batches)).toEqual(["tc_new"]);
    expect(capturedIds(batches)).not.toContain("tc_old");
  });

  test("without whitelist (old behavior), pre-compaction result IS captured (the bug)", () => {
    const branch = compactedBranch();
    // Demonstrates the original bug: full branch scan captures tc_old.
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer());
    expect(capturedIds(batches)).toContain("tc_old");
  });

  test("multiple compactions — latest boundary wins", () => {
    const branch = [
      ...compactedBranch(),
      compactionEntry("e_after_second"),
      msgEntry("assistant", { calls: [{ id: "tc_newest" }] }),
      msgEntry("toolResult", { toolCallId: "tc_newest", text: "newest" }),
    ];
    const active = new Set(["tc_newest"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer(), [], active);
    expect(capturedIds(batches)).toEqual(["tc_newest"]);
  });

  test("/tree jump to sibling branch does not capture original branch results", () => {
    // Original branch has tc_a; sibling branch (current leaf) has tc_b.
    const branch = [
      ...branchWithTurn(["tc_a"]),
      // Current leaf path is the sibling — only tc_b is active.
      ...branchWithTurn(["tc_b"]),
    ];
    const active = new Set(["tc_b"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer(), [], active);
    expect(capturedIds(batches)).toEqual(["tc_b"]);
    expect(capturedIds(batches)).not.toContain("tc_a");
  });

  test("/tree jump back before compaction re-includes old results", () => {
    // When leaf is before the compaction entry, the path has no compaction,
    // so buildContextEntries returns the full path → old results are active again.
    const branch = compactedBranch();
    const active = new Set(["tc_old"]);
    const batches = captureUnindexedBatchesFromSession(branch, emptyIndexer(), [], active);
    expect(capturedIds(batches)).toEqual(["tc_old"]);
  });
});
