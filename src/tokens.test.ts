import assert from "node:assert/strict";
import test from "node:test";
import { computeSavings, countTokens, estimateTokens } from "./tokens.ts";

test("estimateTokens returns 0 for empty text", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens rounds short text up to one token", () => {
  assert.equal(estimateTokens("hi"), 1);
});

test("estimateTokens is deterministic for medium text", () => {
  assert.equal(estimateTokens("the quick brown fox"), 5);
});

test("estimateTokens scales linearly for larger blocks", () => {
  assert.equal(estimateTokens("a".repeat(512)), 128);
});

test("countTokens falls back to the estimator when no model is provided", () => {
  assert.equal(countTokens("abc"), 1);
});

test("countTokens uses model.countTokens when available", () => {
  assert.equal(countTokens("abc", { countTokens: () => 7 }), 7);
});

test("countTokens falls back when model.countTokens throws", () => {
  assert.equal(
    countTokens("abc", {
      countTokens: () => {
        throw new Error("boom");
      },
    }),
    1,
  );
});

test("countTokens uses model.tokenize array length when available", () => {
  assert.equal(countTokens("abc", { tokenize: () => [1, 2, 3, 4] }), 4);
});

test("computeSavings returns zero ratio for empty raw input", () => {
  assert.deepEqual(computeSavings(0, 0), {
    rawTokenCount: 0,
    summaryTokenCount: 0,
    tokensSaved: 0,
    savingsRatio: 0,
  });
});

test("computeSavings returns positive savings for smaller summaries", () => {
  assert.deepEqual(computeSavings(100, 25), {
    rawTokenCount: 100,
    summaryTokenCount: 25,
    tokensSaved: 75,
    savingsRatio: 0.75,
  });
});

test("computeSavings returns negative savings when summaries are larger", () => {
  assert.deepEqual(computeSavings(100, 150), {
    rawTokenCount: 100,
    summaryTokenCount: 150,
    tokensSaved: -50,
    savingsRatio: -0.5,
  });
});
