import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

export const MAX_USAGE_LOG_BYTES = 16 * 1024 * 1024;

const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;

// pi-stats v1 expects a flat, non-negative usage object, not Pi's nested cost.
export function normalizeUsage(usage: Usage) {
  return {
    input: finite(usage.input), output: finite(usage.output),
    cacheRead: finite(usage.cacheRead), cacheWrite: finite(usage.cacheWrite),
    reasoning: finite((usage as Usage & { reasoning?: number }).reasoning),
    cost: finite(usage.cost?.total),
  };
}

export interface UsageLogRecord {
  v: 1;
  id: string;
  ts: string;
  source: "context-prune";
  label: "summarizer";
  provider: string;
  model: string;
  usage: ReturnType<typeof normalizeUsage>;
  sessionId: string;
  usageEntryId?: string;
  kind: "context_prune";
}

export function appendUsageLog(record: UsageLogRecord, directory = join(getAgentDir(), "context-prune")): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "usage.jsonl");
  const line = JSON.stringify(record) + "\n";
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (size + Buffer.byteLength(line) > MAX_USAGE_LOG_BYTES && size > 0) {
    renameSync(path, path + ".1");
  }
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export { randomUUID };
