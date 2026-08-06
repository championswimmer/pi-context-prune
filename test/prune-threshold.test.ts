import test from "node:test";
import assert from "node:assert/strict";
import {
  batchRawCharCount,
  batchRawTokenCount,
  isBelowRawTokenThreshold,
  computeFlushOutcome,
  quantizeRawTokenThreshold,
} from "../src/prune-threshold.ts";
import { countTokens } from "../src/tokens.ts";
import type { CapturedBatch } from "../src/types.ts";

function makeBatch(resultTexts: string[]): CapturedBatch {
  return {
    turnIndex: 0,
    timestamp: 0,
    assistantText: "",
    toolCalls: resultTexts.map((text, i) => ({
      toolCallId: `tc-${i}`,
      toolName: "tool",
      args: {},
      resultText: text,
      isError: false,
    })),
  };
}

test("batchRawCharCount sums all tool-result text lengths", () => {
  assert.equal(batchRawCharCount(makeBatch([])), 0);
  assert.equal(batchRawCharCount(makeBatch(["abc"])), 3);
  assert.equal(batchRawCharCount(makeBatch(["abc", "de", "f"])), 6);
});

test("batchRawTokenCount sums tool-result tokens (fallback chars/4)", () => {
  // countTokens falls back to ceil(len/4) when gpt-tokenizer isn't resolvable
  // in the test environment, so use strings whose token count is unambiguous.
  assert.equal(batchRawTokenCount(makeBatch([]), countTokens), 0);
  assert.equal(batchRawTokenCount(makeBatch(["abcd"]), countTokens), 1); // 4 chars -> 1 token
  assert.equal(batchRawTokenCount(makeBatch(["abcd", "abcdefgh"]), countTokens), 3); // 1 + 2
});

test("isBelowRawTokenThreshold is disabled when threshold is 0", () => {
  assert.equal(isBelowRawTokenThreshold(makeBatch(["x"]), 0, countTokens), false);
  assert.equal(isBelowRawTokenThreshold(makeBatch([]), 0, countTokens), false);
});

test("isBelowRawTokenThreshold: small batch below, large batch not below", () => {
  // "a" -> 1 token; threshold 50 -> below
  assert.equal(isBelowRawTokenThreshold(makeBatch(["a"]), 50, countTokens), true);
  // 4000 chars -> ceil(4000/4)=1000 tokens; threshold 50 -> not below
  const big = "x".repeat(4000);
  assert.equal(isBelowRawTokenThreshold(makeBatch([big]), 50, countTokens), false);
  // empty result under a positive threshold -> below
  assert.equal(isBelowRawTokenThreshold(makeBatch([""]), 1, countTokens), true);
  assert.equal(isBelowRawTokenThreshold(makeBatch([""]), 0, countTokens), false);
});

test("computeFlushOutcome maps every attainable count combination", () => {
  // (summarized, oversized, belowThreshold)
  assert.equal(computeFlushOutcome(2, 0, 0), "summarized");
  assert.equal(computeFlushOutcome(1, 1, 1), "summarized"); // at least one persisted -> summarized
  assert.equal(computeFlushOutcome(0, 0, 3), "skipped-below-threshold");
  assert.equal(computeFlushOutcome(0, 3, 0), "skipped-oversized");
  assert.equal(computeFlushOutcome(0, 1, 2), "skipped-mixed");
  assert.equal(computeFlushOutcome(0, 2, 1), "skipped-mixed");
});

test("computeFlushOutcome is order-independent within a single skip reason", () => {
  // one oversized alone vs one below alone
  assert.equal(computeFlushOutcome(0, 1, 0), "skipped-oversized");
  assert.equal(computeFlushOutcome(0, 0, 1), "skipped-below-threshold");
});

test("quantizeRawTokenThreshold snaps to the nearest 50-token step", () => {
  assert.equal(quantizeRawTokenThreshold(0), 0);
  assert.equal(quantizeRawTokenThreshold(50), 50);
  assert.equal(quantizeRawTokenThreshold(74), 50);
  assert.equal(quantizeRawTokenThreshold(75), 100);
  assert.equal(quantizeRawTokenThreshold(124), 100);
  assert.equal(quantizeRawTokenThreshold(125), 150);
  assert.equal(quantizeRawTokenThreshold(1234), 1250);
  // invalid -> disabled
  assert.equal(quantizeRawTokenThreshold(-5), 0);
  assert.equal(quantizeRawTokenThreshold(NaN), 0);
  assert.equal(quantizeRawTokenThreshold(Infinity), 0);
});

test("countTokens returns a positive estimate (real tokenizer or chars/4 fallback)", () => {
  const prose = "Use `context_tree_query` with these refs to retrieve the original full outputs.";
  const tokens = countTokens(prose);
  assert.ok(Number.isFinite(tokens) && tokens > 0, `got ${tokens}`);
  // fallback ceiling is chars/4; real tokenizer is close to that for prose, so
  // sanity-bound the result.
  assert.ok(tokens <= Math.ceil(prose.length / 3) + 8, `unexpectedly high: ${tokens}`);
  // code tokenizes denser than prose per char
  const code = "{ \"path\": \"/a/b/c.ts\", \"line\": 42 }";
  assert.ok(countTokens(code) > 0);
  assert.equal(countTokens(""), 0);
});
