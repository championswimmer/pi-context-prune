import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

describe("agentic-auto summary delivery wiring", () => {
  test("session index persistence publishes runtime records only after append succeeds", () => {
    const helper = source.match(
      /const persistBatchIndex = [\s\S]*?\n  \};/,
    )?.[0];

    expect(helper).toBeDefined();
    const appendAt = helper!.indexOf("appendEntry(CUSTOM_TYPE_INDEX");
    const publishAt = helper!.indexOf("indexer.getIndex().set");
    expect(appendAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(appendAt);
  });

  test("persists without steer and injects during context build for all modes", () => {
    const branch = source.match(
      /if \(delivery === "runtime" && currentConfig\.value\.pruneOn === "agentic-auto"\) \{([\s\S]*?)\} else if \(delivery === "runtime"\)/,
    )?.[1];

    expect(branch).toBeDefined();
    expect(branch).toContain("appendCustomMessageEntry");
    expect(branch).toContain("indexer.addBatch");
    expect(branch).toContain("indexer.recordSummary");
    expect(branch).not.toContain("sendMessage");
    expect(branch).not.toContain("deliverAs");
    expect(source).toContain(
      "pruneMessages(messages, indexer, currentConfig.value.pruneOn)",
    );
    expect(source).toContain("injectSummaries(messages, indexer)");
    // Injection must not be gated to agentic-auto: session-delivered summaries
    // (agent-message/every-turn) never reach the live context otherwise.
    const injectBlock = source.match(
      /Inject committed batch summaries[\s\S]*?injectSummaries\(messages, indexer\)/,
    )?.[0];
    expect(injectBlock).toBeDefined();
    expect(injectBlock).not.toContain("agentic-auto");
  });
});
