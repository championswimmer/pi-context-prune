import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Keep settings tests isolated from the user's real Pi configuration.
const temp = mkdtempSync(join(process.cwd(), 'node_modules', '.pruner-status-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(temp, 'agent');
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(temp, { recursive: true, force: true });
});
await build({
  entryPoints: ['src/commands.ts', 'src/config.ts', 'src/types.ts'],
  outdir: temp, bundle: true, platform: 'node', format: 'esm',
  external: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
  outExtension: { '.js': '.mjs' },
});
const { pruneStatusText, setPruneStatusWidget, pendingTurnsText } = await import(pathToFileURL(join(temp, 'commands.mjs')));
const { DEFAULT_CONFIG, STATUS_WIDGET_ID } = await import(pathToFileURL(join(temp, 'types.mjs')));
const { SETTINGS_PATH, loadConfig, saveConfig } = await import(pathToFileURL(join(temp, 'config.mjs')));
const stats = { totalInputTokens: 1200, totalOutputTokens: 340, totalCost: .003, callCount: 1 };
const config = { ...DEFAULT_CONFIG, enabled: true, pruneOn: 'every-turn' };

test('status-only footer uses scissors and omits tokens/cost, even with usage', () => {
  const plain = { ...config, showPruneStatusCost: false };
  assert.equal(pruneStatusText(plain, stats), '✂ ON (Every turn)');
  assert.equal(pruneStatusText({ ...plain, enabled: false }, stats), '✂ OFF (Every turn)');
});

test('status + cost shows tokens/cost only after a summarizer call', () => {
  assert.equal(pruneStatusText(config, stats), '✂ ON (Every turn) │ ↑1.2k ↓340 $0.003');
  assert.equal(pruneStatusText(config), '✂ ON (Every turn)');
  assert.equal(pruneStatusText(config, { ...stats, callCount: 0 }), '✂ ON (Every turn)');
});

test('all footer modes apply to pending and summarizing states as well as idle', () => {
  const calls = [];
  const ctx = { ui: { setStatus: (...args) => calls.push(args) } };
  for (const state of [undefined, pendingTurnsText(config, 3), 'summarizing…']) {
    for (const showPruneStatusCost of [true, false]) {
      const cfg = { ...config, showPruneStatusCost };
      setPruneStatusWidget(ctx, cfg, state ?? stats, stats);
      assert.deepEqual(calls.at(-1), [STATUS_WIDGET_ID, pruneStatusText(cfg, stats, state)]);
      setPruneStatusWidget(ctx, { ...cfg, showPruneStatusLine: false }, state ?? stats, stats);
      assert.deepEqual(calls.at(-1), [STATUS_WIDGET_ID, undefined]);
    }
  }
});

test('settings retain old visibility and default missing/invalid cost flags to true', async () => {
  assert.ok(SETTINGS_PATH.startsWith(temp));
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  for (const showPruneStatusLine of [true, false]) {
    for (const cost of [undefined, 'false', null, 0]) {
      writeFileSync(SETTINGS_PATH, JSON.stringify({ showPruneStatusLine, showPruneStatusCost: cost }));
      const cfg = await loadConfig();
      assert.equal(cfg.showPruneStatusLine, showPruneStatusLine);
      assert.equal(cfg.showPruneStatusCost, true);
    }
  }
});

test('all three settings modes survive save/reload', async () => {
  for (const [showPruneStatusLine, showPruneStatusCost] of [[false, false], [true, false], [true, true]]) {
    await saveConfig({ ...config, showPruneStatusLine, showPruneStatusCost });
    const cfg = await loadConfig();
    assert.equal(cfg.showPruneStatusLine, showPruneStatusLine);
    assert.equal(cfg.showPruneStatusCost, showPruneStatusCost);
  }
});

test('Unicode and Nerd Font icons cover all counts and footer modes', () => {
  const calls = [];
  const ctx = { ui: { setStatus: (...args) => calls.push(args) } };
  for (const useNerdFontIcons of [false, true]) {
    const scissors = useNerdFontIcons ? '\uf0c4' : '✂';
    const turns = useNerdFontIcons ? '\uf021' : '↻';
    for (const showPruneStatusCost of [false, true]) {
      const cfg = { ...config, useNerdFontIcons, showPruneStatusCost };
      const suffix = showPruneStatusCost ? ' │ ↑1.2k ↓340 $0.003' : '';
      assert.equal(pruneStatusText(cfg, stats), `${scissors} ON (Every turn)${suffix}`);
      for (const count of [0, 1, 3]) {
        const pending = pendingTurnsText(cfg, count);
        assert.equal(pending, `${count} ${turns} pending`);
        setPruneStatusWidget(ctx, cfg, pending, stats);
        assert.deepEqual(calls.at(-1), [STATUS_WIDGET_ID, `${scissors} ${count} ${turns} pending${suffix}`]);
        setPruneStatusWidget(ctx, { ...cfg, showPruneStatusLine: false }, pending, stats);
        assert.deepEqual(calls.at(-1), [STATUS_WIDGET_ID, undefined]);
      }
      setPruneStatusWidget(ctx, cfg, 'summarizing…', stats);
      assert.deepEqual(calls.at(-1), [STATUS_WIDGET_ID, `${scissors} summarizing…${suffix}`]);
    }
  }
});

test('Nerd Font settings default off, reject invalid values, and persist both choices', async () => {
  assert.equal(DEFAULT_CONFIG.useNerdFontIcons, false);
  for (const value of [undefined, null, 'true', 1, false, true]) {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ useNerdFontIcons: value }));
    assert.equal((await loadConfig()).useNerdFontIcons, value === true);
  }
  for (const useNerdFontIcons of [false, true]) {
    await saveConfig({ ...config, useNerdFontIcons });
    assert.equal((await loadConfig()).useNerdFontIcons, useNerdFontIcons);
  }
});
