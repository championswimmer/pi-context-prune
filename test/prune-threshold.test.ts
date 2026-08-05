import test from "node:test";
import assert from "node:assert/strict";
import {
  batchRawCharCount,
  isBelowRawCharThreshold,
  computeFlushOutcome,
  quantizeRawCharThreshold,
} from "../src/prune-threshold.ts";
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

test("isBelowRawCharThreshold is disabled when threshold is 0", () => {
  assert.equal(isBelowRawCharThreshold(makeBatch(["x"]), 0), false);
  assert.equal(isBelowRawCharThreshold(makeBatch([]), 0), false);
});

test("isBelowRawCharThreshold uses an inclusive boundary", () => {
  // Exactly at the threshold -> NOT below (should be summarized).
  assert.equal(isBelowRawCharThreshold(makeBatch(["abc"]), 3), false);
  assert.equal(isBelowRawCharThreshold(makeBatch(["ab"]), 3), true);
});

test("isBelowRawCharThreshold skips empty-result batches under a threshold", () => {
  assert.equal(isBelowRawCharThreshold(makeBatch([""]), 1), true);
  assert.equal(isBelowRawCharThreshold(makeBatch([""]), 0), false);
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

test("quantizeRawCharThreshold snaps to the nearest 100-char step", () => {
  assert.equal(quantizeRawCharThreshold(0), 0);
  assert.equal(quantizeRawCharThreshold(300), 300);
  assert.equal(quantizeRawCharThreshold(349), 300);
  assert.equal(quantizeRawCharThreshold(350), 400);
  assert.equal(quantizeRawCharThreshold(50), 100);
  assert.equal(quantizeRawCharThreshold(1234), 1200);
  // invalid -> disabled
  assert.equal(quantizeRawCharThreshold(-5), 0);
  assert.equal(quantizeRawCharThreshold(NaN), 0);
  assert.equal(quantizeRawCharThreshold(Infinity), 0);
});
