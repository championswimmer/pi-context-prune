import { AGENTIC_AUTO_SYSTEM_PROMPT } from "./types.js";

/**
 * Append the agentic-auto instructions to a host-provided system prompt.
 *
 * pi hands us a `string`; omp hands us a `string[]` and expects an array back.
 * Coercing the array with a template literal would comma-join it and break the
 * prompt's Markdown sections, so the host shape decides the return shape.
 */
export function appendAgenticAutoPrompt(systemPrompt: unknown): { systemPrompt: string } | { systemPrompt: string[] } {
  if (Array.isArray(systemPrompt)) {
    return { systemPrompt: [...(systemPrompt as string[]), AGENTIC_AUTO_SYSTEM_PROMPT] };
  }
  const original = typeof systemPrompt === "string" ? systemPrompt : "";
  return { systemPrompt: original ? `${original}\n\n${AGENTIC_AUTO_SYSTEM_PROMPT}` : AGENTIC_AUTO_SYSTEM_PROMPT };
}
