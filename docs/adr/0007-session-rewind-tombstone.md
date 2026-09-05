# ADR-0007：会话撤回 —— 墓碑事件 + 上游 fold 最小补丁

- 状态：已接受
- 日期：2026-09-03

## 背景

用户需要「撤回编辑」能力（对标 Kimi Code 的 `/undo`）：撤回到某条用户消息发送前，
消息文本回输入框供编辑重发。会话 ID 不变、无切换闪烁、磁盘近零增长。

上游 dsh 没有任何回退原语：会话是 append-only 事件日志，唯一"回到历史点"的官方
机制是 `session.fork`（复制到新会话）。fork 方案（ADR 评估过）的代价：每次撤回
产生一个新会话（空间随撤回次数线性增长）、切换过渡可感知、旧会话需归档管理。

Kimi Code（MIT，MoonshotAI/kimi-code）给出了第三种架构：**追加墓碑记录**——
`context.undo {count}` 追加进记录流，所有消费者（LLM 上下文、transcript、resume
重放、搜索）通过同一个 fold 应用墓碑统一剔除被撤回内容。物理日志保留（审计/
回放源），语义层一致回退。

## 选项

- **A. fork + 归档（纯插件，前次评估的方案）**：零 patch，但会话 ID 变化、
  空间线性增长、切换闪烁。否决为 v1 主方案。
- **B. 墓碑 + patch 上游两个 fold（选定）**：机制与 Kimi 同构，交互质量最高。
- **C. 墓碑 + 纯插件**：不可行——墓碑的解释层（core surface fold、client
  conversation ingest）是上游所有代码路径的私有汇合点，插件对两者均无拦截面
  （`deriveMessages`、客户端 assembler 增量路径连"自撤"都抛错）。

## 决定

采用 B。对 patches.yml 标准（"能做成插件/配置叠层的不动源码"）的论证：墓碑的
写入侧（append 自定义事件）与全部 UI 是插件能做的；但**解释层**（`surface.ts` 的
`planSurfaceEvent`/`applySurfacePlan`、client `session.ts` 的事件 ingest）上游私有，
与 0008（"inspectCall 内嵌于上游 apply 闭包，插件无任何拦截点"）同性质。

1. **事件**：`'dsh-desktop/session-rewind'`，data `{ atSeq: number }`，由 host
   插件向 live Session append（`Session.append` 无运行时类型白名单，已核实）。
   可见性语义：seq T 处的墓碑隐藏区间 **[atSeq, T)**（撤回后新事件 seq > T 照常
   可见）；多墓碑链式叠加（∃r: r.atSeq ≤ e.seq < r.seq 则隐藏）。
2. **patch 0012（core/session）**：`SurfacePlan` 加 `truncate` 变体；
   `applySurfacePlan` 执行 `nodes.filter(seq < atSeq)` 并 **`replaceGeneration += 1`**
   （否则 `deriveMessages` 增量缓存不收缩——已核实的坑）。三路径（live append /
   fromRestore / foldSurface 全量）汇入同一对函数，一处生效。
3. **patch 0013（client/runtime）**：纯函数 `visibleViewEvents`（∃-range 折叠，
   墓碑事件本身保留在流中）接线到 ingest 三口（初始窗口 /
   实时事件 / 翻页 prepend），重建走现成 `replaceWindow`（key 稳定、无 withdraw
   抛错、raw 窗口与分页游标不动）。**墓碑不渲染任何标记**（2026-09-03 修订：
   最初的 definition 认领渲染「已撤回」分隔线在多次撤回后堆叠成纯噪音；桌面
   单用户场景接缝自明，未认领的墓碑被上游 fallback 静默忽略，视图无痕）。
4. **持久化目录**：patch 携带 `declare module '@deepseek-ai/dsh-session/types'`
   声明（上游标准扩展模式）+ 重新生成 `known-event-types.ts`。
5. **互操作行为（由上游契约唯一决定）**：官方终端 CLI 打开含墓碑的会话会显式
   拒读（"written by a newer harness"）。不使用 `ignorable`——其语义契约是
   "跳过不影响重建"，对墓碑为假（跳过=截断丢失=重建出错误会话，恰是上游错误
   信息警告的场景）。显式拒读优于静默漏上下文。DSH_HOME 与 CLI 共享，此限制
   明示于 README。
6. **v1 范围**：仅 live 会话（agent 已附着）。冷会话撤回返回结构化错误——冷路径
   需"prepare→append→publish"舞蹈且与后续 prompt-resume 存在互斥
   （`coordinator.prepare` 对 live 抛错），列为 v2 专项。
7. **host precheck**：live → agent idle → 边界扫描（拒绝跨 compaction 替换段的
   撤回：∃替换事件 R: R.seq ≥ atSeq ∧ R.surfaceOp.start < atSeq）→ atSeq 指向
   user/message 事件。运行中撤回被拒（提示先停止）。

## 后果

- 撤回后会话 ID 不变、无切换、磁盘只增一条小记录；模型上下文与人类视图真实
  回退，重启/恢复一致（core 三路径共用 fold）。
- **已知限制（v1）**：token-meter 是独立的游标式 fold（`isSurfaceEvent` 对墓碑
  为 false），撤回后其上下文用量显示与 compaction 规划面按旧表面估算——读侧
  显示偏差，不影响模型真实上下文；完整对齐需 token-meter 消费墓碑，列为后续。
  搜索索引同样仍含被撤回消息。
- **撤回后 fork 的语义**：`session.fork` 按事件前缀切片复制，不感知墓碑——
  fork 边界落在墓碑之前（即被撤回区间之后段被完整复制）时，子会话不含墓碑、
  被撤回的消息在子会话"复活"。这是可辩护的语义（fork = 从该时点的原始转录
  分叉），桌面 UI 的 forkAt 目标多不可见（视图已折叠）故日常不可达，但
  Inspect/子代理路径可触达；行为由 real-package 测试锁定。
- patch 维护：surface.ts / session.ts 是上游活跃文件，submodule bump 时按既有
  patch 队列流程（sync-upstream CI 演练）重放校验；两个 patch 独立登记、可独立修复。
- 官方 CLI 拒读含墓碑会话（见决定 5）；上游落地原生 rewind 原语后两 patch 退役、
  插件仅换事件类型，UI 层不动。
- shadow 用户消息渲染器镜像官方气泡与动作行，与官方的已知差异（升级 checklist
  对齐项）：引用 chip 不带 ReferenceIcon（ui-conversation 内部件未导出）、
  formatClock 为 formatMessageClock 的近似、steering 消息不 shadow（撤回语义
  限定在 turn 边界的 user 消息）。

## 修订记录（0.1.2-rc.1 升级，2026-09-05）

### 上游 fork 原语出现后的决策：维持原地截断

0.1.2 在 `SessionStore` 新增了原生 `fork(source, boundary?, childSessionId?)`（store 级、
切点必须落在 turn 外、子会话 header 记 `parentSession`/`isSeeded`，配套 `'session/end-seed'`
日志事件仅构造器可写）。fork 与本 ADR 的墓碑方案解决的是**不同产品语义**：

- **fork = 从某时点分叉出新会话**：会话 id 变化，原会话保持不动，适合「分支尝试」；
  0.1.2 的 chat 节点已带 `forkAt` 动作（上游 `ChatNodeOwnerProps.forkAt`）。
- **rewind（本 ADR）= 原会话原地回卷**：撤回某条用户消息之前的上下文并把原文
  回填输入框，会话 id 不变、视图真实回退。这是「说错了重来」的核心工作流，
  fork 无法等价表达（id 变化破坏「同一会话继续」的连续性，且输入框回填语义
  无处安放）。

**决策**：rewind 维持原地截断语义，0012/0013 在 0.1.2 上重做（见
`docs/upgrade-dsh-0.1.2-rc.1-phases.md` 阶段 7）；fork 作为「从此处分支继续」
的独立增强另立，不与 rewind 合并。

### 0.1.2 适配要点

- seq 类型全面品牌化（`SessionSeq`/`SessionLogOffset`），墓碑折叠解释与
  SessionEventMap 登记随品牌类型重放；测试访问器 `session.events` 改
  `session.snapshotEvents()`。
- 会话语义持久化由 SQLite 改为 JSONL（`session-persistence-jsonl`），含墓碑
  会话的 roundtrip 与官方 CLI 拒读行为已随 0.1.2 重放重新验证。
- 上游以架构笔记明示**否决**「可注册事件类型注册表」方向（事件类型保持
  生成式硬编码集合，外部事件走 envelope `ignorable`）；墓碑因「跳过=重建出
  未截断的错误会话」不可标 ignorable，维持 patch 内登记 + 官方 CLI 显式拒读。
