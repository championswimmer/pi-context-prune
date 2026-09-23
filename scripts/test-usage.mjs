import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const temp = mkdtempSync(join(process.cwd(), 'node_modules', '.pruner-usage-'));
await build({ entryPoints: ['src/usage-report.ts', 'src/usage-log.ts', 'src/summarizer.ts'],
  outdir: temp, bundle: true, platform: 'node', format: 'esm', packages: 'external', outExtension: { '.js': '.mjs' } });
const report = await import(pathToFileURL(join(temp, 'usage-report.mjs')));
const log = await import(pathToFileURL(join(temp, 'usage-log.mjs')));
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

test('one usage report for a paid oversized summary, shared id and sidecar shape', async () => {
  const { ctx } = context([response()]);
  const entries = [];
  const dir = join(temp, 'sidecar');
  const session = { getSessionId: () => 'session-1', appendUsage: (...args) => {
    entries.push(args); return { id: 'entry-1', timestamp: '2026-01-01T00:00:00Z' }; } };
  const result = await summarizeBatch(batch(), config, ctx, { onUsage: msg => report.reportSummarizerUsage(session, msg, batch(), () => {}, rec => log.appendUsageLog(rec, dir)) });
  assert.ok(result.summaryText.length > batch().toolCalls[0].resultText.length);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], ['context_prune', 'anthropic', 'actual-model', usage, 'summarizer call: 1 tool calls (turn 3)']);
  const record = JSON.parse(readFileSync(join(dir, 'usage.jsonl'), 'utf8'));
  assert.equal(record.id, 'session-1:entry-1');
  assert.equal(record.ts, '2026-01-01T00:00:00Z');
  assert.equal(record.usage.cost, .33);
  assert.equal(record.usageEntryId, 'entry-1');
  assert.equal(record.kind, 'context_prune');
  assert.equal(statSync(join(dir, 'usage.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
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

test('real Pi in-memory session stores a context-free usage entry', () => {
  const session = SessionManager.inMemory();
  const records = [];
  report.reportSummarizerUsage(session, response(), batch(), () => {}, r => records.push(r));
  const entry = session.getBranch()[0];
  assert.equal(entry.type, 'usage');
  assert.equal(entry.kind, 'context_prune');
  assert.equal(entry.usage.cost.total, .33);
  assert.equal(records[0].id, `${session.getSessionId()}:${entry.id}`);
});

test('fallback, rotation, normalization and I/O failures', () => {
  const records = [];
  const session = { getSessionId: () => 's' };
  report.reportSummarizerUsage(session, response(), batch(), () => {}, r => records.push(r));
  assert.match(records[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(records[0].usageEntryId, undefined);
  assert.equal(log.normalizeUsage({ ...usage, input: -1, output: Infinity, cost: { total: NaN } }).input, 0);
  const dir = join(temp, 'rotate');
  log.appendUsageLog(records[0], dir);
  writeFileSync(join(dir, 'usage.jsonl'), 'z'.repeat(log.MAX_USAGE_LOG_BYTES));
  log.appendUsageLog(records[0], dir);
  assert.equal(statSync(join(dir, 'usage.jsonl.1')).size, log.MAX_USAGE_LOG_BYTES);
  assert.equal(readFileSync(join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').length, 1);
  const errors = [];
  report.reportSummarizerUsage({ ...session, appendUsage: () => { throw Error('no session'); } }, response(), batch(), e => errors.push(e), () => { throw Error('no disk'); });
  assert.equal(errors.length, 2);
});

process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
