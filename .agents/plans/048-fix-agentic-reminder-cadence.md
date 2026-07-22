---
name: 048-fix-agentic-reminder-cadence
description: 修复 agentic-auto 在 summary 改为 context 注入后重复注入未压缩提醒的问题。
steps:
  - phase: 复现
    steps:
      - "- [x] 用 reminder 模块的纯接口复现 context_prune 被计数和同一阈值重复提醒。"
  - phase: 修复
    steps:
      - "- [x] 排除 context_prune，并在 8、12 个未压缩工具调用的阈值跨越时各提醒一次。"
      - "- [x] 在 session 与 branch 边界重置 reminder watermark。"
  - phase: 验证
    steps:
      - "- [x] 运行单测、类型检查与完整测试。"
      - "- [x] 审查变更并提交。"
---

# 048-fix-agentic-reminder-cadence

## Phase 1 — 复现
- [x] 用 reminder 模块的纯接口复现 context_prune 被计数和同一阈值重复提醒。

## Phase 2 — 修复
- [x] 排除 context_prune，并在 8、12 个未压缩工具调用的阈值跨越时各提醒一次。
- [x] 在 session 与 branch 边界重置 reminder watermark。

## Phase 3 — 验证
- [x] 运行单测、类型检查与完整测试。
- [x] 审查变更并提交。
