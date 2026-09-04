# 升级方案：dsh v0.1.1-rc.2 → v0.1.2-rc.1

> 状态：**方案评估**（未实施）。基于对两版 tag 的全量只读 diff 审查 + 14 个补丁在 `dsh-v0.1.2-rc.1` 树上的 `git apply --check` 实测。
> 分支：`upgrade/dsh-v0.1.2-rc.1`。目标 pin：`dsh-v0.1.2-rc.1`（tag 与 npm registry 已对齐）。

## 0. 结论与总体判断

- 上游 0.1.2 是一次 **workspace 级重组**：`host/apiproxy` 整包删除、`client/runtime` 解体为 `api/*-controller` + `client/store`、`ui-conversation` 的 chat 世界迁入新包 `ui-chat`、传输面引入 `api/gateway` + 登录 token 鉴权、会话语义持久化从 SQLite 改为 JSONL。
- 14 个补丁实测仅 **0004 可原样套用**，其余 13 个需重做；其中 5 个是小/机械量级，4 个中量级，0006 与 0012 是两个大件。
- 桌面「spawn dsh + loopback HTTP 直连」模型**成立**；关键新变量是 **ready 行携带 `?token=`**（裸 `/` 返回 401，首载 303 + HttpOnly cookie）。
- 我方源码零 `@deepseek-ai/*` 运行时 import（铁律生效），包名大换血的直接冲击限于：插件 package.json 依赖声明、`panel-shell` 一处 import、`plugin-kit` 的 externals 契约。
- **前置决策项**：rewind 保持「原地截断」语义（重做 0012/0013）还是改走上游原生 `fork`（派生新会话）。本文按「保留原地截断」编写，fork 作为后续增强另立。

## 1. 上游变化地图（与本项目相关的部分）

| 变化 | 旧落点 | 新落点 | 对本项目的影响 |
| --- | --- | --- | --- |
| apiproxy 删除 | `packages/host/apiproxy` | `packages/api/session-controller`（`@Remote` 服务）+ `api/gateway` | 0010 宿主迁移；`/api` 面改由 connection 统一承载并加 cookie 鉴权 |
| client/runtime 解体 | `packages/client/runtime` | `api/{session,settings,workspace}-controller` + `client/store` + `client/ui-session`/`ui-renderer` | 0013 宿主迁移；包名 `dsh-client-runtime` → `dsh-client-store` |
| ui-conversation 拆分 | `ui-conversation/src/client/{apply,chat/*}` | `ui-chat`（chat 世界近拷贝搬移）；`ui-conversation` 保留 target 中立骨架 | 0005/0008/0009 宿主迁移 |
| 槽位机制正式化 | 各包内联 slots | `client/ui-slots`（`BoundActions`/`SlotMap`/declaring-is-claiming） | 0006/0007 重写需按新 API |
| 登录 token | ready 行无 token | ready 行带 `?token=`，`authorizeIndex` 只认 `GET /`，303 + HttpOnly cookie（30 天） | agent-host/主进程 loadURL 链路适配 |
| 传输面 | `/api/events.mux`、`/api/events.host` 双 WS + SSE | gateway `/api/remote.mux` 单 WS（ws 库） | 客户端代码随上游 bundle，桌面无需改 |
| 持久化 | `session-persistence-sqlite` | `session-persistence-jsonl`（SQLite 语义后端删除） | 0012 验证面（roundtrip/拒读） |
| boot 注入 | `__ModuleLoader__` + `__DSH_BOOT__` | 原样 + 新增尾部 `__DSH_BOOT_READY__` 内联脚本 + `script-preload` 行；boot 改内容寻址 **combo 批**（`batches`） | CSP 无感（已 `unsafe-inline`）；插件 entry 分发方式待验证 |
| tsdown.client preset | `clientBundle`/`staticLinked` | 同名保留；`INLINE_SAFE` 白名单扩增；`invariant.js` libEntry 移除 | plugin-kit 镜像更新 |
| webServer | `register/registerUpgrade/registerFallback` | 原样 + 可选 gzip（web 组合已开） | archive-manager/file-browser 路由不受影响（挂 `/dsh-desktop/*`） |
| `/api/session.export` | apiproxy | `packages/session-query/session-log-export`（路径不变，注释明言稳定面），经 `connection.fetch.register` 挂载（已鉴权） | 0001 右键导出照常（cookie 自动携带） |
| CLI | `--profile/--no-open/--port 0` | 参数面零变化；ready 行前缀 `dsh web: ` 不变 | agent-host 正则已兼容（捕获含 query 的完整 URL） |
| dsh-cli 发布面 | `files: ['lib/*.js','config']` | `files: ['lib/*.js']`，config 改 package.json `dsh.configTrees` 声明 | vendor 闭包 / `dsh-cli.tar` 组装需核对 config 树数据仍随闭包走 |
| directory-picker-native | `koffi.view` 零拷贝 | **未修**（仅修 NUL 扫描的双字节边界） | 0015 不能撤，重放时合并上游 4 行改动 |
| core/session | 裸 `number` seq | `SessionSeq`/`SessionLogOffset` 品牌类型；新增原生 `SessionStore.fork` + `isSeeded`/`'session/end-seed'` | 0012 类型面适配；fork 是新的机会面 |
| known-event-types | 硬编码 Set | 仍是硬编码 Set，且架构笔记明示**否决**可注册注册表 | 0012 做法继续有效（补丁内登记） |

上游仍无：原生右侧第四列（panel）、可注册事件注册表、settings section 图标槽、session-row action 槽、openFile/inspect 服务化。相关补丁均有存在必要。

## 2. 补丁队列逐项方案（按建议重做顺序）

> 通用规则（沿用 ADR 惯例）：每项重做后同步更新 `patches.yml` 的 reason（注明「适配 0.1.2 重组」）、跑 `pnpm test:upstream-patches` 对应面、并验证依赖链（0005 → 0008/0009，0004 ↔ 0006）。
> 暂摘策略：迁移起步时先在 `patches.yml` 摘除全部补丁（0004 可留），让 `pnpm sync:upstream` 先跑通闭包重建，再按下表逐项登记回归。

### 2.1 0004-sidebar-default-width — 保留，无需重做

- 实测可套（`columns.ts` 两版逐字未变，仍 `SIDEBAR_DEFAULT=280`）。
- 注意：新版 `columns.ts` 新增 `SIDEBAR_AUTO_COLLAPSE=1024` 与 `SIDEBAR_COLLAPSED=56`，0006 重写四列版时会整体重排该文件，0004 的 280→320 修改点随之并入 0006 的新写法；**0004/0006 的测试耦合在重做后自然消解**（新版测试以 0006 的四列版为准，直接写 320），patches.yml 中两条 reason 的耦合描述届时更新。

### 2.2 0006-ui-layout-panel-seam — 重做（最大件）

新版骨架（已核实）：`AppFrame` 为纯组件，props 全部来自 ui-slots 标准 shares（`PropsRuntime`/`PropsRenderSlots`/`PropsStore`/`PropsLocale`）；store 用 `@deepseek-ai/dsh-client-store` 的 `defineStore`（actions 为 draft 写入集，`EngineStoreHandle`）；`ILayout` 仍是 `toggleSidebar/openDetails/closeDetails` 三动作；concession chain 是三列（`sidebar|center|details`），`CENTER_MIN` 360→**640**，新增 `SIDEBAR_AUTO_COLLAPSE=1024` 窄视口自动收栏语义。

方案（对齐旧补丁语义，按新骨架重写）：

1. `columns.ts`：三列 → 四列 concession chain。让位顺序沿用旧设计（panel 先于 details 让位、center 兜底），但**必须围绕新 `CENTER_MIN=640` 与 `SIDEBAR_AUTO_COLLAPSE` 重新推导各档**——旧版 `CENTER_MIN=360` 时代写的让位步骤数值全部失效。`SIDEBAR_DEFAULT` 直接写 320（吸收 0004）。
2. `stores.ts`：`LayoutState` 增加 `panel`/`panelExpanded`（旧语义：宽度偏好 + 开合），actions 增加 `setPanel`/`openPanel`/`closePanel`（draft 写入集风格，clamp 复用 `clampWidth`）。
3. `service.ts`：`ILayout` 增加四个 panel 动作（与旧补丁一致），`LayoutController` 转发到 `attachPanels` 收到的 `BoundActions`——新版注入机制已把 bound actions 的接线做成 `inject` hook 的标准动作，照抄即可。
4. `AppFrame.tsx`：`PropsRenderSlots` 增加 `'panel'`；grid 改四列（`sidebar | center | details | panel`），`DragHandle` 增加 panel 侧（复用现有组件，传 `side='panel'`）；panel 列默认宽度 480 / 最小 320 语义保留。
5. `index.ts`：`SlotMap` 声明 `'panel': { kind: 'single'; scope: 'root'; owner: PanelOwnerProps }`——注意新版 declaring-is-claiming 语义：槽位必须在贡献 `AppFrame` 的同一 `register()` 的 children 表里声明，插件只能消费。
6. `AppFrame.module.css`：四列 grid 轨与拖拽手柄位；**保留 `--dsh-sidebar-collapsed-track` 折叠轨变量缝**（desktop-frame 依赖其 0px 收轨语义）与旧 0006 的四处自修语义（拖拽手柄让位、放大覆盖层宽度计算的 `100cqi` 锚定、四槽 memo 边界）——逐条对照新版 DOM/CSS 结构重放。
7. 测试：`columns/app-frame/layout-store/service` 四个 spec 按新版重写（新版测试文件已大改，直接在新文件上加四列断言，含 pin 宽度防回归断言）。
8. `patches.yml` reason 更新：注明 0.1.2 骨架适配、0004 吸收、耦合描述简化。

验收：`shell.overlay`/`conversation`/`details` 槽 owner 恒定 memo 语义不回退；panel-shell 插件注册的面板页在四列下正常开合；窄视口（<1024）自动收栏与 panel 的交互行为明确（建议：panel 参与让位链第一优先）。

### 2.3 0005-conversation-chat-group-seam — 重做（宿主迁 ui-chat）

已核实：旧 `ui-conversation/src/client/{apply.ts, chat/*, contract/slots.ts}` 近拷贝迁入 `packages/client/ui-chat/src/client/`；`ChatNodeOwnerProps`（ui-chat `contract/slots.ts`）含 `selectedCallId/cwd/openFile/inspectCall/forkAt/renderMessageImages/...`，`conversation.chat.node` 为 keyed 槽。

方案：

1. `conversation.chat.group` 槽位声明迁到 **ui-chat 的 `apply.ts`**（或其 chat 槽声明文件）的 register children 中，kind 建议 `list`/`chain` 视旧实现而定（旧版为槽位声明 + 区间渲染变体）。
2. `chatFlowGrouping` 可选服务：维持 `ctx.get` 惰性读取模式（新版 ui-slots 的可选服务语义不变）。
3. `ChatNodeSeat` 区间渲染变体：在 `ui-chat/src/client/chat/ChatNodeSeat.tsx`（新版同名文件）重放。
4. hunk 锚点关系：0008/0009 仍锚定本补丁新增行，依赖链保留。

验收：activity-group 插件在新 chat 世界正常折叠/展开；web 回退（无 desktop profile）不回归。

### 2.4 0008-ui-conversation-panel-inspect-seam — 重做（更简单）

已核实：新版 inspect 已解耦为视图焦点协议——`ui-chat/src/client/chat/ChatView.tsx:246` `inspectCall = (callId) => openView('trajectory', callId)`，不再内嵌 trajectory 装配。

方案：最小改 `ChatView.tsx`（或其 inspectCall 定义处）：探测可选 `panelShell` 服务（`ctx.get` 惰性），在则委托 `panel-shell.page` 打开 trajectory 页并下发一次性选中目标（与插件侧 `PanelPageOwnerProps` 镜像字段同步——该镜像字段本身随 0007 重做更新）；不在则 `openView` 原路径保留（web 无感）。

### 2.5 0009-ui-conversation-file-browser-open-seam — 重做（小）

已核实：新版 apply 闭包 `openFile` 走 `ctx.remote.session.openWorkspacePath({ path })`。

方案：在新 `ui-chat/src/client/apply.ts` 的 openFile 注入处加 `fileBrowser.tryOpen` 可选缝；保留「目录打开、服务缺席、未处理路径」的原回退语义。

### 2.6 0007-ui-trajectory-panel-page — 重做（机械量级）

已核实：`conversation.view` 是 list 槽、注册机制开放如旧；新版 inject 服务名 `['slots','sessions','uiSession','uiConversation','locale']`；`declare module` 目标改 `@deepseek-ai/dsh-client-ui-conversation/client`；`TrajectoryView` 组件仍不从包入口导出（补丁必要性不变）。

方案：接线改新版服务名与类型目标；panel 优先 + web 回退的双半结构、可选服务不进 inject（避免无面板服务宿主整树 INACTIVE）的规则原样保留；`conversation.trajectory.images` 新子槽不阻碍本缝。

### 2.7 0010-host-image-input-admission-seam — 重做（小-中）

已核实：宿主迁至 `packages/api/session-controller/src/commands.ts` 的 `prompt()`（约 :300-345），逻辑逐行等价（`resolveModelInfo` → 图片能力判定 → `admitPromptContent` → `serializeImageAdmission`），错误码改 `RemoteError('session/attachment-invalid', …, { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })`。

方案：`imageInputAdmission.admit` 可选缝在新宿主重放：在 `resolveModelInfo` 判定处插入 `ctx.get('imageInputAdmission')?.admit(...)`，保持 `inputModalities` 原生事实、无服务时行为不变（vision 插件的消费面不变）。测试文件对应迁到 `session-controller` 的 spec。

### 2.8 0011-llm-input-transform-seam — 平移（小）

已核实：`packages/llm/llm/src/index.ts` 仅 +75/-9；`adapterStream` 分发边界、`prepareCall → resolveModelInfo → resolveCallConfig → 图像投影 → dispatch` 的瀑布原样；上游无任何新增 pre-dispatch transform 契约。基类 `Service` → `TypertRemoteService`、`deepFreeze` 移至 `util-values`、`never.ts` 导出删除。

方案：按新文件重放 `registerInputTransform`（fiber-owned、按 exact provider/model/inputModalities/signal、仅本次 adapter attempt、故障不伪装 provider failure 的语义全部保留）；README 两份的文档段同步重放。

### 2.9 0012-core-session-rewind-tombstone — 重做（中-大，含决策）

已核实：`planSurfaceEvent`/`applySurfacePlan` 汇合点存活（新版 surface.ts :331/:372）；事件类型全面品牌化（`SessionSeq`）；known-event-types 仍是脚本生成的硬编码 Set（上游明示否决注册表方向，envelope `ignorable` 是官方替代面——但墓碑语义不可 ignorable 的论证不变）；持久化语义层改 JSONL；新增原生 `SessionStore.fork(source, boundary?, childSessionId?)` + `isSeeded`/`'session/end-seed'`（fork 边界必须落在 turn 外）。

决策（推荐 A）：

- **A. 保留原地截断语义（本文基线）**：rewind 的产品价值是「原会话回卷到某条用户消息之前 + 原文回填输入框」，fork 会产生新会话 id，语义不符。方案：在新类型面重放墓碑（`SessionEventMap` declaration-merge + known-event-types/persistence-catalog 登记 + surface 汇合点折叠解释），`SessionSeq` 品牌类型全量适配。墓碑由插件 append（普通事件），不触碰 `end-seed`/seed 语义，理论无冲突——**验收时专门验证 JSONL 持久化 roundtrip、官方 CLI 拒读行为（ADR-0007）、以及含墓碑会话经 fork 派生时的边界表现**。
- B.（后续增强，不在本次范围）「从此处分支继续」按钮走原生 fork，与原地 rewind 并存。

### 2.10 0013-client-runtime-rewind-fold — 平移（小）

已核实：ingest 三口（`installWindow`/`appendLive`/`loadOlder`）在 `packages/api/session-controller/src/client/sessions/session.ts` 近拷贝保留（:619-652/:371）；assembler 增量路径对节点撤下一律抛错的行为未变。

方案：补丁在新文件重放；可见性折叠常量保持本地字面量策略（不 import dsh-session 产物）；语义与 0012 新版对齐（隐藏 `[atSeq, marker)`）。

### 2.11 0001-session-row-archive-context-menu — 重做（中）

已核实：新版 `SessionNodeItem`（`Rows.tsx` :362 起）自带 `Menu` + `sessionMenuItems` 常量数组（rename/fork/archive），`onSelect` 硬编码 dispatch，未知 id 在 dispatch 前被丢弃；blank 行不显示菜单；新增拖拽接线。

方案：在 `sessionMenuItems` 数组与 `onSelect` 分发处加「导出 Session log」项（`/api/session.export` 同源 anchor 下载，下载动作留在行组件内）；右键（contextmenu）打开 Menu 的接线按新版 `Menu` 组件 API 重放。cookie 鉴权下 anchor 下载自动携带凭据（`session.export` 已迁 `connection.fetch.register`，路径不变）。locales.ts 与三个测试文件按新结构重放。

### 2.12 0014-settings-nav-archive-icon — 重放（小）

`navIcon(id)` 硬编码逐字保留、icon 槽仍未开放。按新版 `SettingsRoot.tsx` 重放一行 `archive-manager → IconArchiveOutline20` 映射。

### 2.13 0015-win32-dialog-sandbox-safe-utf16-read — 重放并合并上游改动（小）

上游未修 `koffi.view`（V8 Sandbox 下 fatal 依旧），但同文件修了 NUL 扫描双字节边界（4 行）。方案：在 `koffi.decode.string16` 拷贝式读取的基础上**吸收上游双字节语义**（或确认 `DecodeString16` 拷贝路径天然正确处理双字节 NUL，如是则直接覆盖）；fake koffi 测试 mock 按上游新增的测试结构调整。

## 3. 桌面宿主层方案

### 3.1 agent-host：token 鉴权适配（必做）

- `ready-line.ts` 正则已兼容（`\S+?` 捕获含 query 的完整 URL）——**无需改正则**；补充单测：`dsh web: http://127.0.0.1:<port>/?token=<32B>` 与带 LAN 尾巴两种形态。
- `supervisor.ts`：`ReadyLineInfo.url` 语义更新为「鉴权 URL」；**`redactSecrets` 增加 token query 脱敏模式**（匹配 `[?&]token=<base64url>`，日志中不得出现明文 token）——旧注释「0.1.1-rc.2 起 ready 行不再携带 token」更新为 0.1.2 新事实。
- 重启链路：每次重启拿到新 token URL → 导航锁更新 → 重载页面，流程不变（token 变化随端口变化自然覆盖）。

### 3.2 主进程：loadURL 与会话 cookie（必做，小）

- `loadURL` 使用 ready 行完整 URL（含 token）；上游 `authorizeIndex` 只在 `GET /` 校验 → 303 到干净 `/` 并种 HttpOnly cookie（`dsh-auth-<sha256(host)>`，SameSite=Strict，默认 30 天）。Electron 默认 session 接受 cookie，无需手动管理。
- `security.ts` 导航锁按 scheme/host/port 判定，不含 path/query——token 加载与 303 同 origin，**天然放行**（`will-navigate`/`will-redirect` 双路判定已有）。验证一遍即可，无需改代码。
- 注意事项：不要给 agent 渲染进程换 `partition`（隔离 session 会丢 cookie 导致 401 循环）；如需「每次启动强制重新鉴权」，可显式清 `dsh-auth-*` cookie，但默认不必要。

### 3.3 CSP 与安全策略（无需改）

- 新增 `__DSH_BOOT_READY__` 内联脚本：`AGENT_CSP` 的 `script-src` 已含 `'unsafe-inline'`，无感。
- 上游仍不发 CSP 头，`AGENT_CSP` 继续由桌面钉。`bridge` 的 origin 判定不含 query，不受 token 影响。

### 3.4 vendor 闭包与运行时归档（必做，中）

- `sync-upstream.ts`：`packTargetsFor` 按补丁触及文件自动推导，补丁重做后自动适配；硬编码基础包清单（`packages/web/web` 等 5 项）路径两版一致，先不动。
- **`dsh-cli` 发布面变化**：`files` 不再含 `config/`，config 树改由 `dsh.configTrees` 声明——核对 `stage-runtime-archive` 打包的 `dsh-cli.tar` 与首启解压闭包是否仍包含 configTrees 指向的数据文件（可能需要把对应包整体纳入闭包收集，实施时以实际闭包树为准）。
- 闭包构成大变：workspace 依赖 62→70（新增 `api/*-controller`、`session-persistence-jsonl`、`sandbox-local`、`webhook` 等；`apiproxy`/`client-runtime`/`session-persistence-sqlite` 消失），且新增 `@anthropic-ai/claude-agent-sdk`、`@open/codex` 平台包——**闭包体积与 lockfile 全量重算**；`verify-vendor-lock` 指纹重录。
- native：`node-addon-landlock-run`（Linux）由 `sandbox-local` 传递依赖、不进 `dsh` tarball 的行为两版一致；macOS/Windows 打包不受影响，Linux 目标如需 sandbox 则显式收集（现状未启用则维持）。

### 3.5 其余主进程模块（无需改）

`windows-appearance`/`application-menu`/`window-state`/`orphan-reaper`/`restart-throttle`/`permissions` 均为 Electron 侧能力，不触上游变化。

## 4. 插件层逐项方案

### 4.1 全体插件：包名迁移（机械，先做）

`@deepseek-ai/dsh-client-runtime` → `@deepseek-ai/dsh-client-store`：

- 14 个插件 package.json 的依赖声明（`model-selection-direct`、`hello-panel`、`panel-shell`、`rewind`、`vision`、`panel-page-stub`、`archive-manager`、`desktop-frame`、`review`、`web-search`、`file-browser`、`fps-overlay`、`activity-group`）。
- `panel-shell/src/client/panel-store.ts` 的 `createSnapshotStore` import 与 `runtime.d.ts` 的 declare module 目标（`SnapshotStore`/`createSnapshotStore` 公开签名不变）。
- `dsh.client` 声明契约（inject/platform/immediately/external 字段）与 `__ModuleLoader__` 加载协议**原样保留**，无需动。

### 4.2 plugin-kit：镜像契约更新（必做，中）

对照新版 `packages/client/tsdown.client.ts` 重新镜像：

- `INLINE_SAFE` 白名单扩增（新增 `deque|typert-protocol|util-crypto|util-values|util-workspace-path|token-meter|agent-presets`）——`PRELOADED_CLIENT_EXTERNALS` 与 externals 判定同步更新（`@deepseek-ai/dsh-client-runtime/client` → `@deepseek-ai/dsh-client-store` 相关面）。
- libEntry：`lib/types/invariant.js` 引用移除（新版全部只留 `lib/types/index.js`）。
- sourcemap 链插件化与 lexical 条件 resolve：按需镜像。
- **待验证项**：新版 boot 改内容寻址 combo 批（`__DSH_BOOT__.entries[].batches`）——我们的插件经 `stage:plugins` 注册为 bundle entry 后，走 combo 批还是保留独立 `/plugins/<id>/client.js` 惰性加载，需在 sync 跑通后实测；若 entry URL 结构变化影响 `bundled-plugins.ts` 的 manifest 生成，随实测修正。

### 4.3 各插件专项

| 插件 | 新版影响 | 方案 |
| --- | --- | --- |
| `desktop-frame` | 低。`shell.overlay` 槽在新版 AppFrame `PropsRenderSlots` 中保留；titleband/菜单/WCO 适配是 Electron 侧 | 随 0006 验证折叠轨 CSS 变量（`--dsh-sidebar-collapsed-track` 0px 收轨）语义；chrome.css 若依赖旧 grid 结构需微调 |
| `panel-shell` | 中。依赖 0006 的 `panel` 槽与 `ctx.panelShell` 自有服务；store 包名迁移 | 包名迁移 + 随 0006 重做联调；`PanelPageOwnerProps` 镜像字段与 0007/0008 的新交接字段同步 |
| `activity-group` | 中。完全依赖 0005 缝（迁 ui-chat） | 随 0005 联调；`ctx.locale.register/bind` 面核对（新版 locale 机制扩展了 `LocaleNamespaceMap`，注册 API 兼容概率高，实测确认） |
| `model-selection-direct` | 中。上游 `ui-model-selection` 包两版都在且迭代（`session/modelCatalog`、`session.selectModel` RPC、`conversation.input.model` seat） | 对照新版 Remote 面核对所调用的 `ctx.remote.session.*` 方法名与返回形状；如有偏差随 session-controller 契约更新 |
| `file-browser` | 中。node 半路由（自挂前缀）+ 浏览器半依赖 0009 缝 | 路由与安全策略（credential-shaped deny 等）不依赖上游；openFile 缝随 0009 联调 |
| `review` | 中。聚合 `sessions.history` + 事件流；事件类型面品牌化 + 新事件类型 | 事件解析适配 `SessionSeq` 与新增事件类型；Git 路由（自挂前缀 + 固定命令）不受影响；会话模式的 write/edit 工具结果形状实测核对 |
| `archive-manager` | 低-中。路由挂 `/dsh-desktop/*`（不在 `/api` 鉴权面）；`webServer.register` 原样 | `workspaceRegistry.setState` 内部面实测（包存活，有 501 降级兜底）；`storageDomain` 包存活 |
| `rewind` | 高关联。依赖 0012/0013 + live/空闲判定 | 按 §0 决策 A 随 0012/0013 联调；「图片附件不回填」等限制面复核（上游附件面迁 attachments controller） |
| `vision` | 中。依赖 0010 缝（迁 session-controller） | 随 0010 联调；`inputModalities` 原生事实语义保留 |
| `web-search` | 中。node 半消费上游 tools/llm 面 | 上游 tool 面有重组（`dsh-tool-subagent-report` 删除等）——实测 `web_search` 工具契约与辅助模型调用面，偏差随上游新契约修正 |
| `fps-overlay` | 无。纯浏览器 HUD，仅 unpackaged 开发态 | 仅随全局构建回归 |
| `hello-panel` / `panel-page-stub` | 低。诊断用，不进默认装配 | 随 panel-shell 契约编译通过即可 |

## 5. 基础设施与 CI

- `stage-plugins.ts` / `bundled-plugins.ts`：staging→profile 物化→符号链接的机制不依赖上游内部结构，预期不动；**combo boot 对 entry 分发的影响**见 §4.2 待验证项。
- `scripts/smoke-dsh.ts` / `smoke-electron.ts`：ready 行抓取正则核对（`dsh web: ` 前缀不变）；「插件标记」检查若依赖 boot 注入的 entry URL 形态，随 combo 实测调整。
- `test:upstream-patches`：受影响包集合随补丁重做自动重算；上游测试面大改，各补丁自带的上游测试修改按新版测试文件重写。
- `ci:probe-native`（koffi/sharp/node-pty）、`ci:probe-electron-sandbox`：逻辑不变，跑一遍确认。
- 升级期间 CI 三平台绿是合入门槛；上游仍在 rc 序列，**建议迁移分支跟随到 0.1.2 stable（或至少 rc 序列收敛）再合 main**，避免 rc 间接口再变导致二次返工。

## 6. 建议实施顺序

1. **决策**：rewind 语义（本文按决策 A 编写）。
2. **闭包先行**：submodule bump → `patches.yml` 暂摘全部补丁（0004 可留）→ `pnpm sync:upstream` 跑通新版 vendor 闭包（此时处理 `dsh.configTrees` 的闭包收集问题）。
3. **机械迁移**：插件包名迁移（§4.1）+ plugin-kit 镜像更新（§4.2）→ `pnpm build` + `stage:plugins` 验证 combo/entry 分发（待验证项在此落定）。
4. **宿主适配**：agent-host token/脱敏 + 主进程 loadURL 链路（§3.1/3.2）→ `ci:smoke:dsh` 绿。
5. **补丁重做**（按 §2 顺序，每项一个 commit，随做随登记 `patches.yml` 与上游测试）：0004（保留）→ 0006 → 0005 → 0008 → 0009 → 0007 → 0010 → 0011 → 0012 → 0013 → 0001 → 0014 → 0015。
6. **插件联调**：§4.3 表逐个过（panel-shell/activity-group/review/rewind 是重点）。
7. **全量回归**：`pnpm test` + `pnpm typecheck` + `pnpm lint` + `ci:smoke` + 三平台 CI。

## 7. 风险清单

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| rc 序列接口继续变动，迁移期间上游发 rc.2+ | 高 | 迁移分支不合 main 直至 stable；重做补丁时记录「适配成本」供下次评估 |
| `dsh.configTrees` 闭包分发遗漏 config 数据 → 首启失败 | 中 | §3.4 专项核对 + `ci:smoke:packaged` 验证 |
| combo boot 改变插件 entry 分发，staged `client.js` 变更不生效（client-hmr） | 中 | §4.2 待验证项在 sync 跑通后第一时间实测 |
| 0012 墓碑与 fork/seed 语义在 JSONL 持久化下的组合边界 | 中 | 专项测试：roundtrip、官方 CLI 拒读、含墓碑会话 fork |
| `CENTER_MIN=640` 下四列让位链的 UI 体验（窄窗口 panel 频繁让位） | 中 | 0006 重做时重新推导档位并补 pin 断言 |
| 上游否决事件注册表方向（架构笔记）→ 0012 长期维持补丁 | 低 | 已知现状；持续在上游 issue/PR 跟踪 rewind 原生化，落地即撤 |
| `@anthropic-ai/claude-agent-sdk` 等新依赖放大闭包体积/安装时间 | 低 | 打包体积对比记录；必要时评估裁剪非必需 optional 依赖 |
