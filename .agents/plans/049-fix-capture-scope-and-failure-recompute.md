# 049 修复捕获范围与失败重算

## 背景

两个独立缺陷，同仓库修复：

1. **捕获范围**：`captureUnindexedBatchesFromSession` 用 `getBranch()` 扫描全量分支，未识别 compaction / `/tree` / `/fork` 造成的活跃上下文边界，把已不在模型上下文的旧 toolResult 重新送去摘要。
2. **失败重算**：`flushPending` 提交循环遇到第一个 `null` 就 `break`，失败边界之后已经算出的成功摘要被丢弃，第二次 `/pruner now` 重新调用 LLM、重新计费；第一个 batch 就失败时全部重来。

## 缺陷 1：捕获范围

### 现状

- `index.ts` `capturePendingBatches`（138 行）：`ctx.sessionManager.getBranch()` 取全量分支。
- `src/batch-capture.ts` `captureUnindexedBatchesFromSession`：仅过滤 `indexer.isSummarized` 与 `excludeToolNames`，无活跃性判断。
- 影响场景：compact 后、`/tree` 跳到兄弟分支、`/fork` 后、重复 compact，均会收集不相关 toolResult。

### 修复

复用 Pi 已提供的 compaction-aware 方法（`session-format.md` 第 322 行文档化、`session-manager.d.ts` 第 177 行类型声明）：

```ts
ctx.sessionManager.buildContextEntries()   // 当前 leaf 的活跃路径（已应用 compaction）
```

#### `src/batch-capture.ts`

`captureUnindexedBatchesFromSession` 增加可选参数：

```ts
export function captureUnindexedBatchesFromSession(
  branch: any[],
  indexer: { isSummarized(id: string): boolean },
  excludeToolNames: string[] = [],
  activeToolCallIds?: Set<string>,   // 新增
): CapturedBatch[]
```

过滤条件追加：

```ts
const readyToPrune = toolCallBlocks.filter((tc) => {
  const id = tc.id;
  if (!id) return false;
  if (indexer.isSummarized(id)) return false;
  if (excludeToolNames.includes(tc.name)) return false;
  if (activeToolCallIds && !activeToolCallIds.has(id)) return false;  // 新增
  return resultMap.has(id);
});
```

turnIndex / userTurnGroup 仍基于完整 branch（保持 frontier 坐标稳定）。

#### `index.ts` `capturePendingBatches`

```ts
const capturePendingBatches = (ctx: any): CapturedBatch[] => {
  let batches: CapturedBatch[] = [];
  try {
    const branch = ctx.sessionManager.getBranch();
    // 活跃白名单：buildContextEntries 失败时 fail closed（只回退到 pendingBatches）
    const activeToolCallIds = resolveActiveToolCallIds(ctx);
    batches = activeToolCallIds
      ? captureUnindexedBatchesFromSession(branch, indexer, [CONTEXT_PRUNE_TOOL_NAME], activeToolCallIds)
      : pendingBatches.slice();
  } catch {
    batches = pendingBatches.slice();
  }
  // 后续 trim + group 不变
};
```

新增纯函数 `resolveActiveToolCallIds(ctx)`：

```ts
function resolveActiveToolCallIds(ctx: any): Set<string> | null {
  const sm = ctx?.sessionManager;
  if (!sm || typeof sm.buildContextEntries !== "function") return null;
  let entries: any[];
  try { entries = sm.buildContextEntries(); }
  catch { return null; }
  if (!Array.isArray(entries)) return null;
  const ids = new Set<string>();
  for (const e of entries) {
    if (e?.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId) {
      ids.add(e.message.toolCallId);
    }
  }
  return ids;
}
```

`fail closed`：白名单不可用时只回退 `pendingBatches`，绝不扫全量 branch。

### 不改动

- `indexer.reconstructFromSession` / `frontier.reconstructFromSession` 仍用 `getBranch()`：它们读的是 context-prune 自己写的 custom entry，且 `injectSummaries` 用 `findSummaryInsertIndex` 只在当前活跃 messages 内定位，不会被污染。
- `session_start` / `session_tree` 已正确重建并清空 pending，不动。

## 缺陷 2：失败重算

### 现状

`flushPending`（index.ts 第 157–303 行）：

```
顺序遍历 batches：
  success → 立即提交（addBatch + recordSummary + appendEntry）
  null    → firstFailureIndex = i, break
restoreBatches(batches.slice(firstFailureIndex))
```

- 失败之前的成功：已提交，不会重做 ✓
- 失败之后的成功：摘要结果丢弃，重算重付费 ✗
- 第一个就失败：`processedBatches` 为空，全部重来 ✗

### 修复

新增 session 生命周期的成功摘要缓存，重试复用，避免重算。

#### `index.ts` 闭包新增

```ts
// key = summaryToolCallKey(toolCallIds)，已持久化后清除
const preparedSummaryCache = new Map<string, SummarizeResult>();
```

#### `flushPending` 改动

**summarizeOne 包装查缓存：**

```ts
const summarizeOne = (batch, _index, onTextProgress) => {
  const key = summaryToolCallKey(batch.toolCalls.map((tc) => tc.toolCallId));
  const cached = preparedSummaryCache.get(key);
  if (cached) return cached;   // 命中，跳过 LLM
  return summarizeBatch(batch, currentConfig.value, ctx, { signal: options.signal, onTextProgress })
    .then((result) => { if (result) preparedSummaryCache.set(key, result); return result; });
};
```

**提交循环改为不 break：**

```ts
const failedIndices: number[] = [];
for (let i = 0; i < batches.length; i++) {
  const batch = batches[i];
  if (preSkipFlags[i]) { processedBatches.push(batch); continue; }
  const result = results[i];
  if (!result) { failedIndices.push(i); continue; }   // 不 break，继续提交后续成功项
  // 提交逻辑不变（addBatch / recordSummary / appendEntry）
  提交后 preparedSummaryCache.delete(key);            // 已持久化，清缓存
  processedBatches.push(batch);
}
```

**frontier 只推进到第一个失败之前的最后一个已提交 batch：**

```ts
const firstFailure = failedIndices[0];
const frontierBatch = firstFailure === undefined
  ? processedBatches[processedBatches.length - 1]
  : processedBatches.filter((_, idx) => batches.indexOf(processedBatches[idx]) < firstFailure).pop() ?? null;
// frontierBatch 为 null 时不推进（保持原 frontier）
```

约束：

- frontier 绝不越过失败项（保证 `trimBatchToPendingRange` 不会把未提交的失败 batch 丢弃）。
- 失败之后的成功已写 index，下次 `capturePendingBatches` 用 `isSummarized` 自动排除它们的 toolCallId，不会被重抓重算。
- 失败项重试成功后连同其余一起提交，frontier 再推进。

#### 生命周期清空

`session_start` / `session_tree` 内追加：

```ts
preparedSummaryCache.clear();
```

用户主动取消（Esc/q）保持现状：`restoreBatches(batches)`，本次成功摘要留在缓存供下次复用（不丢弃已算出的结果）。

## 文件改动预估

| 文件 | 类型 | 行数 |
|---|---|---|
| `src/batch-capture.ts` | 产品 | +8 |
| `index.ts` | 产品 | +60～75 |
| `tests/capture-active-scope.test.ts` | 测试（新） | +140～180 |
| `tests/flush-partial-failure.test.ts` | 测试（新） | +120～160 |
| `tests/context-preservation.test.ts` | 测试 | +20 |
| `AGENTS.md` | 文档 | +15～25 |

产品代码合计 ~70 行，测试 ~280–360 行。

## 验证矩阵

### 捕获范围（capture-active-scope.test.ts）

合成 SessionManager stub，每个用例构造不同 entry 树后断言捕获到的 toolCallId 集合：

| # | 场景 | 期望 |
|---|---|---|
| 1 | 无 compact 普通分支 | 全部 toolResult 被捕获 |
| 2 | compact 后 firstKeptEntryId 之前 | 旧 toolResult 不被捕获 |
| 3 | compact 含 retainedTail | tail 内 toolResult 被捕获 |
| 4 | 连续多次 compact | 以最新边界为准 |
| 5 | `/tree` 跳到兄弟分支 | 原分支 toolResult 不被捕获 |
| 6 | `/tree` 跳回 compact 前 | 旧 toolResult 重新进入活跃集合，被捕获 |
| 7 | 各兄弟分支不同 compact 边界 | 各自边界独立生效 |
| 8 | buildContextEntries 缺失 | fail closed，只用 pendingBatches |
| 9 | buildContextEntries 抛错 | fail closed |
| 10 | 已 summarized 的 toolCall | 双重过滤，不重复捕获 |

### 部分失败（flush-partial-failure.test.ts）

注入假 summarizeOne 控制 success/null：

| # | 场景 | 期望 |
|---|---|---|
| 11 | [s, fail, s] | s0、s2 提交；s2 摘要缓存；第二次 s2 命中缓存不调 LLM |
| 12 | 第一个就失败 | 返回 summarizer-failed，无提交；第二次缓存命中 |
| 13 | [fail, s] frontier 不越界 | s 提交但 frontier 不推进到 s（保留 fail 重试机会） |
| 14 | 全部失败 | summarizer-failed，无提交 |
| 15 | 重试成功后 | 缓存清除，frontier 推进到末尾 |
| 16 | session_tree 清空缓存 | 重试需重新调 LLM |

### 真实会话重放

| # | 场景 | 期望 |
|---|---|---|
| 17 | 35MB 异常会话（trace-plaintext-decryption-chain） | 修复前捕获 ~2568 calls → 修复后 ~152 calls；字符量同比例下降 |

### 回归

| # | 场景 | 期望 |
|---|---|---|
| 18 | 现有全量测试 | 1437+ 通过 |
| 19 | extension-load-smoke | 通过 |
| 20 | `bun test tests/` | 全绿 |

## 实施顺序

1. 缺陷 1 产品代码（batch-capture.ts + index.ts）
2. 缺陷 1 测试（capture-active-scope）+ 真实会话重放
3. 缺陷 2 产品代码（index.ts 缓存 + 循环）
4. 缺陷 2 测试（flush-partial-failure）
5. 全量回归
6. AGENTS.md 同步
7. 提交（两个独立 commit）

## 风险

- `buildContextEntries` 在旧 Pi 不存在 → 已用 fail closed 覆盖。
- frontier 计算复杂度 → 用例 13 专门覆盖，保证不越界。
- 缓存内存占用 → 已提交即清除，session 切换即清空。
