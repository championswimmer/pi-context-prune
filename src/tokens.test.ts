import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSavings,
  countTextBlocksTokens,
  countTokens,
  estimateTokens,
  formatTokenMetrics,
} from "./tokens.ts";

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

test("countTokens falls back when model.countTokens returns a promise", async () => {
  assert.equal(countTokens("abc", { countTokens: () => Promise.resolve(7) }), 1);
  await Promise.resolve();
});

test("countTokens suppresses async tokenizer rejections and falls back", async () => {
  assert.equal(
    countTokens("abc", {
      countTokens: () => Promise.reject(new Error("boom")),
    }),
    1,
  );
  await Promise.resolve();
});

test("countTokens uses model.tokenize array length when available", () => {
  assert.equal(countTokens("abc", { tokenize: () => [1, 2, 3, 4] }), 4);
});

test("countTextBlocksTokens rounds once on aggregated fallback text", () => {
  assert.equal(countTextBlocksTokens(["a", "a", "a", "a", "a"]), 2);
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

test("formatTokenMetrics uses saved wording for positive savings", () => {
  assert.equal(
    formatTokenMetrics(computeSavings(100, 25)),
    "≈ 25 summary vs 100 raw tokens, saved 75 (75.0%)",
  );
});

test("formatTokenMetrics uses no-change wording for flat savings", () => {
  assert.equal(
    formatTokenMetrics(computeSavings(100, 100)),
    "≈ 100 summary vs 100 raw tokens, no token change (0.0%)",
  );
});

test("formatTokenMetrics uses grew-by wording for negative savings", () => {
  assert.equal(
    formatTokenMetrics(computeSavings(100, 150)),
    "≈ 150 summary vs 100 raw tokens, grew by 50 (-50.0%)",
  );
});
