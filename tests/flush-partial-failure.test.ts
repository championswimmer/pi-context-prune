import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");

describe("flushPending partial-failure handling (wiring)", () => {
  test("prepared summary cache exists and is cleared on session/branch change", () => {
    expect(SRC).toContain("preparedSummaryCache");
    // Cleared on session_start
    expect(SRC.match(/preparedSummaryCache\.clear\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("summarizeOne checks cache before calling LLM", () => {
    expect(SRC).toContain("preparedSummaryCache.get(key)");
    expect(SRC).toContain("if (cached) return cached");
  });

  test("successful summaries are stored in cache before commit", () => {
    expect(SRC).toContain("preparedSummaryCache.set(key, result)");
  });

  test("committed summaries are removed from cache", () => {
    expect(SRC).toContain("preparedSummaryCache.delete(");
  });

  test("commit loop does not break on first null — collects failedIndices", () => {
    expect(SRC).toContain("failedIndices");
    expect(SRC).toContain("failedIndices.push(i)");
    // The old break-on-first-null behavior must be gone
    expect(SRC).not.toContain("firstFailureIndex = i;\n          break");
  });

  test("only failed batches are restored, not everything after the first failure", () => {
    expect(SRC).toContain("failedBatches");
    expect(SRC).toContain("restoreBatches(failedBatches)");
    // Old slice-based restore must be gone
    expect(SRC).not.toContain("restoreBatches(batches.slice(firstFailureIndex))");
  });

  test("frontier stops short of the first failure (contiguous prefix)", () => {
    expect(SRC).toContain("frontierBatch");
    expect(SRC).toContain("firstFailureOriginalIndex");
    expect(SRC).toContain("batches.indexOf(pb) < firstFailureOriginalIndex");
  });
});
