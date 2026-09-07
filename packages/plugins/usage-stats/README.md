# usage-stats

设置面板的「用量统计」页：按 `(provider, model)` 聚合本机全部会话的 token 账目（未缓存输入 / 缓存读 / 缓存写 / 输出 / 缓存命中率 / 占比），附每日活动热力图与按模型趋势折线图。计费口径与会话底栏一致。

## 数据流

```
浏览器半（src/client/）                 Node 半（src/index.ts）
UsageStatsSection ── POST 同源 ──→ /dsh-desktop/usage/summary（registerHostRoute，复用上游鉴权）
 SVG 图表 + 明细表                    listSnapshots() 轻量枚举（stat 派生 revision）
        ▲                            revision 变了才 readFrom(0) 读取逻辑事件
        │                            aggregator.ts：逐次 usage 样本折算（tokenUsage 投影语义）
        └──────── JSON ────────────  usage_stats 缓存域（per-record 可丢弃派生数据）
```

- 计费折算与上游 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` 投影（会话底栏 StatsLine）同一套语义：每条 provider 上报的 usage 都进账；同 `(turn, step)` 的流式样本被最终消息替换；`llm/retry-started` 之后的新尝试另计。不使用 `deriveTurnTokenUsage`（exact-or-nothing 会在真实日志上整 turn 丢数）。
- 归因按 attempt：有 `message.source` 的进对应 `(provider, model)`；没有来源的（失败重试尚未形成助手消息）进「未归因」。turn 内换模型拆到各模型行，不再整 turn 丢进未归因。恒有 `Σ byModel + unattributed = Σ byDay`。
- 缓存：`usage_stats` storage domain（`defineDomain` + per-record + backup-and-skip），新鲜度键 = 持久化层 revision；行内 `algoVersion` 与当前折算世代不一致时正常失效并重折覆盖（当前 v2），不将旧版本视为损坏记录。缓存打开、读写或清理失败均降级为无缓存计算，不丢弃有效结果；下一次请求重试缓存。
- 子代理会话（仅 `origin: 'subagent'`，普通 fork 不算）并入总量，卡片上标注数量。

- 只统计当前保留会话各自新增的调用，使用 `inheritedEventCount` 排除 fork 的继承前缀；撤回隐藏的已发生调用仍计费。删除原始会话后，不通过其他 fork 的继承历史补回该会话用量。
- 源日志读取失败通过响应 `failed` 计数及界面提示标明统计不完整；缓存故障不影响统计完整性。

## 口径备忘

- 总量恒用四桶和（未缓存输入 + 缓存读 + 缓存写 + 输出），与会话底栏的计费输入 + 输出一致。
- 进行中的对话（无 `turn/end`）计入；空 step（`step/start` 后立刻 `step/end`、无 usage）不影响其他请求。
- 不要求 `totalTokens`，也不要求每个 attempt 都上报缓存桶：缺省的缓存读/写当 0，不会抹掉同 turn 里其他 attempt 的缓存读。
- 缓存命中率 = 缓存读 /（未缓存输入 + 缓存读 + 缓存写），上游 `StatsLine.cacheHitPercent` 同款计费用量口径。
- DeepSeek 协议不上报缓存写，此类供应商该列恒为 0（表内脚注）。
- 请求数按「以助手消息结算的计费尝试」计：同一步的流式用量与最终消息只计一次，重试后的新尝试另计。
- 归属日按该次 usage 报告的事件时间（本地时区日历日）。

## 边界

- 不 import 上游 src；编译期依赖只经 `vendor/` 的 tarball 产物（`link:` devDependencies + `external: ['@deepseek-ai/*', 'zod']`）。
- 类型面用本地结构化镜像（`src/client/types.ts`）+ vendor 包 type-only import，见 archive-manager 先例。
- 数据全部本地读算，不出网。
