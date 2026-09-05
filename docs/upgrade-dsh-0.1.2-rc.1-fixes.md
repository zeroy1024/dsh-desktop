# 0.1.2-rc.1 迁移运行时回归修复

本记录取代阶段计划中已过时的“暂摘”和“全绿”结论。仅类型检查和基于旧结构的模拟测试无法证明插件在新版运行时能工作。

## 根因与修复

- **面板依赖链阻塞**：panel-shell 强制依赖 trajectoryPanelPage，但 0007 未登记。恢复 0007，并让面板只依赖自己的核心服务；轨迹通过可选服务和已声明的页面槽绑定。文件、审查不再跟随轨迹缺席而永久 pending。
- **轨迹注册失败**：跨服务取出的 slots.register 丢失 receiver，造成只有页面元数据没有实际槽。0016 保留 receiver，并将轨迹页标记为需要会话。桌面 inspect 转换为新版 viewRequest/completeViewRequest。注册对账合并到微任务，避免两半事务中途的假错误。
- **设置卡消失**：vision/web-search 启动时只探测一次 settings，服务稍晚激活就永远不注册命名空间。改为 ctx.inject 跟随服务生命周期，仍允许无 settings 的宿主运行。
- **凭据读写失效**：connection.api 已不存在。客户端改用 remote.credentials 的位置参数和 RemoteResult；适配器只保留表单控制器的内部数据结构，不再模拟网络协议。
- **活动分组渲染失败**：会话控制快照已不含 chat。节点与顺序改用 useChat，running 继续用 useSession；词典从 conversation 改为 chat。
- **文件与审查的数据通道失效**：移除旧 /api/host.describe、host.openPath、session.history、session.prompt 调用。文件打开走 remote.session.openWorkspacePath；文件活动和审查订阅已有 Session.eventSource；审查历史由 Session.loadOlder 分页，评论由 Session.prompt 发送并检查失败结果，不创建第二条事件流。
- **新建文件没有审查 diff**：新版日志不再附带运行时生成的工具展示视图。空 meta.diffs 的 write 结果从配对 tool/call 的参数恢复内容。
- **撤回测试失效**：恢复被 describe.skip 和 @ts-nocheck 掩盖的真实 vendor 包测试，适配 snapshotEvents；覆盖墓碑截断、重放、非法边界及 fork 行为。
- **冒烟误报成功**：Electron 现在会拒绝面板注册对账错误，而非只检查桌面标题栏标记。

## 验证

- 完整 upstream 同步构建和 vendor tarball 分发完成；轨迹包进入本地 override 闭包。
- 登记队列正向套用、反向撤销通过；登记补丁携带的 11 个 spec，共 291 项上游测试通过。
- workspace 单测、类型检查、lint、Node 原生依赖探针通过。
- dsh HTTP 冒烟，以及真实 Electron 冷启动和 agent 重启冒烟通过。
- 隔离 DSH_HOME 和临时工作区中的浏览器验证：设置卡可见、模型选择器可见、轨迹页面渲染、文件树刷新、Markdown 预览、审查页面、消息撤回及原文回填、归档与恢复、会话导出。
- 新增回归测试覆盖延迟 settings 激活、Remote 凭据调用、分离的 Chat/Session 快照、可选轨迹依赖、已有会话事件源订阅/分页、评论提交失败以及新建文件 diff。

`ci:verify-vendor-lock` 与 HEAD 中旧锁文件比较，因此在尚未提交新的轨迹本地 override 时会报告预期差异；锁文件已随同步更新。未为了让该检查变绿而自动提交或放宽检查规则。

## 验证边界

本机为 macOS；Windows/Linux、安装包产物尚需对应 CI。隔离环境没有真实模型凭据，未调用外部视觉/搜索模型；其协议和转换逻辑由自动测试覆盖。

## 后续回归：模型入口与两层折叠

- 自定义模型入口在首次创建会话目录时抛出 `cannot get property "remote.session" without inject`，渲染器随后退回官方二级菜单。补齐调用作用域的 `remote` / `remote.session` 依赖，保留原先模型列表与推理等级分段控件。隔离运行时已验证 High → Low，以及 Flash → Pro 的实际选择成功。
- 0017 让活动组复用 ChatNodeSeat 的总折叠状态、可搜索隐藏与回合锚点，避免总折叠收起后摘要仍显示。最终回答单独装配，避免被组首过程行连带隐藏；Chat 快照更新会重新核对分组边界。
- 模型插件 13 项测试、上游 292 项测试、补丁正反向演练、类型检查和 Electron 冷启动/重启通过；lint 仍只有既有测试辅助函数的作用域警告。
- 隔离浏览器会话使用 8 次工具调用、4 段过程思考和带思考的最终回答回放：先展开总折叠及活动组，再关闭总折叠，活动组高度为 0，最终回答仍可见，控制台无异常。

### 文件预览整页空白：Markdown 必填参数遗漏（2026-09-05）

- 复现：在旧会话中打开 `security_best_practices_report.md`。原生 `MarkdownText` 遇到 fenced code block 时读取 `labels.code`；文件插件仍只传 `text`，导致 `Cannot read properties of undefined (reading 'code')`。上游 list slot 会撤下崩溃的注册项，所以文件页签仍在，但内容为空，后续链接也无法恢复该项。不是文件系统读取失败。
- 修复：为文件预览传入随翻译函数更新的 memoized `labels`（复制、已复制、脚注），同步收紧本地 ambient 类型中的必填属性。无需上游 patch。
- 验证：文件插件 88 个单测、类型检查及构建通过；在隔离 profile 中复制受影响会话日志，修复前真实浏览器复现崩溃，修复后同一会话链接打开报告及刷新恢复预览成功。另使用 `packages/plugins/file-browser/tests/fixtures/markdown-preview.md` 实测代码块和脚注一起渲染，插槽错误节点为 0。
- 验证边界：上述原生渲染验证为手动驱动的浏览器集成检查，不属于现有 88 个自动单测。已经崩溃的桌面渲染器需重启应用加载新插件，关闭再打开文件 tab 无法撤销上游的注册项退场状态。
