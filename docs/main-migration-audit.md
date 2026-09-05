# main → dsh 0.1.2-rc.1 补丁与插件逐项审计

> 本文保留迁移过程记录。后续 0016–0019 合并及最终补丁边界见
> [Review 整改记录](review-remediation-dsh-0.1.2-rc.1.md)。

基线：`main@7868c8f`，上游 `b150a551`（0.1.1-rc.2）。目标：当前分支及工作区修复，上游 `a66e4702`（0.1.2-rc.1）。本记录包含本轮全面对照，以及前两轮已复现并修复的迁移问题；没有把“可以套补丁”视作功能等价。

## 判定依据

1. 对照 main 登记队列、补丁新增行为、13 个插件的入口/配置/呈现/测试。
2. 按当前 pin 的实际服务实现核对调用、生命周期、数据结构和渲染控制，不按旧模拟类型推断兼容。
3. 实现继续遵守插件优先、上游只经登记补丁、vendor 分发与子进程边界。
4. 没有发现具体缺陷的模块保留实现，避免借升级重写功能。测试分别证明补丁可重放、产物可构建和可观察行为。

## main 补丁逐项对照

| main 补丁 | 当前实现与结论 | 修复与验证 |
| --- | --- | --- |
| 0001 会话行右键/归档/导出 | 新版自带菜单；迁移保留了右键和 ZIP 导出，但漏了 main 的悬停单击归档 | 0018 补回快捷归档，保留新版菜单；空会话不提供动作。行组件测试覆盖不误打开会话、菜单动作与导出；浏览器已验证导出 ZIP、快捷归档及设置页恢复 |
| 0004 侧栏默认宽度 | 合入 0006，非功能删除 | 320 默认宽度与列让位测试保留，不重复打同一区域补丁 |
| 0005 活动分组缝 | 宿主 ui-conversation → ui-chat；Chat 与 Session 状态已分离；组外壳绕过新版总折叠 | 插件改用 useChat；0017 共用 ChatNodeSeat 的隐藏和回合锚点，并拆出最终回答；总折叠、普通模式、分页不完整与 beforematch 回归 |
| 0006 四列面板/收轨/放大 | 保留 main 的面板尺寸、动态让位、拖动、0px 收轨、cqi 放大与重型槽 memo | 新版 details 槽在 SessionProvider 内保留 eager 调用，满足槽声明契约；列/store/AppFrame 测试和 Electron 启动验证 |
| 0007 轨迹面板页 | 原文件存在但未进入有效队列，强依赖又阻塞文件/审查；跨插件注册丢 receiver | 恢复登记，面板先声明页面槽再消费可选轨迹；0016 绑定 receiver、限制为有会话页面；保留 web 回退、卸载恢复与新版 viewRequest 转换 |
| 0008 Inspect 交接 | 原 ui-conversation 接缝迁到 ui-chat | 保留开面板→轨迹页→目标调用的交接；无服务走上游 openView；与 0007 一并验证 |
| 0009 文件点击交接 | 原回调迁到 ui-chat，底层打开协议已改变 | 保留 fileBrowser.tryOpen、目录/未处理路径回退；客户端系统打开改 generated Remote；文件预览实际验证 |
| 0010 图片准入 | apiproxy 接缝迁到 api-session-controller | 根据 capability/解析结果决定桥接，不伪造模型原生图片能力；准入 spec 覆盖原生、未知和失败路径 |
| 0011 单次 LLM 输入转换 | 注册/dispatch 接缝保留 | 对照新适配器边界与 signal；真实 vendor LlmRuntime 测试覆盖转换和原生跳过，保留会话原始图片事实 |
| 0012 服务端撤回墓碑 | 新版 Session 访问器改变，类型目录仍须登记 | 使用 snapshotEvents；保留非法边界、重放、fork 与非 ignorable 语义；真实 vendor 测试不再 skip |
| 0013 客户端撤回折叠 | 旧 runtime ingest 三口已不存在 | 改装饰 Session.eventSource：分页/序号保留原源，对外折叠可见窗口；初始、实时、分页与 rewind spec |
| 0014 归档设置图标 | 新版仍是内部 id 映射，没有插件图标面 | 重放一行映射；页面挂载与归档恢复验证 |
| 0015 Windows UTF-16 安全读取 | 上游仍用 external ArrayBuffer；仅修复了双字节扫描 | 保留 koffi.decode.string16 复制读取；mock binding spec 与本机原生探针。Windows 真机仍需对应平台 CI |

0016、0017、0018 是上述迁移接缝的后续修正，均登记理由；不是直接修改 submodule 的例外。已删除未登记的 0005-slots-increment 中间产物，以及被新宿主版本替代的旧 0008/0009/0010/0013 文件；新增检查要求每个 .patch 都在队列中恰好登记一次。

## 插件逐项对照

| 插件 | main 功能与新版风险 | 当前处理 |
| --- | --- | --- |
| activity-group | 连续工具/思考分组、运行统计、正文拆分；旧 useSession.chat 与新版总折叠不兼容 | 改 useChat、chat 词典；通过 0017 与总折叠统一控制；8 次工具调用的真实回放确认隐藏区高度 0，最终回答可见 |
| archive-manager | 归档列表、时间、恢复；恢复的自建全局队列不能与上游归档/工作区写互斥 | 改用同一 registry.enqueueOperation，在队列内重读状态，包括此前排队归档的 id；并发测试。继续对私有面缺失返回 501，不声称其已成为公开 API |
| desktop-frame | 标题栏、菜单、主题、侧栏/面板/放大及平台适配 | 对照布局、locale/theme/workspaces 调用与 preload 桥；没有额外接口漂移；保留原行为和 Electron 检查，Windows 材质不以 macOS 测试代证 |
| file-browser | 懒加载目录、多文件预览、外部文件、会话链接打开、布局持久化 | 旧 connection/host RPC 替换为 resident Session + Remote；重新进入、重连与无路径工具结果刷新已加载目录/缓存预览；消费 append delta，忽略 token，容忍工具自定义 metadata；强制读取用唯一 token 拒旧结果 |
| fps-overlay | 仅桌面 dev HUD | dev 门禁与 raf 清理保留；无业务 API 漂移；不改为生产常驻 |
| hello-panel | overlay 示例，默认禁用 | 装配面核对，正式构建不分发；修正 manifest 的包名元数据 |
| model-selection-direct | 一级模型列表与思考等级分段，官方选择器作 fallback | 补 remote/remote.session 调用作用域依赖；首次建目录不再崩溃退回官方二级菜单；实际模型/等级切换、重启持久化及插件测试 |
| panel-page-stub | 面板双半注册/徽标/诊断示例，仅开发模式装配 | demoBadge 从模块全局移到 apply，避免多实例和热加载串状态；正式构建不分发 |
| panel-shell | 页面登记、标签账本、Inspect、页状态保留、半注册诊断 | 去掉轨迹强依赖；先声明再供服务，可选轨迹注入；微任务合并登记检查、卸载取消回调；不再用定时轮询维持生命周期 |
| review | 会话编辑聚合、Git diff/撤销、审查标记和评论 | 旧 history/prompt/mux → resident Session；空 diff 新建文件恢复；chunks-only 历史页继续翻页；只对编辑相关增量重建；分页后读取当前完整可见窗口，避免把撤回前后的快照拼回已撤内容；请求代次拒旧结果；切换会话重新加载 Git，旧工作区响应不得回写；评论发送只清除提交时的草稿快照 |
| rewind | 用户消息撤回及文字回填，同会话继续 | 保留 ADR 的原地截断而非改成 fork；真实包测试恢复并做实际撤回验证；补充样式复核发现用户气泡仍写死旧版 16px/24px，现与新版 14px/22px 默认值及字号变量对齐，时间、动作尺寸和气泡宽度同步跟随新版；引用呈现已复用公开 projectUserText；时间格式近似与文字回填范围仍见 ADR-0007 |
| vision | 多协议辅助视觉、图片准入、缓存与设置凭据 | 修正延迟 settings 激活、Remote 凭据位置参数；installSection 的 owner 用长期插件 ctx，允许设置服务卸载后回退；真实 vendor 转换链与协议测试 |
| web-search | 注册搜索 provider、多协议、独立凭据/设置 | 修正同款设置和凭据漂移；保留官方 web_search 工具、provider 注册和原会话模型不变；协议/错误/取消测试 |

所有插件同时核对了 manifest：`dsh.client.inject` 是包名关系元数据，模块导出的 `inject` 才是 Cordis 服务依赖。迁移曾把前者混写为 slots/sessions/remote 等服务名，现已按新版客户端文档恢复包名；没有把两种声明混为一谈。

## 补充回归与验证范围

- 新增/恢复的回归覆盖：延迟服务、设置消费者身份、Remote 凭据、冷目录创建、Chat/Session 分离、可选轨迹、总折叠、归档与恢复并发、chunk 历史分页、分页期间撤回、Git 跨会话过期响应、编辑事件过滤、面板重新订阅及工具 metadata。
- 每次上游改动均通过 `pnpm sync:upstream` 重建 vendor，而不是靠已污染目录里的偶然构建结果。
- 验证命令：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm rehearse:queue`、`pnpm test:upstream-patches`、`pnpm build`、`pnpm ci:smoke:dsh`、`pnpm ci:smoke:electron`。
- `ci:verify-vendor-lock` 对比 HEAD 的依赖合同；新增本地轨迹 override 尚未提交，预期报告合同差异。没有为变绿而放宽门禁或自动提交。
- 本机浏览器/Electron 验证使用隔离 DSH_HOME。未调用付费视觉/搜索服务；Windows/Linux 真机与安装包由相应 CI 覆盖，不能从 macOS 单测推导它们已通过。


## 后续补丁语义复核与修复（0019）

此前通过的测试并不足以证明补丁与 main 等价。本轮沿调用链重新检查后，修复了四处此前遗漏：

- 0009：恢复 `tryOpen({ sessionId, cwd, path })`，路径先按会话工作区解析；`.` 跳过插件交接，未接管走系统打开，插件错误不再误当成功或重复启动系统打开。
- 0013：完整可见窗口与 `change.entries` 使用相同墓碑范围。已加载墓碑后再向前翻页，不会从增量通道重新送入被撤回事件；原始日志、游标和 hasMore 保持不变。
- 0005：AssistantNodeView 继续传递分块变体，AssistantMarkdown 实际筛选 reasoning/prose，保留原始块索引和连续图片分组；不重复正文、图片或停止标记。
- 0010：能力字段缺席且桥接放弃时继续放行，与旧补丁和原生一致；明确 text-only 仍拒绝，解析失败仍由桥接或原错误处理。

0019 同时恢复面板拖动、双开手柄位置、关闭保持挂载、放大与恢复、静态槽重派发五项旧回归。details 按新版声明契约保持 eager 调用，不纳入静态槽次数不变断言。新增文件交接测试跨越实际 Chat 注入入口；分页测试按消费方的增量更新方式重建列表，避免只断言已过滤的完整快照。


本轮验证结果：上游 13 个补丁专项测试文件、310 项测试通过；本地全量单测、类型检查、完整 sync/build、队列正反向演练通过。隔离浏览器中的真实会话点击 `check.md` 打开内置文件面板并显示内容；加入中途正文的回放中，组收起时正文一份/该步思考不渲染，展开后正文一份/思考一份，控制台无错误。macOS Electron 启动与重启通过。Lint 仍仅原有 smoke-dsh warning；不据此宣称全部平台与外部服务已验证。
