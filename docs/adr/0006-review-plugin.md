# ADR-0006：Review 面板与行级评论回灌

- 状态：已接受；2026-09-06 整理为当前实现，包含 0.1.2-rc.1 迁移修订。
- 初始日期：2026-09-03
- 关联：[插件说明](../../packages/plugins/review/README.md)、[内置插件分发](0004-bundled-plugins.md)、[历史选型调研](../history/review-research-2026-09.md)

## 背景

桌面需要按文件检查 agent 改动、写行级意见并回灌会话。上游的会话 diff 卡缺少独立汇总
和评论交互，但已有 panel-shell 页面容器，因此功能优先通过双半插件实现。

会话的 durable diff 来源是工具结果的 `meta.diffs`：每个 hunk 只有旧/新文本，缺少源码行号。
新建文件的结果可能没有 diff，需要从配对 write 调用参数恢复内容。Git 则提供带行号的
unified diff，能呈现 shell 修改和工作区净变更。两者不能混用统计与评论锚点。

## 选项与决定

- 把完整 Review 页面写入上游补丁：否决，面板扩展点已够用，产品逻辑应留在插件。
- 直接复用原生 DiffBlock：其交互面不足以支持行级评论；自绘 diff 行，沿用原生字体与语义色。
- 插件内组合会话与 Git 来源：采用。最初先实现会话模式，随后增加 host Git 路由。
- AI reviewer 与 PR bot：独立的后续产品方向，不纳入当前面板实现。

`packages/plugins/review` 通过 `panelShell.registerPage` 与页面槽两半装配，要求当前会话，
注册由同一生命周期管理。Review 本身不新增专用上游补丁，复用已有面板、会话与鉴权接口。

## 数据与状态决策

1. **会话数据**：消费 resident `Session.eventSource`，历史由 `Session.loadOlder()` 补齐。
   通过原始 `historyStartSeq` 判断分页推进，避免撤回隐藏整页后误报加载完毕；失败报错，
   页数上限标记 truncated。隐藏页停止补页，token 追加不触发完整改动扫描。
2. **Git 数据**：host 注册同源 GET 快照路由，返回状态与 diff 原文；客户端解析 hunk 和行号。
   范围为会话 cwd 内未提交改动，包含 untracked；输出和执行时间有界。
3. **评论**：会话模式按文件、事件 seq、hunk、侧、行序及引用文本定位；Git 模式按真实行号。
   全部草稿合并为一条 `Session.prompt(..., 'queue')` 普通消息，成功才移除提交快照。
4. **已审状态**：会话模式按编辑事件 seq，新编辑天然未审，文件头派生三态；Git 模式按路径。
   草稿和标记按会话分桶，仅内存态，不引入新的持久化协议。
5. **撤销文件**：仅 Git 模式，二次确认；tracked 恢复到 HEAD（含 index 与 worktree），
   untracked 删除。路径必须在会话 cwd 内并匹配实时 status 白名单，使用 literal pathspec。
   Cookie 鉴权、同源判定、路由卸载与请求代次限制由现有基础设施和插件共同维护。
6. **布局**：复用 panel-shell 整页滚动，文件头 sticky、草稿区 sticky，摘要随内容滚动。
   不叠加 `height:100% + padding` 或内层滚动容器，避免固定溢出和假视口。
   摘要条保持单行，排序与批量标记放入菜单。

## 迁移记录与后果

最初 0.1.1 的 `session.history` RPC、共享 mux 信封观察和手写 prompt 信封已在 0.1.2
被 resident Session API 替代；旧协议不能再作为开发范本。
当前升级核对点是 Session 事件视图、分页和 prompt 返回值、工具 diff 元数据、
panel-shell 两半注册，以及自有路由的公开鉴权契约。

会话模式的累计编辑量不代表净改动，且不包含 shell 改文件；Git 模式承担净变更视角。
缺行号的会话评论使用引用文本，重复文本的歧义通过编辑序数辅助定位。
精确能力与尚未实现的项目统一维护在[插件说明](../../packages/plugins/review/README.md)，
不在 ADR 复制功能复选清单和易变测试数量。
