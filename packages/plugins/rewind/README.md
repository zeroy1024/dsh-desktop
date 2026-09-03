# @dsh-desktop/rewind

会话撤回内置插件（对标 Kimi Code 的撤回编辑）：用户消息行 hover「撤回编辑」→ 二次确认 →
撤回到该消息发送前（模型上下文与聊天视图一致回退，会话 ID 不变、零空间增长），原文回输入框
供编辑重发。机制与决策见 [docs/adr/0007-session-rewind-tombstone.md](../../../docs/adr/0007-session-rewind-tombstone.md)。

## 架构（墓碑 + 双侧 fold）

- **写入**：host 半把 `POST /dsh-desktop/rewind/execute` 挂进 dsh 自带 webServer（同源校验），
  precheck（live / agent idle / 不跨 compaction 替换段 / atSeq 指向 user 消息）后向 live
  Session 追加一条 `'dsh-desktop/session-rewind' {atSeq}` 墓碑事件——同步、自动持久化、
  自动走 `session/event` 广播。
- **解释**：`patches/0012`（core surface fold，模型上下文与恢复路径）与 `patches/0013`
  （client runtime 视图折叠，三 ingest 口）统一解释墓碑：隐藏区间 `[atSeq, 墓碑seq)`，
  墓碑后新事件照常可见，多墓碑链式叠加。
- **UI**：client 半以 priority -1 shadow 官方 key='user' 消息渲染器（官方为 fallback），
  确认后 `inputActions.setDraft(原文)` + 同源 fetch。墓碑事件不渲染任何标记：桌面单用户
  场景接缝自明，未认领的墓碑被上游 fallback 静默忽略，视图收缩由事件回推自动完成，
  插件不手动改 store。

## 边界（v1）

- 仅 live 会话可撤回（冷会话返回 `not-live` 并提示）；运行中被拒（先停止）。
- 图片附件不回填（只回填文本）；token-meter 与搜索索引不感知墓碑（显示层偏差，
  见 ADR-0007 已知限制）。
- 官方终端 CLI 打开含墓碑的会话会显式拒读（持久化目录设计使然，ADR-0007 决定 5）。
