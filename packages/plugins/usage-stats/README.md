# usage-stats

设置面板的「用量统计」页：按 `(provider, model)` 聚合本机全部会话的 token 账目（未缓存输入 / 缓存读 / 缓存写 / 输出 / 推理 / 缓存命中率 / 占比），附每日活动热力图与按模型趋势折线图。

## 数据流

```
浏览器半（src/client/）                 Node 半（src/index.ts）
UsageStatsSection ── POST 同源 ──→ /dsh-desktop/usage/summary（registerHostRoute，复用上游鉴权）
 SVG 图表 + 明细表                    listSnapshots() 轻量枚举（stat 派生 revision）
        ▲                            revision 变了才 readRaw() 解码全文
        │                            aggregator.ts：按 turn 切片 → deriveTurnTokenUsage（token-meter）
        └──────── JSON ────────────  usage_stats 缓存域（per-record 可丢弃派生数据）
```

- 折算完全委托上游 `@deepseek-ai/dsh-token-meter` 的 `deriveTurnTokenUsage`（exact-or-nothing：重试 attempt 替换而非重复计数，账目不可证明时整体拒绝）。本插件不做任何用量推断。
- 归因宁缺毋猜：turn 内存在无归因 attempt（如失败的失败尝试）、或 turn 内切换模型（routes > 1）时，整 turn 记入「未归因」行。恒有 `Σ byModel + unattributed = Σ byDay`。
- 缓存：`usage_stats` storage domain（`defineDomain` + per-record + backup-and-skip，与上游 session_projcache 同款取舍），新鲜度键 = 持久化层 revision（stat 派生，文件一变即变）。域打开失败只降级为每次全量重算。
- 子代理会话（`origin: 'subagent'` 或带 `parentSession`）并入总量，卡片上标注数量。

## 口径备忘

- 总量恒用四桶和（未缓存输入 + 缓存读 + 缓存写 + 输出）；上游 `totalTokens` 允许 ≥ 四桶和，不采用。
- 缓存命中率 = 缓存读 /（未缓存输入 + 缓存读 + 缓存写），上游 `StatsLine.cacheHitPercent` 同款计费用量口径。
- 推理 token 是输出的子集（部分供应商才上报），只展示不计入总量。
- DeepSeek 协议不上报缓存写，此类供应商该列恒为 0（表内脚注）。
- 请求数按「带 usage 报告的 assistant/message」计，不含被重试替换的中间尝试。
- 归属日按 `turn/end` 时间的本地时区日历日。

## 边界

- 不 import 上游 src；编译期依赖只经 `vendor/` 的 tarball 产物（`link:` devDependencies + `external: ['@deepseek-ai/*', 'zod']`）。
- 类型面用本地结构化镜像（`src/client/types.ts`）+ vendor 包 type-only import，见 archive-manager 先例。
- 数据全部本地读算，不出网。
