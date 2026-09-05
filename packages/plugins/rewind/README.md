# @dsh-desktop/rewind

会话撤回内置插件（对标 Kimi Code 的撤回编辑）：用户消息行 hover「撤回编辑」→ 二次确认 →
撤回到该消息发送前（模型上下文与聊天视图一致回退，会话 ID 不变、仅追加一条墓碑），原文与图片回输入框
供编辑重发。机制与决策见 [docs/adr/0007-session-rewind-tombstone.md](../../../docs/adr/0007-session-rewind-tombstone.md)。

## 架构（墓碑 + 双侧 fold）

- **写入**：host 半把 `POST /dsh-desktop/rewind/execute` 挂进 dsh 自带 webServer（上游 Cookie 鉴权与同源校验），
  precheck（live / agent idle / 不跨 compaction 替换段 / atSeq 指向 user 消息）后向 live
  Session 追加一条 `'dsh-desktop/session-rewind' {atSeq}` 墓碑事件——同步、自动持久化、
  自动走 `session/event` 广播。
- **解释**：`patches/0012` 保留 core surface fold 的必要截断原语。`patches/0013`
  只提供通用 `sessionEventViews` 注册接口，墓碑可见性折叠在本插件中实现；所有页面
  消费同一个 Session 事件视图，原始日志与分页游标保持不变。隐藏区间为
  `[atSeq, 墓碑seq)`，墓碑后新事件照常可见，多墓碑链式叠加。无墓碑时原样转发
  snapshot/delta，普通追加不扫描完整历史。
- **轮次导航**：配置叠层禁用原生 `session-turn-outline`，由本插件注册同名公开投影，
  同步撤去已撤回的 prompt/response。独立 stateVersion 使旧投影缓存自动重建。
- **用量与压缩**：0012 同步撤回 TokenMeter 的测量表面和 contextPressure/contextBreakdown
  投影；失效的 usage 校准回退估算，旧投影缓存按版本重建。已经发生的累计计费保留。
- **搜索**：通过配置替换原生 SQLite provider，复用其全文索引、分页和生命周期，
  仅覆写 0017 的通用文档投影；撤回区间不生成可搜索文档，旧持久索引自动重建。
  原始日志精确读取仍可用于审计，搜索默认启用方式沿用上游配置。
- **图片恢复**：通过公开 `Session.readAttachment` 取回字节、公开草稿附件注册接口
  准备整批图片，成功后才发送撤回请求。准备或请求失败会释放临时资源；图片回填
  绑定原会话，消息因撤回消失也不丢失附件。
- **UI**：client 半以 priority -1 shadow 官方 key='user' 消息渲染器（官方为 fallback），
  确认后准备图片、同源请求，成功后经 `inputActions` 回填文字和图片。墓碑事件不渲染任何标记：桌面单用户
  场景接缝自明，未认领的墓碑被上游 fallback 静默忽略，视图收缩由事件回推自动完成，
  插件不手动改 store。

## 边界（v1）

- 仅 live 会话可撤回（冷会话返回 `not-live` 并提示）；运行中被拒（先停止）。
- 不跨 compaction 替换边界撤回，避免错误移除边界之前仍有效的上下文。
- 官方终端 CLI 打开含墓碑的会话会显式拒读（持久化目录设计使然，ADR-0007 决定 5）。
