# dsh 0.1.2-rc.1 迁移总结

2026-09-06 整理；汇总 2026-09-05 的迁移与后续修复记录，不代表重新执行验收。
迁移基线为 `main@7868c8f` / 上游 `b150a551`（0.1.1-rc.2），目标上游为
`a66e4702047846cdaa10c66c9d3df3951f5ea70d`（0.1.2-rc.1）。

本记录替代原升级方案、分阶段计划、运行时回归修复和 main 逐项审计中的重复说明。
早期“暂摘补丁”“已知降级”“全绿”均为中间状态，不能用于判断最终功能是否保留。
当前有效队列以 [patches.yml](../../patches/patches.yml) 为准。

## 保留的产品语义

- Electron 继续监管独立 dsh 子进程，渲染进程直连 loopback HTTP。
- 内置插件随应用 stage 和分发，物化 app 托管的 desktop profile。
- Rewind 继续在原会话撤回；上游 fork 是另一个会话分支操作，不替代撤回。
- 文件、Review、轨迹、模型选择、归档及导出保留原功能，通过新版公开接口适配。

## 关键迁移与修复

| 范围 | 最终处理 |
| --- | --- |
| 客户端服务 | Chat 与 Session 状态分离，活动分组改用 useChat；manifest 的 dsh.client.inject 声明包名，模块 inject 声明服务依赖 |
| Remote 与设置 | 凭据改用 remote.credentials 位置参数及 RemoteResult；补足 remote.session 作用域；设置注册跟随服务生命周期 |
| 面板与轨迹 | 面板先声明自己的槽，轨迹可选注入；保留注册 receiver，微任务合并两半注册检查；Inspect 接入新版 viewRequest |
| 活动分组 | 共用原生 Seat 的总折叠、搜索隐藏及回合锚点；最终回答独立装配，避免随组首一起消失 |
| 文件与 Review | 消费 resident Session.eventSource，分页使用 loadOlder 和原始 historyStartSeq；评论走 Session.prompt 并检查失败结果 |
| diff 与刷新 | 新建文件从配对 tool/call 恢复 write 内容；仅处理编辑相关增量；切会话、撤回及请求代次阻止旧结果回写 |
| Markdown 预览 | 原生 MarkdownText 补齐必填 labels，并收紧本地类型；缺参会使上游撤下崩溃的槽注册项，重开 tab 不足以恢复 |
| 鉴权与路由 | ready token 换 Cookie 后导航至干净 URL；只清理旧端口 Cookie；自有路由复用 connection.requestRejection 并绑定插件生命周期 |
| 归档与会话行 | 快速归档和 ZIP 导出由 session-actions 承担；恢复改用公开 unarchiveSession，图标通过通用槽贡献 |
| Vision | 成功缓存与在途任务分离，消费者取消互不污染；配置代次阻止旧结果覆盖新缓存，卸载取消任务 |
| 进程监管 | exit 立即失效连接，close 有界收尾；按旧 PID 入口核验孤儿进程；Windows 使用父进程持有的 Job Object |
| 分发 | 仅剪除明确文档名，保留功能性 Markdown；避免 force 安装跨平台可选包；CI 增加三平台 packaged smoke |

Markdown 预览的真实浏览器回归覆盖代码块、脚注和刷新恢复，固定样本保留在
[测试 fixture](../../packages/plugins/file-browser/tests/fixtures/markdown-preview.md)。
字号、引用气泡、侧栏 DOM 和窄面板工具栏的修正见 [UI 一致性记录](ui-native-consistency-audit.md)。

## 补丁收敛与后续公共 API

迁移中间补丁合回原接缝；session-actions、活动分组规则、轨迹装配、墓碑可见性及归档图标
留在插件，上游只保留通用接口或无法局部替换的核心机制。
后续为公开取消归档、搜索文档投影/配置替换、草稿图片注册增加 0016–0018，
该轮最终登记 15 条补丁。早期记录中的同号补丁属于旧队列，不能据编号直接套用。

Rewind 随后对齐用量、压缩规划、轮次导航与搜索，并恢复历史图片到输入框。
已发生的累计计费与原始日志保留；仍限制 live/idle、不跨压缩替换边界，未打补丁的官方 CLI
拒读含 required 墓碑的会话。完整取舍见 [ADR-0007](../adr/0007-session-rewind-tombstone.md)。

F01–F14 的证据及每项修复见[整改前审查](review-dsh-0.1.2-rc.1-2026-09-05.md)和
[整改记录](review-remediation-dsh-0.1.2-rc.1.md)，此处不复制测试明细。

## 当时的验证与限制

记录中的最终检查覆盖补丁正反向演练、真实 vendor 测试、清洁同步及锁文件契约、
workspace 单测/类型/lint/构建、原生依赖探针、隔离 DSH_HOME 的 HTTP 登录和 macOS
Electron 首启/重启；另验证 macOS arm64 未签名目录包的启动与 runtime 解压。

Windows/Linux GUI 与原生执行须由对应环境验证；三平台 CI 配置通过不等于执行结果通过。
无真实模型凭据时未调用外部视觉/搜索模型。未完成签名、公证和完整安装升级验证。
历史测试数量与本地产物路径仅作当时证据；当前验收命令见 [CI 文档](../ci.md)。

## 后续升级复用的核对点

1. 核对目标 tag 与 npm 发布是否一致，再按登记队列同步和 pack/override。
2. 核对公开服务、配置合成、客户端构建 preset 和实际 DOM；不能用宽松 ambient 类型掩盖接口漂移。
3. 对有状态功能验证重连、分页、切会话、取消与卸载，使用真实 vendor 包验证契约。
4. 在隔离数据目录中检查真实插件装配和关键交互；类型检查与 mock 测试不能替代运行时验收。
