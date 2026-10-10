import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Host-aware resolution of the agent config directory.
 *
 * Both hosts expose the same contract (mirrored from pi's `getAgentDir()` and
 * omp's `getAgentDir()`):
 *   1. `PI_CODING_AGENT_DIR` — full agent-dir override.
 *   2. `<home>/<configDirName>/agent` — fallback, where omp additionally reads
 *      `PI_CONFIG_DIR` for the directory name.
 *
 * omp ships as a Bun-compiled binary, so `process.versions.bun` cleanly marks a
 * runtime where the `.omp` defaults apply; anything else keeps pi's `.pi`
 * behavior. Everything is resolved per call so tests and profile switches that
 * mutate the environment after import still land in the right directory.
 */

function isOmpHost(): boolean {
  return typeof (process.versions as Record<string, unknown>).bun === "string";
}

/** Default config dirname under home: omp allows `PI_CONFIG_DIR`, pi is fixed `.pi`. */
function configDirName(): string {
  if (!isOmpHost()) return ".pi";
  const raw = process.env.PI_CONFIG_DIR;
  if (!raw) return ".omp";
  // Keep it a single relative segment: an absolute/`..` value must not escape home.
  const name = basename(raw);
  return name && name !== "." && name !== ".." ? name : ".omp";
}

/** Active agent config directory (e.g. `~/.omp/agent`). */
export function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR ?? process.env.OMP_CODING_AGENT_DIR;
  if (override) return override;
  return join(homedir(), configDirName(), "agent");
}

/** This extension's own data directory under the active agent directory. */
export function contextPruneDir(): string {
  return join(agentDir(), "context-prune");
}

/** Absolute path to the persisted settings file (resolved at call time). */
export function getSettingsPath(): string {
  return join(contextPruneDir(), "settings.json");
}
