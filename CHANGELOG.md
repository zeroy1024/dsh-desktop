# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-09-10

### 新增 / Added

- 视觉插件默认改为按需图片分析：当前回合的新截图仍自动转写，历史图片以引用随请求提供，模型可通过 `vision_analyze_image` 工具按需分析；成功证据持久化保存，重启或内存淘汰后仍可复用，不再需要一次性补做全部历史图片。
- 模型级原生策略：可为单个模型覆盖 API 协议（Chat / Responses / Anthropic）、声明思考能力与默认思考状态；模型选择器支持「关闭 / 开启」与「始终开启」两种思考控制，原生设置页保持不变。

### 改进 / Changed

- 图标按钮悬浮提示从原生 title 改为宿主 Tooltip（底部、500 毫秒延迟），覆盖桌面框架、文件浏览、面板外壳、审阅与会话行操作，悬停体验与宿主一致。

### 修复 / Fixed

- 用量统计：fork 会话不再重复统计前缀中已计入原会话的调用；无法读取的会话不再被静默跳过，改为提示统计不完整；扫描期间被删除的会话视为正常情况；证据存储故障自动降级并退避重试，不再让整个统计失败。
- 文件浏览：修复 Windows UNC 共享等跨平台文档根目录的父目录判定，根形输入不再把自身当作父目录。
- 视觉：缺少附件 ID 的图片不再共用同一条分析引用；证据存储改为按记录布局；会话 API 异常时该图片弃权，不再中断整个请求。
- 启动画面鲸鱼 logo 不再上下浮动。

### Added

- The vision plugin now defaults to on-demand image analysis: new screenshots in the active turn are still transcribed automatically, while historical images ship as references the model can analyze through the `vision_analyze_image` tool. Successful evidence is persisted and survives restarts or in-memory eviction, so historical images no longer need a one-off bulk catch-up.
- Native per-model policies: a model can now override its API protocol (Chat / Responses / Anthropic) and declare its thinking capability with a default thinking state; the model selector supports off/on toggle and always-on thinking controls, with the native settings page unchanged.

### Changed

- Icon-only buttons now show host-styled tooltips (bottom placement, 500 ms delay) instead of native titles, covering the desktop frame, file browser, panel shell, review, and session-row actions for a hover experience consistent with the host.

### Fixed

- Usage statistics: sessions forked from a parent no longer double-count calls already charged to the original session; sessions that fail to read are reported as an incomplete count instead of being silently skipped; a session deleted mid-scan is treated as benign; evidence-storage failures degrade the cache with backoff instead of failing the whole summary.
- File browser: fixed parent resolution for cross-platform document roots such as Windows UNC shares; root-shaped input no longer reports itself as its own parent.
- Vision: images without an attachment ID no longer collapse onto a single analysis reference; evidence storage moved to a per-record layout; a session API error now makes that image abstain instead of interrupting the whole dispatch.
- The whale logo on the splash screen no longer bobs up and down.

[0.1.3]: https://github.com/zeroy1024/dsh-desktop/compare/v0.1.2...v0.1.3

## [0.1.2] - 2026-09-06

### Added

- 文件浏览的 Markdown 预览改为文档级渲染：标题、目录、仓内链接可跳转，代码块走宿主 CodeBlock。

### Changed

- 用量统计明细表去掉无数据的推理列，表头和单元格居中，用量占比只保留百分比。
- 用量统计趋势图只保留近 7 日 / 近 30 日（默认 7 日），X 轴按日历铺满所选窗口。

### Fixed

- 用量统计改为与会话底栏同一套计费口径：不再因空 step、缺 `totalTokens` 或缺缓存桶把整轮用量丢掉。

[0.1.2]: https://github.com/zeroy1024/dsh-desktop/compare/v0.1.1...v0.1.2
