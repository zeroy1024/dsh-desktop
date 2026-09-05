# 文档索引

本目录区分当前维护说明、架构决策和历史记录。安装与首次运行从[项目 README](../README.md)开始；开发边界以 [AGENTS.md](../AGENTS.md) 为准。

## 开发与维护

| 文档 | 用途 |
| --- | --- |
| [架构总览](architecture.md) | 进程边界、鉴权、插件分发、目录所有权与当前路线图 |
| [窗口与标题栏](overlay-titlebar.md) | 平台宿主、布局接缝、主题与窗口验收 |
| [CI 与可复现构建](ci.md) | 自动检查、三平台打包冒烟、本地验证与发行流程 |
| [补丁登记](../patches/patches.yml) | 有效补丁队列、修改理由与退役条件 |

## 插件说明

插件的用法、配置、当前能力和限制放在各包 README，避免在 docs 重复维护功能清单。完整插件名册见[项目 README](../README.md#内置插件)。

| 插件 | 说明 |
| --- | --- |
| [Review](../packages/plugins/review/README.md) | 会话/Git 改动、审阅标记、评论与单文件撤销 |
| [Rewind](../packages/plugins/rewind/README.md) | 原会话撤回、文字与图片恢复、互操作限制 |
| [归档管理](../packages/plugins/archive-manager/README.md) | 归档列表、时间、分组与恢复 |
| [会话行操作](../packages/plugins/session-actions/README.md) | 快速归档与 ZIP 导出 |
| [Vision](../packages/plugins/vision/README.md) | 图片证据桥接、视觉 API 与凭据配置 |
| [Web Search](../packages/plugins/web-search/README.md) | 辅助模型搜索、结构化来源与凭据配置 |
| [FPS HUD](../packages/plugins/fps-overlay/README.md) | 开发态帧率显示与测量范围 |

## 架构决策（ADR）

ADR 解释选择的原因与取舍；修订后的决定优先于原始方案。升级时核对文中契约与当前代码。

- [0001 上游源码与补丁队列](adr/0001-upstream-sourcing.md)
- [0002 HTTP 传输与 IPC 暂缓](adr/0002-mvp-transport.md)
- [0003 Node 运行时策略](adr/0003-node-runtime.md)
- [0004 内置插件分发](adr/0004-bundled-plugins.md)
- [0005 归档管理与公开取消归档 API](adr/0005-archive-manager-plugin.md)
- [0006 Review 面板与评论回灌](adr/0006-review-plugin.md)
- [0007 会话撤回墓碑](adr/0007-session-rewind-tombstone.md)

## 历史记录

[历史索引](history/README.md)保留升级结论、问题证据与验证边界。历史报告中的测试数量、文件行号、待办和第三方产品描述均属于当时快照，不能作为当前验收结果。

## 维护约定

- 项目 README 负责项目介绍、快速开始和功能入口；跨模块机制放在本目录，插件细节就近放在包 README。
- 决策变化修订对应 ADR；完成的阶段计划合并为结果记录，清除重复任务清单和失效估时。
- 移动或删除文档时同步修复引用；需要追溯原始过程时使用 Git 历史，不保留空壳跳转文件。
- `upstream/`、`vendor/` 和构建产物不属于自有文档整理范围。测试 Markdown、运行时 Markdown 资源及第三方许可声明按其功能保留，不能按扩展名批量清理。
