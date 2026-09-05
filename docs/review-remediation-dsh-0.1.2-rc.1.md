# 0.1.2-rc.1 Review 整改记录

日期：2026-09-05。对应 [整改前审查](review-dsh-0.1.2-rc.1-2026-09-05.md)。
上游仍 pin `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。没有直接编辑 upstream 源码；
新队列由 `sync:upstream --replace-patches-from` 核验旧队列后统一迁移。

## 问题处置

| 问题 | 最终实现与回归 |
|---|---|
| F01 Remote 命名空间 | vision/web-search 声明 `remote.credentials`，file-browser 声明 `remote.session`；真实 Cordis 激活、访问与卸载测试。 |
| F02 跨会话恢复竞态 | restore 固定发起时的会话 epoch，过期成功/失败回调不能刷新新会话；页面级 A→B 回归。 |
| F03 Git 通配文件名 | `--literal-pathspecs` 恢复精确文件；真实 Git 的 `[ab].txt` 不影响 a.txt/b.txt。 |
| F04 Git 子目录基准 | status/diff/restore/unlink 统一为会话 cwd 相对路径，过滤目录之外条目；真实嵌套同名文件回归。 |
| F05 Cookie 累积 | 保留原 Electron session 和 UI 存储，只清理旧 loopback 鉴权 Cookie；导航串行并核验当前代。 |
| F06 自有路由鉴权 | `bridge/host-routes` 复用公开 `connection.requestRejection`；四插件七路径实际 Cookie 交换、401/403/业务响应测试。 |
| F07 路由生命周期 | 注册绑定调用插件的 `ctx.effect`；真实卸载后 404、重装恢复，无重复路由。 |
| F08 流式全量扫描 | 上游提供通用事件视图接口，rewind 插件解释墓碑；无墓碑转发原始 snapshot/delta。FileBrowser 同样仅消费 delta，20,000 次追加不读取完整窗口。 |
| F09 撤回轮次导航 | 配置禁用原生 owner，rewind 注册公开 `turnOutline` 替代投影；覆盖普通文本、steering、图片/空白首消息及重放。 |
| F10 分页误报完整 | 等待共享分页，使用只读 `historyStartSeq` 判断原始游标推进；隐藏整页仍继续加载，失败显示错误，实时 append 不冒充分页。 |
| F11 Vision 取消污染缓存 | 成功缓存、共享任务、消费者取消分开管理；最后消费者离开才取消任务，失败不缓存，可立即重试。 |
| F12 exit/close 混用 | exit 立即使连接失效；进程树、继承管道和日志分别有界清理；真实孙进程保持管道/脱离进程组回归。 |
| F13 升级孤儿进程 | 按旧 PID 记录入口核身，验证属于应用托管 runtime 根；不依赖新版本解压，终止前复核归属。 |
| F14 运行时 Markdown | 仅剪除明确文档文件名，保留功能性 `.md`；最终 tar 验证 skill-badge Markdown。 |

同时完成：文件按写入范围失效并合并读取；隐藏 Review 停止分页；Titleband 使用当前 ref
并观察按钮簇尺寸；metadata/slot 注册失败回滚；公开接口从 vendor 导入类型；旧 Vision
stream 适配独立为 `legacy-stream.ts`。归档恢复仍通过带 guard 的 registry 操作队列
维护内存与持久状态，没有绕过 registry 直接写存储。

交叉验证还修复了：tracked/untracked diff 均禁用外部 helper/textconv；Vision 预取消
不制造未处理拒绝；修改设置后旧请求可完成，但新请求不加入旧任务、旧结果不覆盖新缓存，
卸载取消全部在途代际；通用事件视图注册异常时释放候选视图。

分发验证还修复了 `sync:upstream` 的强制安装：`pnpm install --force` 会安装不匹配当前
OS/CPU 的可选包，见 [pnpm 官方说明](https://pnpm.io/cli/install#--force)。现在清空可重建
的 vendor `node_modules` 后按正常生产安装，避免旧包残留与跨平台原生包膨胀；本机 tar
从约 404 MiB 降为 115 MiB。同文件名/同版本 tarball 更新的独立安装演练确认新内容生效。

## 最小补丁与插件边界

| 条目 | 上游保留 | 插件承担 |
|---|---|---|
| 0001 | 通用 `sessionRowActions`、行渲染与右键锚点 | 新 session-actions：原生 ZIP 导出、悬停归档、图标、词典 |
| 0005 | 连续节点分组槽、块范围变体、原生 Seat 可见性 | activity-group 的规则、摘要、交互、词典 |
| 0007 | `trajectoryView.create` 和默认入口开关 | panel-shell 的适配、Inspect、metadata、图标、接管/恢复 |
| 0013 | 通用 `sessionEventViews`、稳定公共源、原始分页游标 | rewind 墓碑过滤；轮次投影经公开 API + 配置替换 |
| 0014 | 通用 keyed `settings.section.icon` 槽和原生 fallback | archive-manager 贡献图标 |
| 0006/0008/0009/0010/0011/0012 | 私有装配点缺少的布局、交接、准入、转换、core 截断接口 | 面板、文件浏览、图片理解、撤回 UI/写入逻辑 |
| 0015 | `readUtf16` 单点拷贝式解码修复 | 继续使用上游原生 COM 对话框 |

0015 有整 provider 替代路径，但没有 decoder/COM bindings/worker 的局部注入接口。
零补丁需复制约 576 行原生后端及生命周期。保留最小兼容修复维护成本更低，并不声称
“插件完全不可达”。保留原因与退役条件见 [patches.yml](../patches/patches.yml)。

0016–0019 全部合回对应原始补丁。队列 **16 → 12 条**；相对上游 pin，`src/` 变动
从 `+1255/-150` 变为 `+1220/-149`。通用接口拆分和回归增加了文件数，总 patch 文本
没有显著缩短；主要改善是桌面业务退出上游、接口可复用，以及撤销依赖更清楚。
会话 ID、撤回边界、面板入口、右键/悬停归档、含后代的 ZIP 导出、原生目录对话框保持原语义。

## 验证

- 自有代码：**100 个测试文件，609 项通过**（workspace 559、最终 scripts 50）。
- 上游补丁：**18 个测试文件，434 项通过**，清单从补丁头自动提取。
- 根与全部 workspace 类型检查、lint、完整 `pnpm build` 通过。
- 完整 `sync:upstream` 通过，重新 pack/override、安装 vendor、staging 内置插件。
- 12 个补丁正序应用与逆序撤销通过，Git tree 精确一致；应用后的源码 whitespace 检查通过。
- 迁移测试覆盖未登记/已暂存修改拒绝、真实 index 保留、新增/删除、非 UTF-8、二进制、
  textconv/whitespace 配置、无末尾换行及权限。patch 空白上下文前缀按 diff 语法处理。
- 独立 DSH_HOME 的 dsh HTTP 启动与登录握手通过，Host 日志没有插件装配错误。
- macOS Electron 首启、agent 重启、随机端口切换与桌面标记复验通过。
- 最终 runtime tar 已重建，包含 `dsh-skill-badge/assets/dsh-badge.md` 与 session-actions。
- 更新的 vendor lock 经 frozen reinstall 后，归一化依赖契约完全一致。
- 完整清洁同步再次通过，依赖契约仍完全一致；node-pty、koffi、sharp 原生加载探针通过。

`ci:verify-vendor-lock` 默认比较 **HEAD**，因此在尚未提交的工作树中报告预期差异：
`dsh-client-ui-trajectory` 从 registry 包改为本地补丁 tarball/override。第三方 registry
包版本与 integrity、安装 policy 没有漂移。更新后的锁文件留在工作树中；没有为使
门禁变绿而削弱检查或擅自提交。

本次没有实测 Windows/Linux GUI，也没有生成/安装完整签名发行包。Windows COM 有原生
单测与编译覆盖。该轮仍保留的用量、搜索与平台验证问题，在下述后续整改继续处理。


## 后续遗留整改（2026-09-05）

- **撤回用量/压缩一致性**：0012 使 TokenMeter、contextPressure/contextBreakdown
  和 compaction 消费同一撤回后表面；失效采样回退估算，累计计费保留。惰性历史
  接口只暴露当前已提交前缀，普通投影追加不物化日志；缓存版本升级兼容旧墓碑。
- **撤回搜索一致性**：0017 增加通用文档投影、索引版本和配置 provider 替换接口。rewind 通过配置
  替换 SQLite provider，业务过滤在插件；实时、持久化、literal filter 同步生效，
  旧索引重建，游标失效与排序沿用上游。精确日志读取仍可审计。
  Include 的原 `name` 字段是匹配校验，实际替换使用新增 `replaceName`；插入和覆写
  值复制后合成，避免重用配置层时相互污染。回归使用真实公开配置合成器，覆盖
  base/web/rewind/用户设置、重复合成、撤去插件和输入不变性。
- **取消归档公共契约**：0016 提供幂等 `unarchiveSession` 并排空卸载前已接纳写入。
  archive-manager 删除私有 state/setState/enqueueOperation 依赖，使用 vendor 类型。
- **图片回填**：0018 公开已有的两项草稿附件方法，并补整批创建失败的 URL 回滚。
  图片读取、准备、回填与资源所有权归 rewind 客户端；准备失败不先撤回，晚响应不
  修改新会话，插件/原会话 scope 销毁取消尚未完成的恢复。
  vendor 同时供应公开声明依赖的 client/store 包，编译守卫确保 SnapshotStore 没有
  因缺包退化为 any。
- **Windows 回收**：父进程拥有 `KILL_ON_JOB_CLOSE` Job Object，bootstrap 在 CLI 前
  分配成员身份后关闭临时句柄，主进程异常死亡也触发内核回收；保留 NODE_OPTIONS
  与 argv 两条加载路径以适配 Electron。原生依赖取自当前 vendor CLI 闭包。
  同时纠正旧孤儿回收把 taskkill 可执行名重复放入参数的问题。
- **验证入口**：普通 CI 的 packaged-smoke 扩为 macOS/Windows/Linux；vendor cache
  指纹补上 patch-queue/sync-fingerprint helper 与跟踪的 vendor 锁文件。sync 的 build/pack 也继承 CI 模式，
  避免 pnpm 隐式安装时尝试在 submodule 安装 contributor Git hooks。

本轮新增 0016/0017/0018 三项通用 API 补丁，当前队列共 **15 条**。最小化约束作用于
必需的源码改动与维护范围；归档、搜索和图片恢复业务均留在插件。0012 的 token-meter
处理因原生私有 fold 与投影注册绑定保留必要语义修复，没有复制整套上游服务。

冷会话仍限制为 live/idle、不跨压缩替换边界；临时发布再销毁会造成 removed 输入锁及
并发 resume 失败，见 ADR-0007 的复核证据。未打补丁的官方 CLI 仍拒读 required 墓碑，
这是防止错误重建的互操作约束；不能通过把墓碑标成 ignorable 消除。

### 本轮验证结果

- 自有代码：104 个测试文件、635 项通过；4 项真实 Windows Job 测试在 macOS 跳过。
- 上游补丁：27 个测试文件、631 项通过；15 条补丁正向应用、逆向撤销与 Git tree 比对通过。
- 根和全部 workspace 类型检查、lint、完整构建通过；node-pty、koffi、sharp 原生加载通过。
- 图片交接后文本同步回调抛错的回归通过；已经交给 composer 的附件不被错误释放。
- 三平台 CI 配置通过 actionlint；Windows/Linux 原生执行与签名发行仍待对应环境验证。
- 最终清洁同步通过，完整依赖契约与前一次同步完全一致，同步指纹匹配当前补丁登记。
  本轮新增 client/store 声明依赖带入 immer/zustand；原有 registry 条目的版本与 integrity
  未变，安装 policy 未变。其他变更是已登记补丁对应的本地包替换。
- 独立 DSH_HOME 的 dsh HTTP 启动、登录握手，以及 Electron 首启、agent 重启与新端口
  标记复验通过。默认 vendor-lock 门禁仍因未提交的预期本地包替换而与 HEAD 不同；
  已核验差异，没有弱化门禁或擅自提交。
- macOS arm64 未签名目录包已生成并通过实际启动、runtime 解压及桌面标记验证；
  产物位于 `.ci-artifacts/followup-release/mac-arm64/DeepSeek Harness.app`。
  按收尾范围未生成 DMG/ZIP，未执行安装升级、签名与公证验证。
