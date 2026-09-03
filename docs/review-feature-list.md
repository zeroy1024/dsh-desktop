# 审查面板功能清单（人审 agent 改动）

> 定位：右侧「审查」面板 = **人审 agent 改动**的一站式界面（调研报告中的形态 A，见 [review-feature-analysis.md](review-feature-analysis.md)）。AI 审查（形态 B）与 PR bot（形态 C）不在本清单内。
>
> 上游基线 dsh-v0.1.1-rc.2；载体为 `@dsh-desktop/review` 插件（双面包），UI 挂 `panel-shell.registerPage`。参考产品：Claude Code web/desktop 的 diff 视图、ZCode「Review changes」、Cline Checkpoints、Codex 桌面 review pane。
>
> **实现状态（2026-09）**：MVP（会话模式 P0 集）已落地为 `packages/plugins/review/`，设计决策见 [ADR-0006](adr/0006-review-plugin.md)。已拍板：MVP 纯会话模式、撤销 v1 做且仅 git 模式、已审状态内存态。**对下文的一处实质修正**：会话模式的 diff 数据（FsDiffMeta）只有 hunk 旧/新文本块、**无行号**（`computeHunkDiffs` 丢弃了 structuredPatch 的行偏移），上游 DiffBlock 也不渲染行号——F7 的双行号与 F14 的行号锚定在会话模式修正为 **hunk + 引用行文本锚定**（自绘 ReviewDiff 行渲染器，视觉约定与 DiffBlock 同族）；精确行号随 v1 git 模式（git diff 输出带 `@@` 行号）引入。

优先级定义：**P0** = MVP，最小可用闭环；**P1** = v1 完善体验；**P2** = 锦上添花/等上游能力。

---

## 1. 功能总览

| 编号 | 功能 | 优先级 | 依赖 |
| --- | --- | --- | --- |
| F1 | 改动源双模式与会话绑定 | P0 | sessions.history、mux 事件流 |
| F2 | 会话内改动聚合（FsDiffMeta） | P0 | F1 |
| F3 | 工作区 git 改动（uncommitted） | P1 | host 只读路由 |
| F4 | 统计摘要条 | P0 | F2/F3 |
| F5 | 文件列表与导航 | P0 | F2/F3 |
| F6 | 文件过滤与「只看未审」 | P1 | F5、F13 |
| F7 | 文件 diff 视图（unified） | P0 | F2/F3 |
| F8 | 展示开关（空白符/词级高亮/上下文展开） | P1 | F7 |
| F9 | 大 diff 与二进制文件降级 | P0 | F7 |
| F10 | 会话模式编辑时间线 | P0 | F2 |
| F11 | live 增量更新（agent 运行中） | P0 | mux 事件流 |
| F12 | 手动刷新与 asOf 标注 | P0 | F3 |
| F13 | 已审标记（改动级，文件状态派生） | P0 | F5 |
| F14 | 行级评论（草稿） | P0 | F7 |
| F15 | 评论回灌 agent | P0 | F14 |
| F16 | 文件级快捷意见 | P1 | F15 |
| F17 | 撤销文件改动（仅 git 模式） | P1 | F3；破坏性，见 §4.3 |
| F18 | 复制 diff | P0 | F7 |
| F19 | 在文件浏览器中打开 | P1 | panel 页间导航 API（待验证） |
| F20 | 空态与降级引导 | P0 | — |

---

## 2. 详细清单

### A. 改动源

**F1 改动源双模式与会话绑定**（P0）
面板数据跟随**当前激活会话**（panel 槽本身是 `session-maybe` 作用域）。顶部 segmented control 切换两种改动源：
- **会话内改动**：本次会话中 agent 经 write/edit 工具产生的所有编辑（FsDiffMeta 聚合）。不依赖 git 仓库，任何工作区可用。
- **工作区改动（git）**：当前工作区目录的 git diff。仅当检测到 git 仓库时可用。
打开面板时自动选定默认模式（有 git → git 模式；无 git → 会话模式并提示差异）。

**F2 会话内改动聚合**（P0）
经 `sessions.history`（分页）拉取当前会话事件，解析带 `FsDiffMeta` 的 write/edit 工具结果，按文件路径聚合。要点：
- 只读 RPC，client 半即可完成，无新增路由。
- 统计口径标注为「累计编辑量」（同一文件多次编辑会重叠求和，不代表净变更；净变更看 git 模式）。
- 边界：shell 命令产生的文件改动（如 `sed -i`）**不可见**——面板在会话模式下固定显示一行提示。

**F3 工作区 git 改动**（P1，已实现）
host 半插件注册只读路由 `/dsh-desktop/review/git`（GET），服务端在工作区路径执行：
- `git status --porcelain=v1 -z`：文件清单与状态分类（NUL 分隔，含 rename 的双 token）；
- `git diff HEAD`：staged + unstaged 的 tracked 改动 unified diff 原文；
- untracked 文件以「全绿新增」呈现（逐个 `git diff --no-index -- /dev/null <file>`，数量 ≤50、字节上限 2MB，超限置 truncated）。
- 实现取向：**服务端只回原文，解析在 client 半**（`gitdiff.ts` 纯函数，宽容窄化）——服务端保持薄；± 行数由解析结果统计，无需 numstat。
- 安全：bridge `isTrustedFsRequest`（Host loopback + sec-fetch-site + Origin 同源）；git 命令白名单常量 argv（execFile 数组传参、无 shell、15s 超时），不接收任何客户端拼接参数。
- scope 目前仅 **uncommitted**；「相对 base branch」「指定 commit」仍待做。

### B. 总览与导航

**F4 统计摘要条**（P0）
面板头部常驻：改动文件数、`+N / -M` 行数（由 hunk 计算）；agent 运行中时显示 live 徽标（转圈点），结束后静默消失。

**F5 文件列表与导航**（P0）
按文件分组的列表：路径（相对工作区根，过长中段省略）、状态徽标（新增/修改/删除/重命名/二进制）、±行数。排序默认按改动量降序，可切路径字典序。点击展开/收起该文件的 diff（手风琴式，同 Claude web）。

**F6 文件过滤与「只看未审」**（P1）
路径关键字过滤输入框；「只看未审」开关与 F13 联动。

### C. Diff 呈现

**F7 文件 diff 视图**（P0，已实现，按修正案）
自绘 ReviewDiff 渲染器（`src/client/ReviewDiff.tsx`）：增删行着色与 `- `/`+ ` 前缀、头尾折叠展开，沿用上游 DiffBlock 的视觉约定与 `--dsw-*` token。**形态为一 hunk 一卡**——分散修改即多个独立变更，折叠上限按单 hunk 计（连排折叠会藏掉 hunk 边界），hunk 之间零分隔行，路径只在分区标题出现。直接复用 DiffBlock 的方案因缺交互面（行级评论锚定）被否。

**F8 展示开关**（P1）
显示空白符变更；词级高亮（行内变更片段加亮）；软换行开关；hunk 头「展开上下文 ±N 行」（git 模式可行——hunk 自带上下文可向服务端再取；会话模式的 hunk 只有 3 行固定上下文，不支持展开，按钮置灰并 title 说明）。

**F9 大 diff 与二进制降级**（P0）
单文件 diff 超过阈值（约 2000 行）时只渲染前若干 hunk + 「展开全部」；二进制文件显示占位卡片（「二进制文件已变更」）；删除文件显示全红整文件（git 模式控制行数上限）。

**F10 会话模式编辑时间线**（P0）
会话模式下，单文件内按**编辑发生顺序**排列每次 write/edit 的 hunk，每块标注工具名与时间（如 `edit · 14:32`）。设计取向：会话模式只做「每次编辑」的时间线（数据天然如此）；「净变更视图」不在此模式实现（需按序应用补丁重放文件内容，复杂度高且 git 模式已覆盖，见 §4.2）。

### D. 实时性

**F11 live 增量更新**（P0）
agent 运行中经 `events.mux` 订阅当前会话事件流，新工具结果到达即增量插入对应文件分组（activity-group 已有解析会话事件流的先例）。git 模式在 agent 运行结束后自动刷新一次。

**F12 手动刷新与 asOf 标注**（P0）
git 模式数据是易变快照：头部标注「生成于 HH:mm:ss」，提供手动刷新按钮；会话模式为事件回放，天然确定，无需 asOf。

### E. 审阅动作

**F13 已审标记**（P0，已实现，**改动级**）
标记的原子单位是**编辑事件**（锚定 seq，会话内单调不可变），文件头勾选框是**三态复选框**（未审空框 / 部分框内短横 / 全审绿底白勾——同一图形族的状态，而非两个不相干图标），已审进度融合进编辑数徽章（`1/22`，标记一个 +1）。摘要栏提供**单一主控开关**：未全审时显示「全部标记已审」，全部已审后原地翻转为「全部取消已审」（替换而非追加按钮）。已审编辑节淡化并**禁用行级评论入口**（已审 = 关闭该节的审核交互，行 + 按钮消失、未发送的输入框就地隐藏）；文件内全部编辑已审才整节淡化。关键收益：agent 的新编辑是新 seq，**天然未审**——「agent 改了已审文件不自动取消」的问题在数据模型上不存在，无需任何补偿逻辑。状态存面板内存（会话级），不做持久化（无存储 API，见 §7）。

**F14 行级评论（草稿）**（P0，已实现，锚定按修正案）
diff 行 hover 出「+」→ 展开行内输入框（⌘/Ctrl+Enter 提交、Esc 取消）；草稿锚点为 `{文件, 编辑事件 seq, hunk 序, 侧, 行序, 引用行文本}` 六元组，存面板底部**草稿区**（按会话分桶的页面内存态）。同锚点重复添加 = 覆盖旧意见。

**F15 评论回灌 agent**（P0）
草稿区「发送给 agent」：把全部草稿组装为**一条普通用户消息**发入会话（`sessions.prompt`），格式约定：

```
请处理以下审查意见：
- src/auth.ts:47 —— token 刷新未加锁，存在竞态
- src/auth.ts:52 —— 命名与其他处不一致，建议统一为 xxx
```

发送后清空草稿；消息进入正常会话流，agent 的后续修改经 F11 实时反映回 diff——**这是审查闭环的关键一跳**。

**F16 文件级快捷意见**（P1）
文件列表每项附「追问」按钮：不选行，直接对整个文件提问（草稿条目行号为空，渲染为 `src/auth.ts —— <意见>`）。

**F17 撤销文件改动**（P1，破坏性，已实现）
仅 git 模式。文件头「撤销」按钮 **两步确认**（首次点击武装变红字「确认撤销？」，再点执行，3s 未点自动解除）：已跟踪文件 `git restore --source=HEAD --worktree --staged -- <path>`（撤销该文件全部未提交修改，含 staged）；**untracked 新文件 = 删除该文件**。服务端写路径三重防护：`resolveWithinRoot` 字符串沙箱 + 按实时 status 分类（status 外的 path 拒绝）+ 只操作单文件。会话模式不提供撤销（上游无 checkpoint 机制）。见 §4.3。

**F18 复制 diff**（P0）
单文件复制 + 全部复制（unified diff 文本，markdown 代码块包裹），供贴到 PR 描述/issue/聊天。

### F. 衔接与联动

**F19 在文件浏览器中打开**（P1，成本已骤降）
文件列表项菜单「在文件浏览器打开」。0009 缝已把 `ctx.get('fileBrowser')?.tryOpen({sessionId, cwd, path})` 做成可选服务，review 直接调用即可（无需新缝）；cwd 解析失败或服务缺席时回退复制路径。

**F20 空态与降级引导**（P0）
- 会话无改动：空态插画 +「让 agent 开始工作后，这里会汇总它的每次改动」。
- git 模式无改动：「工作区没有待审改动」。
- 非 git 仓库选 git 模式：说明原因并给「切换到会话内改动」按钮。
- 会话模式提示条（常驻可关）：「会话内改动仅覆盖文件写入工具，shell 命令产生的改动请用 git 模式」。

---

## 3. 边界情况矩阵

| 场景 | 行为 |
| --- | --- |
| 非 git 工作区 | 默认会话模式；git 模式入口置灰 + 原因 |
| git 仓库但零改动 | 空态（F20） |
| untracked 新文件 | git 模式全绿新增视图；撤销 = 删除文件（强确认） |
| 文件被删除 | 全红视图；撤销 = `git restore` 恢复 |
| 重命名 | MVP 按删+增两文件展示；P2 用 `-M` 识别后显示 rename + 相似度 |
| 二进制文件 | 占位卡片（F9） |
| 超大 diff | 折叠 + 懒展开（F9） |
| agent 运行中看 git 模式 | 可看，标注 asOf 易变快照；结束自动刷新（F11/F12） |
| 多会话并行运行 | 面板只随当前激活会话；切换会话即切换数据源 |
| 会话 fork | fork 副本的 history 可正常回放，无特殊处理 |
| 归档会话 | history 只读展示；git 模式无意义（工作区可能已变），提示 |
| 极多文件（如 200+） | 文件列表虚拟滚动，diff 仍按需渲染 |

---

## 4. 关键设计取舍

### 4.1 双源策略：会话内为主，git 为增强

会话模式零外部依赖（纯 RPC 回放），保证任何场景可用；git 模式补上 shell 改动的盲区并提供净变更口径。两者在 UI 上是平级 tab，不是降级关系。

### 4.2 会话模式只做时间线，不做净变更

净变更需按序应用 hunk 重放文件内容（hunk 只含 3 行上下文，重放要求精确应用顺序，任一乱序即错位）。git 模式天然给出净变更，不值得为会话模式重造。若某天需要，再评估。

### 4.3 唯一的写操作是「撤销」，且仅 git 模式

审查面板整体贯彻只读纪律；`git restore`/删除 untracked 是唯一写路径，走 host 路由白名单 + 类型化确认框。不做：整工作区 discard、commit、push（外部影响，红线）。

### 4.4 评论 = 一条普通用户消息

不发明评论存储协议：草稿只在面板内存，发送即成为 transcript 里的普通消息。好处：零持久化设计、天然可重放、agent 侧无需任何配合；代价：草稿不跨会话保留（可接受）。

---

## 5. 分期验收

### MVP（P0）——已实现（`packages/plugins/review/`，19 个单测全绿）

- [x] `@dsh-desktop/review` 双面包插件骨架，注册 panel-shell「审查」页（order 30，sessionMode required）
- [x] F1 会话绑定（面板页 session 槽位）；F2 FsDiffMeta/view 解析聚合（view 优先、meta 兜底、新建文件走宿主 args 兜底）；F10 编辑时间线（工具标签 · 序数 · 时间 · 计数）
- [x] F4 摘要条；F5 文件列表（改动量降序/路径字典序切换）；F7 自绘 ReviewDiff（DiffBlock 视觉约定，无行号）
- [x] F9 大 diff 折叠降级；F20 空态与口径提示条
- [x] F11 live 增量（共享信封观察 + seq 去重 + 跳跃全量重拉）+ active 门控；F12 手动刷新
- [x] F13 已审标记（改动级 seq 锚定 + 文件三态派生，按会话分桶内存态）；F14 行级评论草稿（hunk + 引用行文本锚定）；F15 一键回灌（组装一条 `session.prompt` 消息）
- [x] F18 复制 diff（DiffBlock.copyText 同格式）
- [x] 中英文 locale；深浅色主题走上游 `--dsw-*` token

### v1（P1）

- [x] F3 host git 只读路由（同源校验 + 只读白名单）+ uncommitted 模式全量状态处理（服务端回原文、client 解析、带行号 hunk 卡）
- [x] F17 撤销文件（两步确认 + restore/删除双路径）
- [ ] F6 过滤/只看未审；F8 展示开关（词级高亮、空白符、git 上下文展开）
- [ ] F16 文件级快捷意见；F19 文件浏览器联动（先验证 panelShell API）
- [ ] git 模式 scope：相对 base branch

### v2（P2）

- [ ] 指定 commit scope；重命名识别展示
- [ ] 评论锚点漂移重解析（agent 改完后旧行号重定位）
- [ ] 键盘导航（j/k 逐 hunk）
- [ ] 会话流 DiffBlock「在审查面板查看」跳入（需上游缝，先不动）
- [ ] 「上次审阅以来新增改动」对比视图

---

## 6. 数据链路速查

| 链路 | 通道 | 进程侧 |
| --- | --- | --- |
| 会话内 diff | `sessions.history` RPC + `events.mux` 订阅 | client 半（零新路由） |
| git diff/status | `/dsh-desktop/review/git` 只读路由（`ctx.webServer.register`） | host 半（复用 bridge 同源判定） |
| 撤销文件 | `/dsh-desktop/review/restore` 写路由（白名单参数 + 确认框前置） | host 半 |
| 面板 UI | `panelShell.registerPage('review', …)` | client 半 |
| 回灌消息 | `sessions.prompt`（普通文本消息） | client 半 |

---

## 7. 开放问题（需拍板）

1. **撤销功能做不做**：唯一破坏性操作。建议 v1 做、仅 git 模式 + 强确认；若想彻底零写操作可砍掉，审查变纯只读。
2. **git 模式 MVP 是否需要 base branch scope**：建议 v1 再加（uncommitted 已覆盖最高频场景）。
3. **已审状态是否需要跨会话持久化**：上游无面板侧存储 API，持久化需落 `~/.dsh` 自有文件；建议先内存态观察需求。
4. **会话模式累计编辑量的统计口径**：按次求和会有重叠虚高；建议标注口径而非做补丁重放。
