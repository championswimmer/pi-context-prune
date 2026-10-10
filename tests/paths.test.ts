import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDir, contextPruneDir, getSettingsPath } from "../src/paths.ts";

const ORIGINAL = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OMP_CODING_AGENT_DIR: process.env.OMP_CODING_AGENT_DIR,
  PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearEnv(): void {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_CODING_AGENT_DIR;
  delete process.env.PI_CONFIG_DIR;
}

describe("agentDir resolution", () => {
  test("PI_CODING_AGENT_DIR wins verbatim for both hosts", () => {
    clearEnv();
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent-dir";
    expect(agentDir()).toBe("/tmp/custom-agent-dir");
    expect(getSettingsPath()).toBe("/tmp/custom-agent-dir/context-prune/settings.json");
  });

  test("OMP_CODING_AGENT_DIR is honored when the pi-style var is absent", () => {
    clearEnv();
    process.env.OMP_CODING_AGENT_DIR = "/tmp/omp-agent-dir";
    expect(agentDir()).toBe("/tmp/omp-agent-dir");
  });

  test("falls back to <home>/<configDir>/agent", () => {
    clearEnv();
    // Assert shape, not an absolute path: homedir() differs between CI and a dev box.
    const baseParts = agentDir().split("/");
    expect(baseParts.at(-1)).toBe("agent");
    expect(baseParts.at(-2)).toBe(".omp");

    process.env.PI_CONFIG_DIR = "custom-root";
    expect(agentDir()).toBe(join(homedir(), "custom-root", "agent"));
  });

  test("PI_CONFIG_DIR cannot escape home via path segments", () => {
    clearEnv();
    process.env.PI_CONFIG_DIR = "../../etc";
    expect(agentDir()).toBe(join(homedir(), "etc", "agent"));
  });

  test("settings path is resolved per call, not frozen at import", () => {
    clearEnv();
    process.env.PI_CODING_AGENT_DIR = "/tmp/first";
    const first = getSettingsPath();
    process.env.PI_CODING_AGENT_DIR = "/tmp/second";
    const second = getSettingsPath();
    expect(first).not.toBe(second);
    expect(second).toBe("/tmp/second/context-prune/settings.json");
    expect(contextPruneDir()).toBe("/tmp/second/context-prune");
  });
});
