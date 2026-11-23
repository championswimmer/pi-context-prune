import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import * as report from '../dist/src/usage-report.js';
import {
  summarizeBatch,
  summarizeBatches,
  summarizerThinkingOptions,
  resolveModel,
} from '../dist/src/summarizer.js';
const usage = { input: 12, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 18,
  cost: { input: .1, output: .2, cacheRead: .03, cacheWrite: 0, total: .33 } };
const batch = (id = 'a') => ({ turnIndex: 3, timestamp: 0, assistantText: '', toolCalls: [{ toolCallId: id, toolName: 'bash', args: {}, resultText: 'x', isError: false }] });
const response = (stopReason = 'stop') => ({ role: 'assistant', provider: 'anthropic', model: 'test-model', responseModel: 'actual-model',
  content: [{ type: 'text', text: 'much longer than x' }], stopReason, usage });
const config = { summarizerModel: null };
function context(responses, delayMs = 0) {
  let index = 0, active = 0, maxActive = 0;
  const errors = [], events = [];
  const ctx = { model: { provider: 'anthropic' }, ui: { notify: (...args) => errors.push(args) },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'dummy' }), getProvider: () => ({
      stream: () => {
        const call = index++;
        const result = responses[call];
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${call}`);
        return {
          async *[Symbol.asyncIterator]() { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); },
          result: async () => { active--; events.push(`end:${call}`); return result; },
        };
      },
    }) } };
  return { ctx, errors, events, stats: () => ({ calls: index, maxActive }) };
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
  const results = await summarizeBatches(
    [batch('a'), batch('b')],
    { ...config, batchExecution: 'parallel' },
    ctx,
    { onUsage: (b, r) => calls.push([b.toolCalls[0].toolCallId, r.usage]) },
  );
  assert.equal(results[0], null);
  assert.ok(results[1]);
  assert.deepEqual(calls.map(([id]) => id), ['a', 'b']);
});

test('summarizeBatches runs serially when batchExecution is serial and stops after failure', async () => {
  const { ctx, events, stats } = context([response(), response(), response()], 10);
  const progress = [];
  const results = await summarizeBatches(
    [batch('a'), batch('b'), batch('c')],
    { ...config, batchExecution: 'serial' },
    ctx,
    { onProgress: (index, _total, _batch, stage) => progress.push(`${index}:${stage}`) },
  );
  assert.equal(results.length, 3);
  assert.ok(results.every(Boolean));
  assert.equal(stats().maxActive, 1);
  assert.deepEqual(events, ['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2']);
  assert.deepEqual(progress, ['0:start', '0:done', '1:start', '1:done', '2:start', '2:done']);

  // On failure in serial mode, stop before starting later batches and preserve array length.
  const failRun = context([response('error'), response()]);
  const failResults = await summarizeBatches([batch('a'), batch('b')], { ...config, batchExecution: 'serial' }, failRun.ctx);
  assert.deepEqual(failResults, [null, null]);
  assert.equal(failRun.stats().calls, 1);
});

test('summarizeBatches runs concurrently by default and when batchExecution is parallel', async () => {
  for (const batchExecution of [undefined, 'parallel']) {
    const { ctx, stats } = context([response(), response(), response()], 15);
    const progress = [];
    const results = await summarizeBatches(
      [batch('a'), batch('b'), batch('c')],
      { ...config, ...(batchExecution ? { batchExecution } : {}) },
      ctx,
      { onProgress: (index, _total, _batch, stage) => progress.push(`${index}:${stage}`) },
    );
    assert.equal(results.length, 3);
    assert.ok(results.every(Boolean));
    assert.equal(stats().maxActive, 3);
    assert.deepEqual(progress.slice(0, 3), ['0:start', '1:start', '2:start']);
    assert.equal(progress.filter((p) => p.endsWith(':done')).length, 3);
  }
});

test('serial summarizeBatches stops before starting later batches when aborted', async () => {
  const controller = new AbortController();
  const { ctx, stats } = context([response('aborted'), response()]);
  await assert.rejects(
    summarizeBatches(
      [batch('a'), batch('b')],
      { ...config, batchExecution: 'serial' },
      ctx,
      { signal: controller.signal, onBatchTextProgress: () => controller.abort() },
    ),
  );
  assert.equal(stats().calls, 1);
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

test('session id is forwarded to provider stream options', async () => {
  const captured = [];
  const ctx = { model: { provider: 'opencode-go' }, ui: { notify: () => {} },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'dummy' }),
      getProvider: () => ({
        stream: (_model, _context, options) => {
          captured.push(options?.sessionId);
          const result = response();
          return { async *[Symbol.asyncIterator]() {}, result: async () => result };
        },
      }),
    } };
  await summarizeBatch(batch(), config, ctx, { sessionId: 'sess-abc' });
  await summarizeBatches([batch('a'), batch('b')], config, ctx, { sessionId: 'sess-abc' });
  assert.deepEqual(captured, ['sess-abc', 'sess-abc', 'sess-abc']);
});

test('summarizerThinkingOptions and resolveModel handle null and explicit model selections', () => {
  const activeModel = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
  const findCalls = [];
  const registryModels = new Map([
    ['openai/gpt-4.1-mini', { provider: 'openai', id: 'gpt-4.1-mini' }],
    ['openrouter/qwen/qwen3-coder:exacto', { provider: 'openrouter', id: 'qwen/qwen3-coder:exacto' }],
    ['anthropic/claude-opus-4-6', { provider: 'anthropic', id: 'claude-opus-4-6' }],
  ]);
  const notifications = [];
  const ctx = {
    model: activeModel,
    ui: { notify: (...args) => notifications.push(args) },
    modelRegistry: {
      find: (provider, id) => {
        findCalls.push([provider, id]);
        return registryModels.get(`${provider}/${id}`);
      },
    },
  };

  assert.deepEqual(summarizerThinkingOptions({ summarizerModel: null }), {});
  assert.equal(resolveModel({ summarizerModel: null }, ctx), activeModel);

  const openaiConfig = { summarizerModel: { model: 'openai/gpt-4.1-mini', thinkingLevel: 'low' } };
  assert.deepEqual(summarizerThinkingOptions(openaiConfig), { reasoningEffort: 'low' });
  assert.equal(resolveModel(openaiConfig, ctx), registryModels.get('openai/gpt-4.1-mini'));

  const openrouterConfig = { summarizerModel: { model: 'openrouter/qwen/qwen3-coder:exacto', thinkingLevel: 'off' } };
  assert.deepEqual(summarizerThinkingOptions(openrouterConfig), { reasoningEffort: undefined });
  assert.equal(resolveModel(openrouterConfig, ctx), registryModels.get('openrouter/qwen/qwen3-coder:exacto'));

  const opusConfig = { summarizerModel: { model: 'anthropic/claude-opus-4-6', thinkingLevel: 'max' } };
  assert.deepEqual(summarizerThinkingOptions(opusConfig), { reasoningEffort: 'max' });
  assert.equal(resolveModel(opusConfig, ctx), registryModels.get('anthropic/claude-opus-4-6'));

  assert.deepEqual(findCalls, [
    ['openai', 'gpt-4.1-mini'],
    ['openrouter', 'qwen/qwen3-coder:exacto'],
    ['anthropic', 'claude-opus-4-6'],
  ]);
  assert.equal(notifications.length, 0);
});
