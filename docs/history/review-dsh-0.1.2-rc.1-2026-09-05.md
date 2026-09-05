# 0.1.2-rc.1 迁移全面审查

> 历史记录：仅反映文中所述检查或调研时点，不代表当前功能、缺陷或验证状态。当前入口见[文档索引](../README.md)。

> 以下为整改前发现。14 项问题的处理、最终补丁边界和验证结果见
> [Review 整改记录](review-remediation-dsh-0.1.2-rc.1.md)。

审查日期：2026-09-05。分支：`upgrade/dsh-v0.1.2-rc.1`，HEAD：`fecc66d`；上游 pin：`a66e4702047846cdaa10c66c9d3df3951f5ea70d`。

范围包括相对 main 的提交、当前未提交修改和未跟踪迁移文件，以及自有代码中与迁移相关的原有实现。覆盖 Electron、agent-host、bridge、plugin-kit、全部插件、构建与分发脚本和全部 16 个登记补丁。审查没有修改业务代码或 upstream。

**结论：建议修复下面的问题后再合并。架构方向总体符合“子进程 + 协议、插件优先、vendor 编译依赖”的边界；目前最明显的不足是实际 Cordis 装配契约、跨会话异步归属、增量数据处理及运行时生命周期。测试全绿不能覆盖这些问题。**

共确认 14 项问题，其中 4 项 P1、10 项 P2。P1 表示应优先修复的功能阻断或错误写入风险，P2 表示有明确触发条件的正确性、性能或生命周期缺陷。下文区分本次迁移回归与 main 已存在的问题。

## 确认的问题

### F01 · P1 · 迁移新增：Remote 命名空间缺少 inject 声明

位置：[vision/index.ts:13](../../packages/plugins/vision/src/client/index.ts#L13)、[web-search/index.ts:10](../../packages/plugins/web-search/src/client/index.ts#L10)、[file-browser/index.ts:18](../../packages/plugins/file-browser/src/client/index.ts#L18)。

vision 和 web-search 只声明 `remote`，实际 `credentialAdapter` 在 describe/set 时访问 `remote.credentials`；file-browser 实际访问 `remote.session.openWorkspacePath`。0.1.2 的命名空间是独立 Cordis service，父级 `remote` 的注入不授予子服务访问权。

使用 vendor 的真实 Cordis、独立 sibling Service 和相同 consumer inject 声明复现，输出：

```text
credentials cannot get property "remote.credentials" without inject
session cannot get property "remote.session" without inject
```

结果是两张设置卡无法正常读取/保存密钥，文件页的系统打开失败。后者又被 `FileBrowserPage.tsx:484` 的 catch 静默吞掉。官方 ui-settings-plugins 和 ui-chat 已显式注入这些命名空间。

**建议：**分别声明 `remote.credentials` 和 `remote.session`。保留现有控制器单测，增加真实 Cordis 装配用例；普通对象 mock 无法检查服务访问权限。

### F02 · P1 · 既有：旧会话的撤销回调会覆盖新会话 Git 面板

位置：[ReviewPage.tsx:348](../../packages/plugins/review/src/client/ReviewPage.tsx#L348)。

`restoreGitFile(sessionId, path).then(() => loadGit(epochRef.current))` 中，`loadGit` 捕获旧 sessionId，却被传入当前会话的 epoch。A 的恢复请求尚未完成时切换 B，A 请求完成后会重新读取 A，并通过 B 的 epoch 检查，把 A 的文件显示在 B 面板中。

页面级复现确认：读取顺序 A → B → A；B 面板重新出现 A.ts；此时再次点击恢复，调用变成 `restoreGitFile('B', 'A.ts')`。若 B 中同路径也有修改，就会执行用户未意图针对 B 发起的恢复。当前分支新增的会话切换隔离 effect 没覆盖这条路径。

**建议：**发出恢复操作时捕获 sessionId、epoch 和请求代数；成功、失败及刷新分支均验证归属，过期回调不得改变新会话的 state 或 generation。

### F03 · P1 · 既有：单文件恢复把文件名当成 Git 通配表达式

位置：[git-handler.ts:261](../../packages/plugins/review/src/git-handler.ts#L261)。

虽然请求 path 必须匹配真实 status 条目，`git restore ... -- rawPath` 中的 `--` 只结束选项解析，仍保留 Git pathspec 的通配语义。macOS/Linux 合法文件名可以包含 `*`、`?`、`[]` 等字符，不能据此假设它是单个精确路径。[Git literal pathspec 文档](https://git-scm.com/docs/git#Documentation/git.txt---literal-pathspecs)

独立 Git fixture 创建并提交真实文件 `*.txt`、`one.txt`、`two.txt`，修改三者后选择 `*.txt`。执行当前 handler 的 argv 后三个文件全部恢复 HEAD，status 变为空；用户仅选择的一个文件扩展成了多文件丢弃操作。

**建议：**使用 Git 全局 `--literal-pathspecs` 或明确的 literal pathspec，并继续保留服务端 status 校验。增加含特殊字符的真实 Git 单文件恢复用例，验证未选文件保持原样。

### F04 · P1 · 既有：会话位于仓库子目录时，恢复/删除会指向另一个文件

位置：[git-handler.ts:236](../../packages/plugins/review/src/git-handler.ts#L236)、同文件 254 和 261 行。

`git status --porcelain=v1 -z` 返回仓库根相对路径，但 handler 用会话 cwd 作为拼接和 Git 命令的基准。若会话在 `repo/sub`，status 中 `sub/tracked.txt` 指的是 `repo/sub/tracked.txt`，当前 restore 实际指向 `repo/sub/sub/tracked.txt`。[Git porcelain 路径约定](https://git-scm.com/docs/git-status#_porcelain_format_version_1)

独立 fixture 确认两种错误写入：两个 tracked 文件都有改动时，选择前者却成功恢复后者；两个 untracked 文件存在时，选择 `sub/new.txt` 却删除 `repo/sub/sub/new.txt`，选中的文件仍存在。只读 untracked diff 也使用错误基准，并可能被当成正常 exit 1 静默遗漏。

**建议：**明确区分 session cwd、Git toplevel 和传输路径的坐标。统一 status/diff/restore/unlink 的基准，并过滤或拒绝超出会话授权目录的条目；不能只改 `git -C` 而扩大允许删除的路径范围。补仓库子目录与同名嵌套文件用例。

### F05 · P2 · 迁移新增：多代鉴权 Cookie 累积导致启动返回 431

位置：[index.ts:555](../../apps/desktop/src/main/index.ts#L555)，恢复导航同文件 424 行；默认 WebContents 会话见 [splash.ts:51](../../apps/desktop/src/main/splash.ts#L51)。

上游 BrowserAuth 根据含端口的 authority 生成不同 `dsh-auth-*` Cookie 名，Cookie 的作用域却为主机、`Path=/`，默认有效 30 天。Electron 使用持久 defaultSession，agent 每代使用 `--port 0`，没有清理旧鉴权 Cookie。Cookie 同主机跨端口共享，因此每次新请求都可能携带前面各代的 Cookie。[RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)

以实际 Cookie 编码格式和 Node 24.20.0 默认 HTTP server 验证：70 个 Cookie、15958 字节返回 200；72 个、16414 字节返回 431。阈值会随端口长度和其他请求头变化。验证的是请求头阈值和源码累积路径，没有连续启动 72 次 Electron。Node 默认请求头上限为 16 KiB。[Node HTTP 文档](https://nodejs.org/api/http.html#httpmaxheadersize)

**建议：**让 WebUI 使用应用明确拥有的 session/partition，统一首次启动和恢复导航，在新一代首载前清理该应用历史鉴权 Cookie，保留 UI 存储。不要清除用户所有浏览数据，也不要仅靠提高 header 上限掩盖无限累积。补多代 Cookie 用例。

### F06 · P2 · 迁移遗漏：自定义数据路由未接入新版鉴权

位置：[file-browser/index.ts:67](../../packages/plugins/file-browser/src/index.ts#L67)、[review/index.ts:57](../../packages/plugins/review/src/index.ts#L57)、[archive-manager/index.ts:205](../../packages/plugins/archive-manager/src/index.ts#L205)、rewind 的 `registerRewindRoute`。

四个插件直接注册 `webServer` 路由，只检查 Host/Origin 等请求头。新版签名 Cookie 校验由 `connection.requestRejection()` 施加到 Connection 路由上，WebServer 本身没有全局鉴权。因此原生 `/api` 需要登录，自定义文件读取、Git 恢复、撤回、取消归档等路由仍可被无 Cookie 请求调用。

这是明确的认证边界不一致。触发者须能连接本机服务并取得有效 sessionId，例如同机其他用户/进程；不能据此声称任意跨站网页都能绕过现有 Origin 栅栏。Origin/Host 也不是本机调用者的身份凭据。

**建议：**复用公开 Connection API。只读下载/读取可用 `connection.fetch.register`，**pin 版本该 API 的方法类型仅支持 GET/HEAD**；写操作应使用正式 Remote/RPC，或由 Node handler 先调用 `connection.requestRejection(req)`。不需要新增上游 patch 或自定义代理。将共享的鉴权、错误信封与请求取消逻辑收敛到公共适配层。

### F07 · P2 · 既有：file-browser 和 review 卸载后遗留 HTTP 路由

位置：[file-browser/index.ts:67](../../packages/plugins/file-browser/src/index.ts#L67)、[review/index.ts:55](../../packages/plugins/review/src/index.ts#L55)。

两处丢弃 `webServer.register()` 返回的 disposer，注释却称生命周期随 fiber。实际上该方法是普通 Map 注册，不自行创建 effect。archive-manager 和 rewind 已正确显式管理 disposer。

以真实 vendor Cordis + WebServer 装配 file-browser，卸载 plugin 后 `/dsh-file-browser` 仍在路由表；重新注册得到 `webserver: duplicate prefix route "/dsh-file-browser"`。热重载会失败，遗留闭包还持有已卸载上下文。

**建议：**将每次 register 包在调用插件的 `ctx.effect` 内；若按 F06 迁到 Connection，使用它提供的 owner effect。补“装入 → 卸载 → 再装入”的真实装配测试。

### F08 · P2 · 迁移新增：0013 破坏所有流式事件的增量处理

位置：[0013:94](../../patches/0013-session-controller-rewind-fold.patch#L94)。

每个 raw append 都读取整个 `rawWindow.entries`、扫描墓碑并复制过滤窗口，包括从未发生撤回的会话。上游 event source 采用 rope 与惰性物化，conversation 正常只读取 `change.entries`；包装器把它变为每次 O(n)、累计 O(n²)，同步占用渲染线程。

用当前源码的 source/fold 做仅消费 delta 的无墓碑微基准，通知函数替换为等价正常监听循环：

| append 数 | 原始 source | 包装后 source |
|---:|---:|---:|
| 1,000 | 1 ms | 24 ms |
| 5,000 | 3 ms | 487 ms |
| 10,000 | 2 ms | 1,935 ms |
| 20,000 | 5 ms | 7,252 ms |

这些是单机微基准，不能当成端到端 UI 延迟，但足以确认复杂度退化。

**建议：**无墓碑时直接转发；缓存墓碑区间，普通追加/分页只过滤 delta，完整窗口保留惰性物化。仅新增墓碑或需要重建时发布 replace。

### F09 · P2 · 迁移新增：撤回遗漏 turnOutline 投影

位置：[0013:94](../../patches/0013-session-controller-rewind-fold.patch#L94)；上游 `ui-chat/.../ChatView.tsx:293`、`turn-rail-items.ts:68`、`session-turn-outline/src/projection.ts:96`。

补丁只折叠事件窗口，0.1.2 新增的 host `turnOutline` 对墓碑走 default、原样返回。ChatView 又把该投影与本地导航合并，即使本地节点已删除，仍把已撤回的 prompt/response 和失效 anchor 加回轮次导航。

直接执行投影 fold 和 rail merge：两个完整轮次后撤回到第一条用户消息，空的本地 rail 与 host outline 合并后仍有两个撤回轮次。正文与导航互相矛盾，点击不能定位已过滤的目标。

**建议：**让投影解释同一墓碑语义。优先用配置替换原生 `session-turn-outline` 为桌面投影插件，并增加 live、恢复、分页及导航组合测试；不必为此扩大 core patch。

### F10 · P2 · 迁移新增：历史分页失败被显示为完整审查结果

位置：[session-data.ts:24](../../packages/plugins/review/src/client/session-data.ts#L24)、[ReviewPage.tsx:101](../../packages/plugins/review/src/client/ReviewPage.tsx#L101)。

真实 `Session.loadOlder()` 在已有分页进行时直接返回，在请求失败时也内部捕获、不 reject。适配层可能得到 `events: []`、`hasMore: true`，页面却直接结束循环，设置 `ready` 且 `truncated=false`。

页面级复现使用真实 sessionData adapter 与无进展的 loadOlder：显示“没有改动”，没有加载失败或未完整加载提示。旧历史中的文件编辑可能被漏报。

**建议：**检查游标是否推进；`hasMore=true` 且无进展应等待已有分页，或显示不完整/可重试状态。只有明确耗尽历史才能显示完整 ready。

### F11 · P2 · 既有：取消视觉转写会把 rejected Promise 留在缓存

位置：[vision/index.ts:675](../../packages/plugins/vision/src/index.ts#L675)。

`failureResult` 对 VISION_ABORTED 重新抛错。pending Promise 已入缓存，而删除缓存的逻辑在 `await` 之后，拒绝时无法执行。此后相同图片命中同一个 rejected Promise，新的请求也立即取消。

用源码 `rewriteMessages` 连续调用两次，附件读取第一次抛 VISION_ABORTED：两次均失败，`readImage` 总计只调用一次，cache size 始终为 1。不会发送外部模型请求。

**建议：**在缓存 Promise 自身的失败处理上进行身份校验后删除，包括取消；调用方的取消与共享在途转写的生命周期也应分开考虑。补“取消后同图片重试成功”的测试。

### F12 · P2 · 既有：子进程 exit 与流 close 混用导致恢复/退出卡住

位置：[supervisor.ts:438](../../packages/agent-host/src/supervisor.ts#L438)，同文件 313、476 行。

CLI 已退出、孙进程仍继承 stdout/stderr 时，exit 已发生但 close 未发生。当前退出状态和重启依赖 close；stop 又以 exitCode/signalCode 非空认定已 closed，跳过升级终止，最后无限等待日志关闭任务。

真实 Node 父子进程 + 内存日志流复现：父进程 exitCode=0，supervisor 仍 running；stopGraceMs=50，500 ms 后 stop 仍 pending，显式杀进程组后才结束。上游子代理存在 `stderr: 'inherit'` 使用路径。

**建议：**分开跟踪 exit、close 与进程树终止；exit 及时使连接失效并更新状态，close 负责流收尾。close promise 和日志排空都需要明确的终止界限。

### F13 · P2 · 既有：升级时无法回收旧版本孤儿 agent

位置：[index.ts:665](../../apps/desktop/src/main/index.ts#L665)、[orphan-reaper.ts:97](../../apps/desktop/src/main/orphan-reaper.ts#L97)。

PID 记录保存了旧 `record.cliEntry`，回收却用当前版本入口比较。新版本 runtime 尚未解压时，resolveCliEntry 先失败导致跳过；若已解压，旧命令行不包含新入口，被视为 PID 复用并删掉记录。旧 agent 可能继续运行，新 agent 覆盖唯一 PID 记录。

**建议：**以记录的旧入口核实进程，验证路径属于应用管理的 runtime 根目录；不要求当前版本入口存在。补旧版本 PID 记录配合新版本未解压的升级测试。

### F14 · P2 · 既有：archive 剪枝删除运行时 Markdown 资源

位置：[stage-runtime-archive.ts:38](../../apps/desktop/stage-runtime-archive.ts#L38)，实际删除判定 60–66 行。

脚本删除所有 `.md`，但上游 dsh-skill-badge 在运行时读取 `assets/dsh-badge.md`。vendor 中存在该文件，现有 `.runtime-archive/dsh-cli.tar` 中确认缺失，只有 PNG、lib/index.js 和 package.json。启用默认关闭的 badge skill 后，打包版会因 ENOENT 失败，开发态不会。

**建议：**保留包发布的 runtime assets；剪枝仅针对明确不参与运行的 README/CHANGELOG 等文件。给最终 archive 增加延迟资源读取验证。

## 补丁能否改为插件

判断前提是保留目前的产品行为和原生组件复用。用插件复制整套上游组件、覆写私有方法，虽然形式上没有 patch，却会扩大长期维护面。

| 补丁 | 结论 | 具体建议 |
|---|---|---|
| 0001 会话行菜单/导出 | 相同行入口仍需缝；导出本身已有原生能力 | 原生 session-log-export 已有 header action 和下载 controller。接受原生入口即可撤；保留行菜单则添加通用 row action 贡献面，把动作定义留在插件。 |
| 0005 活动组 | 保留连续节点分组缝，可缩小 | 单节点 slot 不能包裹一段节点。315–329 行 `group.thinking/working/toolCalls/thinkingSteps` 双语词条只服务 activity-group，应移到插件自己的 locale。 |
| 0006 第四列 | 保留布局装配与几何缝 | 原生 ILayout 不提供第四列、宽度写入或 store；整体替换 layout provider 要自持大段 shell。旧 0004 合入同文件合理。 |
| 0007 轨迹面板 | 保留复用缝，减少桌面业务 | 原生不导出 TrajectoryView/注入工厂，图片子槽还受独占声明约束。收敛为通用视图贡献 factory，把 PanelTrajectoryView、图标、metadata、接管策略移到 panel-shell。 |
| 0008 inspect handoff | 保留最小可选缝 | 私有 inspectCall 直接打开 conversation tab，没有公开拦截点。 |
| 0009 文件打开 | 保留最小可选缝 | 私有 openFile 闭包不可配置；不建议 monkey-patch Remote。合入 0019 对参数与目录回退的修正。 |
| 0010 图片准入 | 保留 | 检查在 prompt 附件持久化前，LLM middleware 已太晚；不应伪造模型原生图片能力。 |
| 0011 LLM 输入转换 | 保留 | 原生 llm/stream options deep-frozen、next 无覆盖参数。重新 llm.stream 会改变已固定 adapter/capability 和重入语义，不是等价替代。 |
| 0012 core 墓碑 | 保留 | surface plan/apply 和 known event 集合不开放插件扩展；现有 surface replace 不等于 truncate。写入侧已正确留在 rewind 插件。 |
| 0013 client 墓碑 | 保留最小数据源缝，修 F08/F09 | 可考虑缝只接受插件提供的事件源投影；投影实现与桌面事件语义进一步下沉。 |
| 0014 设置图标 | 接受默认齿轮即可撤；相同效果仍需缝 | navIcon 硬编码，slot options 没有 icon。优先增加通用 icon 贡献面，避免 upstream 认识 archive-manager 产品 ID。 |
| 0015 Win32 UTF-16 | **存在正式纯插件替代路径** | DirectoryPicker 支持子类 capability provider；native 包提供 pickNativeDirectory 与 pickWin32Dialog 回调。可以桌面 provider + 配置替换，但保持同款 COM dialog 需自持 Win32 backend。一行拷贝式读取 patch 的维护成本更小，登记应记录此取舍，不应声称插件不可达。 |
| 0016 receiver 修正 | 合回 0007 | 属于同一接缝实现修复。 |
| 0017 轮次 visibility | 合回 0005 | 属于活动分组与 ChatNodeSeat 的完整集成。 |
| 0018 hover 快捷归档 | 合回 0001；接受原生菜单即可撤 | 归档操作已原生，此补丁只恢复按钮位置。 |
| 0019 行为回归集合 | 拆回对应原补丁 | 分别属于 0009、0010、0013、0005、0006；应让每个补丁独立表达需求、测试和撤销条件。 |

此次迁移已经正确利用上游新增能力：行菜单的原生 rename/fork/archive 不应再自持；迁移期间重复的 slots increment 补丁已清理（不代表原生支持活动分组）；settings 改用 installSection、数据读取改用 resident Session、model-selection-direct 改用显式命名空间是正确方向。无需把已经被上游吸收的旧 patch 重新加回来。

原生 fork 不能完全替代同一 sessionId 的原地 rewind；把此产品行为差异当成“可以删 0012/0013”会改变用户语义。共用 DSH_HOME 时，官方 CLI 拒读含桌面墓碑的日志是 ADR-0007 已记录的取舍，不作为此次新发现。

## 实现质量改进

1. **公开类型从 vendor 包导入。** 边界禁止 import upstream/src，不禁止 import 已发布 tarball 的公开类型。稳定 API 优先使用 `import type`，结构镜像只保留真正的私有 seam。尤其是 Remote namespace 和参数形状，不能只由测试 mock 自证。
2. **文件刷新按变化范围处理。** file-browser/session-data.ts:57 对每个 tool/result 加入空路径，导致重读全部已加载目录和缓存预览。记录 tool name，已知 write/edit 按路径更新；shell/未知写入工具、重连才全量失效，合并重复刷新。
3. **审查历史按可见性加载。** ReviewPage.tsx:145 的初始化没有检查 active；隐藏 tab 也会拉最多 60 页，并扩展共享 resident Session。首次激活再加载，隐藏时停止继续分页。
4. **保持测量对象身份。** desktop-frame/Titleband.tsx:212 把 geometryRef.current 传给 observer，但 sync 在 183 行替换对象，后续测量写到旧对象。保持对象身份或让 observer 每次读取 ref，并观察真实按钮簇的尺寸。
5. **多步注册要能回滚。** metadata 注册后 slot 注册若抛错，尚未返回的组合 disposer 无法撤 metadata。使用逐步收集 disposer 的 effect，或明确 try/catch 逆序回滚。
6. **隔离兼容适配层。** vision 的旧 llm/stream 路径与新 input-transform 路径同时维护；固定 pin 的桌面产品可明确只支持当前契约。若保留兼容，放到单独 adapter，避免把兼容分支当成当前 API 能力证明。
7. **归档恢复仍有私有耦合。** WorkspaceRegistry 暂无公开 unarchive，当前加 guard 且共用 enqueueOperation 比直接写存储更合理；不要为消除类型断言而绕开 registry 内存状态。建议推动公开 unarchive API，再移除 private state/setState 依赖。
8. **测试以服务边界为重点。** 保留纯函数与 UI stub 测试，补少量真实 Cordis 激活/卸载、namespace 授权、分页无进展、取消后重试、跨会话异步和最终 archive 资源用例。React 外部订阅仍应遵循稳定 subscribe 和不可变 snapshot 契约。[React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)

Electron 的 contextIsolation、sandbox、禁止 nodeIntegration、当前 agent origin 导航/IPC 栅栏，以及子进程隔离的基本方向正确，符合官方安全建议；当前审查没有发现应退回自定义协议 HTTP 代理的理由。[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)

## 验证与限制

- 根 scripts 与全部有测试的 workspace：**86 个测试文件、541 个测试通过**。另有两个临时页面级缺陷复现测试通过，断言的是错误行为确实出现。
- 根 TypeScript 与全部 17 个 workspace 类型检查通过。
- oxlint 通过，有一个现有 warning：scripts/tests/smoke-dsh.spec.ts:125 的 consistent-function-scoping。
- 16 个补丁在 `git archive HEAD` 导出的独立临时仓库中按登记顺序 apply/check，随后逆序撤销，回到完全相同的基线。
- 独立 scratch index/object directory 校验：当前实际改动与登记补丁 diff 完全相同，43 个 diff sections。未确认 rehearse 的顺序比较存在当前故障。
- 使用现有 node_modules 的 tsc/vitest/oxlint 执行等价检查。pnpm 自动版本切换被环境网络阻断，不能据其错误消息判定仓库或锁文件被篡改；未绕过包签名校验。
- 部分回环 HTTP 测试初次被沙箱以 EPERM 阻止，随后在获准的测试执行环境下全部通过。
- 没有重建 vendor、执行 sync:upstream 或修改 upstream；没有完成真实 Electron 多轮重启、Windows/Linux GUI、完整发行安装包端到端回归。因此这里的 Cookie/管道/导航等复现范围按各条说明，不冒充跨平台 UI 实测。
- 未证实 0007/0016 的卸载 fallback 假设，不将其列为缺陷；仍建议重构该接缝时补真实 slots 装配覆盖。

建议顺序：先处理错误写入与功能阻断，再修迁移引入的鉴权/数据投影/性能问题，随后收敛 patch 队列和运行时既有缺陷。以上改进均可在现有分层内完成。
