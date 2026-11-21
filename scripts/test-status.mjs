import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
const { SETTINGS_PATH, loadConfig, loadConfigWithMeta, saveConfig, patchConfig } = await import(pathToFileURL(join(temp, 'config.mjs')));
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

test('batchExecution defaults to parallel, rejects invalid values, and persists both choices', async () => {
  assert.equal(DEFAULT_CONFIG.batchExecution, 'parallel');
  for (const value of [undefined, null, 'sequential', 1, true, 'parallel']) {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ batchExecution: value }));
    assert.equal((await loadConfig()).batchExecution, 'parallel');
  }
  for (const batchExecution of ['parallel', 'serial']) {
    await saveConfig({ ...config, batchExecution });
    assert.equal((await loadConfig()).batchExecution, batchExecution);
  }
});

test('v2.x -> v3 in-place migration converts legacy fields and cleans up defaults', async () => {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });

  // 1. Explicit model + thinking level -> object format + removes summarizerThinking on persistMigration
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    summarizerModel: 'anthropic/claude-haiku-4-5',
    summarizerThinking: 'low',
    enabled: true,
  }));
  const preview = await loadConfigWithMeta({ persistMigration: false });
  assert.deepEqual(preview.effective.summarizerModel, {
    model: 'anthropic/claude-haiku-4-5',
    thinkingLevel: 'low',
  });
  assert.equal(preview.effective.enabled, true);
  assert.deepEqual(preview.migratedScopes, ['global']);

  const persisted1 = await loadConfigWithMeta({ persistMigration: true });
  assert.deepEqual(persisted1.migratedScopes, ['global']);
  const raw1 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  assert.deepEqual(raw1.summarizerModel, {
    model: 'anthropic/claude-haiku-4-5',
    thinkingLevel: 'low',
  });
  assert.equal(raw1.enabled, true);
  assert.equal('summarizerThinking' in raw1, false);

  // 2. Explicit model + legacy "default" thinking -> migrates thinking to "off"
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    summarizerModel: 'anthropic/claude-haiku-4-5',
    summarizerThinking: 'default',
  }));
  const persisted2 = await loadConfigWithMeta({ persistMigration: true });
  assert.deepEqual(persisted2.effective.summarizerModel, {
    model: 'anthropic/claude-haiku-4-5',
    thinkingLevel: 'off',
  });
  assert.deepEqual(persisted2.migratedScopes, ['global']);
  const raw2 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  assert.deepEqual(raw2.summarizerModel, {
    model: 'anthropic/claude-haiku-4-5',
    thinkingLevel: 'off',
  });
  assert.equal('summarizerThinking' in raw2, false);

  // 3. "default" model + thinking -> migrates to null, removes summarizerThinking, deletes empty file
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    summarizerModel: 'default',
    summarizerThinking: 'low',
  }));
  const persisted3 = await loadConfigWithMeta({ persistMigration: true });
  assert.equal(persisted3.effective.summarizerModel, null);
  assert.deepEqual(persisted3.migratedScopes, ['global']);
  assert.equal(existsSync(SETTINGS_PATH), false);

  // 4. Already-v3 file -> reports migratedScopes: []
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    summarizerModel: { model: 'openai/gpt-5-mini', thinkingLevel: 'low' },
  }));
  const alreadyV3 = await loadConfigWithMeta({ persistMigration: true });
  assert.deepEqual(alreadyV3.effective.summarizerModel, {
    model: 'openai/gpt-5-mini',
    thinkingLevel: 'low',
  });
  assert.deepEqual(alreadyV3.migratedScopes, []);
});

test('global + project layering respects trustedProject and patchConfig scope rules', async () => {
  const projectDir = join(temp, 'project');
  const projectSettingsPath = join(projectDir, '.pi', 'context-prune', 'settings.json');
  mkdirSync(dirname(projectSettingsPath), { recursive: true });

  await saveConfig({ ...DEFAULT_CONFIG, enabled: true, pruneOn: 'every-turn' });
  writeFileSync(projectSettingsPath, JSON.stringify({
    enabled: false,
    batchExecution: 'serial',
  }));

  // Untrusted project: project file is completely ignored
  const untrusted = await loadConfig({ cwd: projectDir, trustedProject: false });
  assert.equal(untrusted.enabled, true);
  assert.equal(untrusted.pruneOn, 'every-turn');
  assert.equal(untrusted.batchExecution, 'parallel');

  // Trusted project: project overrides global
  const trusted = await loadConfig({ cwd: projectDir, trustedProject: true });
  assert.equal(trusted.enabled, false);
  assert.equal(trusted.pruneOn, 'every-turn');
  assert.equal(trusted.batchExecution, 'serial');

  // patchConfig writes to global by default when patched key has no project override
  const globalPatch = await patchConfig({ pruneOn: 'on-demand' }, { cwd: projectDir, trustedProject: true });
  assert.equal(globalPatch.scope, 'global');
  assert.equal(globalPatch.config.pruneOn, 'on-demand');
  const globalAfter1 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const projectAfter1 = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
  assert.equal(globalAfter1.pruneOn, 'on-demand');
  assert.equal('pruneOn' in projectAfter1, false);

  // patchConfig writes to project scope when trustedProject is true and key already has a project override
  const projectPatch = await patchConfig({ batchExecution: 'parallel' }, { cwd: projectDir, trustedProject: true });
  assert.equal(projectPatch.scope, 'project');
  assert.equal(projectPatch.config.batchExecution, 'parallel');
  const globalAfter2 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const projectAfter2 = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
  assert.equal(globalAfter2.pruneOn, 'on-demand');
  assert.equal(projectAfter2.enabled, false);
  assert.equal('batchExecution' in projectAfter2, false);
});
