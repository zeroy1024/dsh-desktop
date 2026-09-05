# @dsh-desktop/review

右侧「审查」面板，用于人工检查 agent 和工作区改动、写行级评论并发送给当前会话。
默认显示会话改动，切换工作区模式时按需加载 Git 未提交改动；AI 自动审查与 PR bot 尚未实现。
架构取舍见 [ADR-0006](../../../docs/adr/0006-review-plugin.md)。

## 当前能力

| 能力 | 会话改动 | 工作区改动（Git） |
| --- | --- | --- |
| 数据范围 | 当前会话 write/edit 的编辑时间线 | 会话工作目录范围内 tracked 和 untracked 未提交改动 |
| 统计口径 | 累计编辑量，同一区域多次编辑重复计数；不覆盖 shell 修改 | 相对 HEAD 的净改动及未跟踪文件 |
| diff | 按文件、编辑事件和 hunk 分组，无精确行号 | 解析 unified diff，保留旧/新侧行号 |
| 评论锚点 | 文件、事件 seq、hunk、侧、行序和引用文本 | 文件、侧、行号和引用文本 |
| 已审标记 | 按编辑事件 seq，文件头派生三态；新编辑天然未审 | 按文件路径 |
| 单文件撤销 | 不提供 | 二次确认后恢复 tracked 文件或删除 untracked 文件 |

两种模式均提供文件折叠、diff 复制、手动刷新、行级评论草稿和中英文主题适配。
摘要条保持单行：统计区弹性收缩、长分支名省略；刷新按钮旁的「审查选项」菜单
提供改动量/路径排序和全部标记/取消已审操作。内容借用 panel-shell 的整页滚动，
文件头吸顶、草稿区贴底。

草稿按会话保存在内存中，发送时合并为一条普通用户消息。发送失败保留草稿；成功只移除
提交时的草稿快照，发送期间新增或修改的意见保留。已审标记和草稿不跨应用重启持久化。

## 数据与生命周期

- 客户端通过 `panelShell.registerPage` 与对应页面槽装配，需要当前会话。
- 会话数据复用 resident `Session.eventSource`，通过 `Session.loadOlder()` 补齐历史；
  `historyStartSeq` 判断原始分页是否推进，整页被撤回隐藏时仍可继续加载。
  分页失败显示错误，达到页数保护上限时标记不完整。隐藏面板停止补页。
- 普通 token 增量不触发改动重建；编辑相关事件、撤回和重连触发更新。
  新建文件缺少持久化 diff 时，从配对 `tool/call` 的 write 参数恢复内容。
- 评论通过 `Session.prompt(..., 'queue')` 发送，检查返回结果。插件不另建事件流或手写旧版 history/prompt RPC。
- Git 由 host 的 `GET /dsh-desktop/review/git` 返回状态和 diff 原文，客户端解析。
  `POST /dsh-desktop/review/restore` 只接受当前工作目录内、实时 status 白名单中的路径。
- 自有路由复用上游 Cookie 鉴权和 bridge 同源校验，并随插件卸载移除。
  Git 使用参数数组、超时、输出限制、literal pathspec，禁用外部 diff helper/textconv。
  切会话后旧请求和撤销回调不能覆盖新会话。

单文件撤销会同时丢弃 tracked 文件的暂存和未暂存修改（恢复到 HEAD），或删除 untracked 文件；
它不是仅撤销 agent 最近一次编辑，也不等同于 Rewind 的会话上下文撤回。

## 限制与后续方向

- Git 范围目前只有 uncommitted；base branch、指定 commit 和 PR 范围尚未实现。
- 会话模式没有可靠的源码行号，评论使用引用文本定位；不通过重放补丁计算净改动。
- 大 diff、二进制和输出截断会降级显示；历史加载上限见 `src/client/api.ts`。
- 文件过滤/只看未审、词级高亮、空白符与上下文展开、文件级快捷意见、文件浏览器联动仍待实现。
- Git 快照时间标注、完整重命名展示、评论锚点漂移重定位、键盘逐 hunk 导航、
  会话 diff 跳入面板及「上次审阅以来」比较仍是后续方向。

## 开发验证

在仓库根目录运行：

```bash
pnpm --filter @dsh-desktop/review test
pnpm --filter @dsh-desktop/review typecheck
pnpm --filter @dsh-desktop/review build
pnpm stage:plugins
```

真实交互通过 `pnpm dev` 验证；通用构建与冒烟入口见 [CI 文档](../../../docs/ci.md)。
