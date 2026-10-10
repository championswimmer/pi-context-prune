import { describe, expect, test } from "bun:test";
import { appendAgenticAutoPrompt } from "../src/system-prompt.ts";
import { AGENTIC_AUTO_SYSTEM_PROMPT } from "../src/types.ts";

describe("appendAgenticAutoPrompt", () => {
  test("omp array prompt gets one extra element, preserving Markdown sections", () => {
    const result = appendAgenticAutoPrompt(["# A", "paragraph, with comma"]);
    expect(result.systemPrompt).toEqual(["# A", "paragraph, with comma", AGENTIC_AUTO_SYSTEM_PROMPT]);
  });

  test("pi string prompt is newline-joined, never comma-joined", () => {
    const result = appendAgenticAutoPrompt("# Rules");
    expect(result.systemPrompt).toBe(`# Rules\n\n${AGENTIC_AUTO_SYSTEM_PROMPT}`);
  });

  test("empty or missing prompt yields just the appended block", () => {
    expect(appendAgenticAutoPrompt("").systemPrompt).toBe(AGENTIC_AUTO_SYSTEM_PROMPT);
    expect(appendAgenticAutoPrompt(undefined).systemPrompt).toBe(AGENTIC_AUTO_SYSTEM_PROMPT);
  });
});
