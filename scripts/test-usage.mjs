import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const temp = mkdtempSync(join(process.cwd(), 'node_modules', '.pruner-usage-'));
const piAiShim = join(temp, 'pi-ai-shim.mjs');
writeFileSync(piAiShim, "export const normalizeContext = value => value;\n");
await build({
  entryPoints: ['src/usage-report.ts', 'src/summarizer.ts'],
  outdir: temp,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@earendil-works/pi-ai': piAiShim },
  external: ['@earendil-works/pi-coding-agent'],
  outExtension: { '.js': '.mjs' },
});
const report = await import(pathToFileURL(join(temp, 'usage-report.mjs')));
const { summarizeBatch, summarizeBatches } = await import(pathToFileURL(join(temp, 'summarizer.mjs')));
const usage = { input: 12, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 18,
  cost: { input: .1, output: .2, cacheRead: .03, cacheWrite: 0, total: .33 } };
const batch = (id = 'a') => ({ turnIndex: 3, timestamp: 0, assistantText: '', toolCalls: [{ toolCallId: id, toolName: 'bash', args: {}, resultText: 'x', isError: false }] });
const response = (stopReason = 'stop') => ({ role: 'assistant', provider: 'anthropic', model: 'test-model', responseModel: 'actual-model',
  content: [{ type: 'text', text: 'much longer than x' }], stopReason, usage });
const config = { summarizerModel: 'default', summarizerThinking: 'default' };
function context(responses) {
  let index = 0;
  const errors = [];
  const ctx = { model: { provider: 'anthropic' }, ui: { notify: (...args) => errors.push(args) },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'dummy' }), getProvider: () => ({
      stream: () => { const result = responses[index++]; return { async *[Symbol.asyncIterator]() {}, result: async () => result }; },
    }) } };
  return { ctx, errors };
}

test('one usage report for a paid oversized summary via appendUsage', async () => {
  const { ctx } = context([response()]);
  const entries = [];
  const session = { getSessionId: () => 'session-1', appendUsage: (...args) => {
    entries.push(args); return { id: 'entry-1', timestamp: '2026-01-01T00:00:00Z' }; } };
  const errors = [];
  const result = await summarizeBatch(batch(), config, ctx, { onUsage: msg => report.reportSummarizerUsage(session, msg, batch(), e => errors.push(e)) });
  assert.ok(result.summaryText.length > batch().toolCalls[0].resultText.length);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], ['context_prune', 'anthropic', 'actual-model', usage, 'summarizer call: 1 tool calls (turn 3)']);
  assert.equal(errors.length, 0);
});

test('response without usage is not reported', () => {
  const errors = [];
  const entries = [];
  const session = { getSessionId: () => 's', appendUsage: (...args) => { entries.push(args); } };
  report.reportSummarizerUsage(session, { ...response(), usage: undefined }, batch(), e => errors.push(e));
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 0);
});

test('error and subsequent parallel responses report even if first summary fails', async () => {
  const { ctx } = context([response('error'), response()]);
  const calls = [];
  const results = await summarizeBatches([batch('a'), batch('b')], config, ctx, { onUsage: (b, r) => calls.push([b.toolCalls[0].toolCallId, r.usage]) });
  assert.equal(results[0], null);
  assert.ok(results[1]);
  assert.deepEqual(calls.map(([id]) => id), ['a', 'b']);
});

test('aborted final response still reports usage, even if signal fires during stream', async () => {
  const controller = new AbortController();
  const { ctx } = context([response('aborted')]);
  const calls = [];
  await assert.rejects(summarizeBatch(batch(), config, ctx, { signal: controller.signal,
    onTextProgress: () => controller.abort(), onUsage: r => calls.push(r) }));
  // The provider returned a final response with usage despite cancellation.
  assert.equal(calls.length, 1);
  const { ctx: ctx2 } = context([response('aborted')]);
  const reports = [];
  assert.equal(await summarizeBatch(batch(), config, ctx2, { onUsage: r => reports.push(r) }), null);
  assert.equal(reports.length, 1);
});

test('real Pi in-memory session stores a context-free usage entry', (t) => {
  const session = SessionManager.inMemory();
  if (typeof session.appendUsage !== 'function') {
    t.skip('installed pi-coding-agent predates SessionManager.appendUsage');
    return;
  }
  const errors = [];
  report.reportSummarizerUsage(session, response(), batch(), e => errors.push(e));
  const entry = session.getBranch()[0];
  assert.equal(entry.type, 'usage');
  assert.equal(entry.kind, 'context_prune');
  assert.equal(entry.usage.cost.total, .33);
  assert.equal(errors.length, 0);
});

test('missing appendUsage is a silent no-op; throwing appendUsage notifies once', () => {
  const errors = [];
  report.reportSummarizerUsage({ getSessionId: () => 's' }, response(), batch(), e => errors.push(e));
  assert.equal(errors.length, 0);
  report.reportSummarizerUsage({ getSessionId: () => 's', appendUsage: () => { throw Error('no session'); } }, response(), batch(), e => errors.push(e));
  assert.equal(errors.length, 1);
});

process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
