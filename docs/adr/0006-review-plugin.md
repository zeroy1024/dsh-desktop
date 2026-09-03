# ADR-0006：审查插件 —— 会话事件流聚合的面板页 + 行级评论回灌

- 状态：已接受
- 日期：2026-09-03
- 关联：[review-feature-analysis.md](../review-feature-analysis.md)（调研）、[review-feature-list.md](../review-feature-list.md)（功能清单）、ADR-0004（内置插件分发）、ADR-0005（webServer 路由先例）

## 背景

桌面版要在右侧面板提供「人审 agent 改动」界面（功能清单形态 A）：按文件汇总
当前会话的 write/edit 改动、行级评论、一键把意见回灌会话。上游（dsh-v0.1.1-rc.2）
的 diff 能力全部内嵌在会话流（`DiffBlock` 卡片），没有独立的改动汇总面板，
也没有任何 git 工作区视角。

数据现实（本 ADR 最重要的输入）：

- diff 的 durable 来源是 `tool/result` 事件的 `data.meta.diffs`（FsDiffMeta，
  `upstream/packages/fs/tool-fs/src/diff.ts`）：每 hunk 一条 `FileDiff
  {path, oldText, newText}`，**只有旧/新两侧整块文本，没有行号**——
  `computeHunkDiffs` 丢弃了 `structuredPatch` 的行偏移。
- 新建/同内容覆写在 meta 里是空数组；宿主现算的 view（`DiffResultView`，
  write.ts `presentResult` 的 args 兜底）才带全文件 diff，且 view 不持久化、
  只随 `session.history` 响应与 mux 帧下发（上游自述 "result side is
  authoritative"）。
- mux 物理流只允许一个消费者（`connection.start()` 二次调用抛错）；插件只能
  经 `subscribeEnvelopes` 观察共享连接的解码帧批次（file-browser 先例）。

## 选项

- **A. patches/*.patch 给上游加「会话改动汇总」面板**：把展示层塞进上游
  ui-conversation 系，违反「UI 变更优先客户端插件」铁律，且我们已有
  panel-shell 面板页基建（0006/0007/0008）。否决。
- **B. 复用上游 DiffBlock 渲染**：视觉零成本，但 DiffBlock 没有交互面——
  行级评论需要行 hover + 内联输入框，套不进去。否决（视觉约定仍沿用）。
- **C. 纯 client 半插件：`session.history` RPC 全量回拉聚合 + 信封观察增量
  + 自绘 diff 行渲染器（选定，MVP）**。
- **D. MVP 即带 host 半 git 路由**：一步到位双改动源，但 MVP 体量翻倍且
  git 侧安全栅栏（同源校验/路径沙箱/命令白名单）值得独立评审。推迟到 v1。

## 决定

采用 C，落地为 `packages/plugins/review`（MVP = 会话模式 P0 集）：

1. **挂载**：panel-shell 页（id `review`，order 30，`sessionMode: 'required'`——
   改动源锚定会话事件流）。`panelShell.registerPage` + `panel-shell.page` 槽
   两半注册一个 effect 事务（panel-page-stub 范本），零新增上游补丁。
2. **数据链路**（client 半独走，`src/client/api.ts` 手写 RPC 信封，file-browser
   同款）：`session.history` 尾页起步、`beforeSeq` 向前翻页全量回拉（页上限
   60 保护，超限置 truncated 标注）；聚合器（`aggregate.ts`，纯函数 + 流式
   Aggregator）把 `tool/result` 流聚成「按文件分组的编辑时间线」。diff 提取
   优先级：view（result 侧 diff 卡）→ `meta.diffs`；工具标签经 `tool/call`
   的 callId 配对（write/edit），配不上给 'other'。
3. **live 增量**：仅 active 时 `openSessionSignals` 观察共享信封（过滤目标
   会话的 `session/event`/`session/subscribed` 帧——注意 wire 约定：SSE 信封
   的 method = mux 帧的 type，两种帧各走各的 method）。seq 连续才增量应用；
   跳跃（订阅空窗漏帧）或重连基线落后 → 静默全量重拉收敛；重复投递按
   `appliedThroughSeq` 水位去重。确定性优先，不做复杂 gap 回填。
4. **渲染**：自绘 `ReviewDiff` 行渲染器——沿用 DiffBlock 的视觉约定
   （`--dsw-*` token、`- `/`+ ` 前缀带色、22px 行高、pre 不折行），**不渲染
   行号**（数据没有行号，诚实呈现），每行 sticky 评论按钮。多 hunk 按
   **一 hunk 一卡**分块（折叠按单 hunk 计——连排折叠的中段恰好藏掉 hunk
   边界；hunk 间零分隔行，路径只在分区标题出现）。
5. **评论锚定**：`{文件, 编辑事件 seq, hunk 序, 侧, 行序, 引用行文本}` 六元组
   （会话模式的「hunk + 引用行文本」锚定）。回灌 = 把全部草稿组装为**一条**
   `session.prompt` queue 模式普通用户消息（`- path（第 N 次） ·「引用行」 —— 意见`
   格式），不发明评论存储协议；agent 的后续修改经 live 增量实时反映回面板，
   审查闭环完成。
6. **内存态边界**：已审标记与草稿按会话分桶、页面 React state 承载（面板页
   永不卸载，tab 切换/列折叠只翻转 active）；不落盘、不跨会话泄漏。已审
   **锚定编辑事件 seq 而非文件路径**（改动级标记，文件头三态勾选 + 进度
   计数是派生态）——agent 的新编辑天然未审，「已审后又有新改动」在模型上
   不会漏审，无需补偿逻辑；文件级 Viewed（GitHub 式）只适用于静态 diff。
7. **测试**：聚合器/评论序列化纯函数单测 + 信封观察过滤单测（file-browser
   的 api.spec 同款假源），19 例；UI 手测走 `pnpm dev`。

## 后果

- 零 patch、零上游源码改动、零既有仓库文件改动（stage/bundled-plugins/
  profile 物化全部自动发现 `packages/plugins/*`）。
- **pin 升级核对点**（集中在两个文件）：`api.ts` 的 wire 契约
  （`session.history`/`session.prompt` 方法名与载荷、SSE method=帧 type、
  `subscribeEnvelopes` 不在 IApiClient 接口上）与 `aggregate.ts`/`ui-primitives.d.ts`
  的 FsDiffMeta/FileDiff/DiffHunk 形状。上游 developer preview，接口可变。
- 行号缺失是会话模式的固有限制：引用行文本锚定在 agent 侧靠内容定位，
  极端场景（同文本多行）靠「第 N 次编辑」序数消歧；精确行号锚定随 v1
  git 改动源（`git diff` 输出带 `@@` 头）引入。
- 会话模式统计为「累计编辑量」口径（同一文件多次编辑重叠求和），面板
  提示条已声明；净变更口径由 v1 git 模式覆盖。
- 超长会话全量回拉有成本（每页 50 消息 × 60 页上限），页上限保护 +
  truncated 标注兜底。
- **滚动模型为 panel 级**（后续迭代定案）：页面自然生长、借用 panel-shell
  座位本来的滚动（滚动条贯穿面板全高），页面不设 `height: 100%` 也不设
  内层滚动容器；文件头 sticky 吸顶、草稿托盘 sticky 底部。摘要条与口径
  提示随内容滚走（用户拍板）。教训记录：本 app 无全局 border-box 重置，
  `height:100% + padding` 组合曾使页面恒定溢出座位 24px 产生幽灵滚动条；
  内层 `overflow-y:auto` + flex 曾把分区压成假视口（`overflow:hidden` 令
  `min-height:auto` 失效）——两者都被 panel 级滚动模型整体消除。
- v1 增量：host 半只读 git 路由（uncommitted 改动源 + 带行号 diff 视图 +
  精确行锚定）、restore 撤销路由（唯一破坏性操作，强确认）、
  F6/F8/F16/F19（F19 直接调 0009 缝的 `fileBrowser.tryOpen`，成本已骤降）。
