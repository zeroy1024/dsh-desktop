# DeepSeek Harness Desktop

> 把可组合的 agent harness，变成一个真正适合长期工作的桌面工作台。

DeepSeek Harness Desktop 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）构建的 Electron 桌面宿主与产品化插件集合。它保留官方 dsh 的 Cordis 插件化 agent 核心，同时补齐桌面窗口、进程监管、右侧工作面板、文件浏览、改动审查和会话管理等能力。

这不是把上游 WebUI 复制一份，也不是把 dsh 运行时塞进 Electron 主进程。我们的做法是：**Electron 负责桌面宿主，dsh 作为独立 agent 子进程运行，产品功能优先通过插件实现，上游必要改动通过可审计的最小补丁维护。**

> **当前状态：Developer Preview**
>
> 项目和上游 dsh 都处于快速迭代阶段，接口、数据格式和插件契约可能发生破坏性变化。当前版本适合体验、研究和二次开发，不应视为稳定发行版。

## 为什么需要这个项目？

官方 dsh 已经提供了一个可组合的 agent harness：agent、工具、会话、模型和能力都可以通过插件组合。但官方公开入口主要是 CLI 启动本地 Web UI，再交给浏览器访问。对于需要长时间运行 agent 的桌面工作流，还需要额外解决几件事：

- 窗口和标题栏要像桌面应用，而不是浏览器标签页；
- agent 崩溃后要能被桌面宿主发现、记录并恢复；
- 文件、轨迹、审查等辅助信息需要有稳定的工作区，而不是挤在对话流里；
- 内置能力应随应用分发，而不是污染用户的命令行 profile；
- 上游升级和本地定制需要有清晰的边界，避免维护一个不可同步的完整 fork。

DeepSeek Harness Desktop 主要解决的就是这一层“产品化宿主”问题。

## 核心体验

### 桌面化 agent 工作台

- Electron 原生窗口，支持 macOS、Windows 和 Linux 的平台差异；
- Windows 标题栏、Window Controls Overlay（WCO）、Mica/solid 回退；
- macOS hidden inset 与 vibrancy；
- 桌面化 titleband、可折叠侧栏和右侧面板；
- dsh agent 独立运行，桌面宿主负责生命周期、日志和异常恢复。

### 面向长任务的工作面板

- **活动分组**：将连续思考步骤和工具调用折叠成摘要，展开后仍可查看完整过程；
- **文件浏览器**：在右侧面板中只读查看当前会话工作区的目录、源码和 Markdown；
- **改动审查**：查看会话内 write/edit 改动和 Git 未提交改动，按文件聚合 diff，并将行级意见回灌给 agent；
- **模型选择器**：在当前会话中直接切换 provider、model 和可用的 reasoning effort；
- **轨迹视图**：将 agent 执行轨迹从主对话流迁移到独立面板页。

### 会话管理与能力补全

- **撤回编辑**：在原会话中撤回某条用户消息之前的上下文，并将原文放回输入框；
- **归档管理**：查看、排序、按工作区分组并恢复归档会话；
- **Vision**：为不支持图片输入的文本模型提供可配置的图片证据桥接；
- **Web Search**：通过辅助模型和原生搜索工具，为现有 dsh `web_search` 能力补充结构化来源。

> 当前 Review 是“**人审 agent 改动**”的 diff 面板，不是 AI 自动代码审查，也不是 GitHub PR bot。当前 Git 模式主要支持未提交改动；base branch、指定 commit 和 PR 自动评论属于后续方向。

## 快速开始

### 环境要求

- Node.js 24（见 [`.nvmrc`](.nvmrc)）；
- pnpm 11.24.0（由根目录 [`package.json`](package.json) 固定）；
- 能够递归初始化 Git submodule；
- dsh 所需的 API key 和模型配置。

### 从源码启动

```bash
git clone --recurse-submodules https://github.com/zeroy1024/dsh-desktop.git
cd dsh-desktop

# 如果 clone 时没有使用 --recurse-submodules：
git submodule update --init --recursive

# 首次生成打过补丁的 dsh vendor 闭包
pnpm install --filter . --frozen-lockfile --ignore-scripts
pnpm sync:upstream
pnpm install --frozen-lockfile

# 构建插件并启动 Electron
pnpm dev
```

`pnpm dev` 会依次检查 vendor 产物、构建内置插件、stage 插件、构建桌面壳并启动 Electron。若本地没有 Electron 二进制，开发脚本会尝试自动安装；也可以手动执行：

```bash
pnpm --filter @dsh-desktop/desktop exec install-electron
```

桌面版默认使用 `~/.dsh`，因此会与命令行 dsh 共享 API key、profiles 和 sessions。需要隔离测试环境时，覆盖 `DSH_HOME`：

```bash
DSH_HOME=/tmp/dsh-desktop-test pnpm dev
```

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm sync:upstream` | 套用补丁、构建上游、pack 受影响包并生成 `vendor/dsh-cli` |
| `pnpm dev` | 构建插件和桌面壳并启动 Electron |
| `pnpm build` | 构建所有 workspace 并执行插件 staging |
| `pnpm test` | 运行脚本和 workspace 单元测试 |
| `pnpm lint` | 运行 oxlint |
| `pnpm typecheck` | 运行根目录和 workspace TypeScript 检查 |
| `pnpm test:upstream-patches` | 运行受本地补丁影响的上游测试 |
| `pnpm ci:smoke:dsh` | 启动真实 dsh Web runtime 并检查 Web shell |
| `pnpm ci:smoke:electron` | 启动未打包桌面应用并检查 agent、WebUI 和插件标记 |
| `pnpm ci:smoke:packaged -- --release-dir apps/desktop/release` | 验证打包后的应用 |

### 构建安装包

当前 electron-builder 配置提供以下构建目标：

```bash
pnpm --filter @dsh-desktop/desktop package:mac    # macOS arm64: DMG + ZIP
pnpm --filter @dsh-desktop/desktop package:win    # Windows x64: NSIS + ZIP
pnpm --filter @dsh-desktop/desktop package:linux  # Linux x64: AppImage + tar.gz
```

安装包会携带经过 staging 的 dsh CLI 和内置插件运行时，以单个 `dsh-cli.tar` 随应用分发，首次启动时解压到应用的 `userData`。当前仍是未签名的 developer preview；签名、公证和自动更新尚未完成。

## 架构

### 三层结构

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron 桌面层                                             │
│ apps/desktop                                                │
│ 主进程：窗口、生命周期、安全策略、AgentSupervisor、IPC 控制面 │
├─────────────────────────────────────────────────────────────┤
│ dsh WebUI 层                                                 │
│ upstream/apps/web 静态 SPA + 我们的 client plugins           │
│ React/Vite 产物；UI 定制优先通过 dsh.client 插件             │
├─────────────────────────────────────────────────────────────┤
│ dsh Agent 层                                                 │
│ 独立 dsh CLI 子进程 + Cordis 插件树                          │
│ profile 组合、服务、工具和会话运行时                         │
└─────────────────────────────────────────────────────────────┘
```

### 启动和数据流

```text
Electron 主进程
    │
    ├─ spawn dsh --profile desktop --no-open --port 0
    │
    ├─ AgentSupervisor 解析 ready 行、记录日志、监管重启
    │
    └─ renderer loadURL(http://127.0.0.1:<port>/)
                         │
                         └─ WebUI 通过同一个 loopback origin
                            访问 dsh 的 HTTP / SSE / WS 能力
```

当前采用的是“**独立子进程 + loopback HTTP**”方案：

- agent 与 Electron 主进程相互隔离，可以独立崩溃和重启；
- agent 使用随机 loopback 端口，端口变化时桌面宿主更新导航锁并重载页面；
- agent 日志写入 `userData/logs/dsh-agent.log`，支持脱敏和轮转；
- Electron IPC 主要承载 agent 状态、窗口外观、菜单等桌面控制能力；
- WebUI 的数据面当前仍由渲染进程直连 `http://127.0.0.1:<port>/`，不是真正的 fetch-over-IPC。

### 窗口宿主的平台分流

| 平台 | 窗口实现 | 主要适配 |
| --- | --- | --- |
| Windows | `BrowserWindow` + primary `webContents` | `titleBarOverlay`、WCO、Mica/solid、原生菜单 |
| macOS | `BaseWindow` + child view | `hiddenInset`、vibrancy、系统红绿灯 |
| Linux | `BaseWindow` + child view | hidden titlebar，材质能力回退为实底 |

这部分主要由 `@dsh-desktop/desktop-frame` 和 Electron 主进程共同完成。Windows 的 WebUI 必须位于 BrowserWindow primary webContents 中，才能正确获得 WCO 的标题栏几何信息；macOS/Linux 则使用 child view 组合 WebUI 和 splash。

### 内置插件如何进入运行时

```text
packages/plugins/*
       │
       ├─ 构建：lib/index.js + lib/client.js
       │
       ├─ stage 到 vendor/dsh-cli/node_modules/@dsh-desktop/*
       │
       └─ 启动前物化 $DSH_HOME/profiles/desktop/
          ├─ dsh.profile.bundles
          ├─ 空 cordis.patch.yml
          └─ 每个内置插件一个符号链接
                         │
                         └─ dsh --profile desktop
```

插件是 app 内置产品部件，不通过 `dsh plugin add` 安装到用户的 `web` profile。应用维护一个轻量的 `desktop` profile，运行时通过 Node module walk 解析到 app 携带的插件闭包。打包时整个 CLI 闭包和插件会归档为 `dsh-cli.tar`，首次启动再解压到版本化的运行时目录。

更多架构细节见 [`docs/architecture.md`](docs/architecture.md) 和 [`docs/overlay-titlebar.md`](docs/overlay-titlebar.md)。

## 相较官方 dsh 的区别

官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的核心定位是由 DeepSeek AI 开发的开源 agent harness，采用 Cordis 驱动的“一切皆插件”架构。官方 README 文档化的主要入口是：

```bash
npx @deepseek-ai/dsh web
```

它会在本机启动 Web UI，默认使用 `http://127.0.0.1:3080`，并在适用时打开默认浏览器。

DeepSeek Harness Desktop 不替代这个核心，而是在它上面增加桌面宿主和应用级插件分发层：

| 维度 | 官方 dsh | DeepSeek Harness Desktop |
| --- | --- | --- |
| 产品定位 | 可组合的 agent harness | Electron 桌面宿主 + dsh agent + 内置产品插件 |
| 主要入口 | CLI 启动本地 Web UI | `pnpm dev`、打包后的桌面应用 |
| UI 宿主 | 浏览器 | Electron `BrowserWindow` / `BaseWindow` |
| agent 进程 | dsh CLI/Web 服务 | dsh 仍是独立子进程，由 `AgentSupervisor` 监管 |
| 传输方式 | 本地 Web UI 协议 | 当前仍是 renderer 直连 `127.0.0.1:<port>` 的 loopback HTTP；真 IPC 尚未接入 |
| profile | 官方 CLI 的 profile 组合 | app 托管的 `desktop` profile；不把内置插件写入用户 `web` profile |
| 插件安装 | 官方插件机制 | 插件随 app 构建、staging 和分发，用户开箱可用 |
| 桌面体验 | 由浏览器提供窗口 | titleband、侧栏、右侧 panel、WCO、Mica/vibrancy 等桌面适配 |
| 会话辅助 | 以官方能力为主 | 文件浏览、活动分组、Review、Rewind、归档管理等客户端插件 |
| 运行时分发 | npm、源码或本地 CLI | electron-builder 携带 `dsh-cli.tar`，首启解压运行时 |
| 安全层 | 不包含 Electron 宿主策略 | sandbox、context isolation、导航锁、IPC 来源校验、权限白名单、CSP |
| 用户数据 | dsh 自己的存储目录 | 默认仍共享 `~/.dsh`；只隔离 app 托管的 `desktop` profile |
| 上游定制 | 官方源码与插件仓库 | 优先插件，其次配置叠层，最后才使用登记过的最小 patch |

有两点需要特别强调：

1. **这不是完整 fork。** `upstream/` 是锁定版本的 Git submodule；无法通过插件或配置层实现的改动才进入 `patches/*.patch`，并在 [`patches/patches.yml`](patches/patches.yml) 登记理由。
2. **这也不是完全不同的 agent。** 桌面版仍使用 dsh 的会话、工具、模型和 Web 协议；桌面项目负责的是宿主、分发、UI 扩展和必要的接缝维护。

## 默认内置插件

当前 staging 规则默认装配以下 11 个插件：

| 插件 | 作用 | 状态 |
| --- | --- | --- |
| [`desktop-frame`](packages/plugins/desktop-frame/package.json) | 桌面 titleband、平台窗口适配、侧栏和菜单体验 | 默认启用 |
| [`panel-shell`](packages/plugins/panel-shell/package.json) | 右侧多页签面板容器和页面注册协议 | 默认启用 |
| [`activity-group`](packages/plugins/activity-group/package.json) | 折叠连续思考步骤和工具调用 | 默认启用 |
| [`model-selection-direct`](packages/plugins/model-selection-direct/package.json) | 直接选择 provider、model 和 reasoning effort | 默认启用 |
| [`file-browser`](packages/plugins/file-browser/package.json) | 工作区只读文件树、源码和 Markdown 预览 | 默认启用 |
| [`review`](packages/plugins/review/package.json) | 会话/Git 改动 diff、人审标记、行级评论和单文件撤销 | 默认启用；Git 为未提交 scope |
| [`archive-manager`](packages/plugins/archive-manager/README.md) | 查看、排序、分组和恢复归档会话 | 默认启用；不提供删除 |
| [`rewind`](packages/plugins/rewind/README.md) | 撤回用户消息之前的会话上下文并回填原文 | 默认启用；仅 live 且 agent 空闲时可用 |
| [`vision`](packages/plugins/vision/README.md) | 为文本模型桥接图片理解能力 | 默认启用；只处理图片，需单独配置视觉 API |
| [`web-search`](packages/plugins/web-search/README.md) | 为现有 `web_search` 工具提供结构化搜索来源 | 默认启用；需配置辅助 endpoint/key |
| [`fps-overlay`](packages/plugins/fps-overlay/package.json) | 开发态 FPS HUD | 默认启用；仅 unpackaged 开发模式显示 |

以下插件用于通道验收或协议诊断，默认不装配到桌面运行时：

- [`hello-panel`](packages/plugins/hello-panel/package.json)：示例内置插件；
- [`panel-page-stub`](packages/plugins/panel-page-stub/package.json)：面板页协议诊断页。

### Review 的当前边界

Review 面板是本项目最具代表性的桌面扩展之一，但它需要区分两种数据源：

- **会话模式**：从 `sessions.history` 和事件流中聚合 write/edit 工具结果，适合不依赖 Git 的会话内回顾；它只覆盖可识别的文件写入工具，shell 命令造成的改动需要使用 Git 模式查看；
- **Git 模式**：读取当前工作区的 staged、unstaged 和 untracked 改动，当前 scope 是 uncommitted；
- 会话模式是编辑时间线，不承诺提供精确行号；Git 模式的 hunk 可以提供行号；
- 行级评论最终会组装成一条普通用户消息发送回当前会话，而不是引入独立的评论存储协议；
- 撤销是唯一的破坏性操作，仅在 Git 模式提供，并要求二次确认。

详细功能清单见 [`docs/review-feature-list.md`](docs/review-feature-list.md)。

## 插件优先的扩展策略

本项目对二次开发采用以下优先级：

```text
dsh 插件 > cordis.patch.yml 配置叠层 > patches/*.patch
```

具体约束：

- 新功能优先放在 [`packages/plugins/`](packages/plugins/)；
- UI 变化优先使用 `package.json` 中的 `dsh.client` 声明和客户端插件；
- 插件通常是双面包：Node 半负责 agent 侧服务，browser 半负责 WebUI；
- `dsh.bundle.patch` 用于让 Node 半随 bundle 自激活，`dsh.client` 用于声明浏览器侧模块；
- `upstream/` 永不直接编辑；
- 只有上游内部没有可消费的扩展点时，才添加最小 patch；
- 每个 patch 必须在 [`patches/patches.yml`](patches/patches.yml) 登记原因，便于同步、测试和未来撤回；
- 我们的代码不 import `upstream/src`，编译期依赖通过 `vendor/` 中由 `pnpm pack` 生成的 tarball 消费。

### 目录地图

| 路径 | 内容 |
| --- | --- |
| [`apps/desktop/`](apps/desktop/) | Electron 主进程、preload、构建和打包配置 |
| [`packages/agent-host/`](packages/agent-host/) | dsh 子进程监管、desktop profile 和运行时路径 |
| [`packages/bridge/`](packages/bridge/) | loopback HTTP origin 判定和请求信任检查 |
| [`packages/plugin-kit/`](packages/plugin-kit/) | 客户端插件打包和 ModuleLoader 工厂契约 |
| [`packages/plugins/`](packages/plugins/) | 本项目的内置 dsh 插件 |
| [`scripts/`](scripts/) | 上游同步、插件 staging、开发启动和 smoke 工具 |
| [`patches/`](patches/) | 对上游的最小补丁队列及登记文件 |
| [`vendor/`](vendor/) | 可重建的上游包 tarball 和 dsh CLI 闭包 |
| [`docs/`](docs/) | 架构、ADR、CI 和功能设计文档 |
| [`upstream/`](upstream/) | 锁定版本的官方 dsh submodule，只读来源 |

## 安全模型与兼容性边界

桌面宿主提供了 Electron 层的安全基线：

- renderer 使用 `contextIsolation` 和 `sandbox`，禁用 `nodeIntegration`；
- 导航只放行当前这一代 agent 的精确 scheme、host 和 port；
- IPC 只接受当前 agent origin 的主 frame 请求；
- 非应用内的 HTTP(S) 外链交给系统浏览器；
- 权限默认拒绝，仅按白名单开放必要能力；
- 主文档增加 CSP，限制连接、嵌入和表单行为；
- 文档 URL 不携带 token，旧格式日志中的敏感字段会脱敏；
- 文件浏览和 Git 路由使用工作区路径约束、同源校验、固定命令参数和超时。

这些措施不是“绝对安全”或“完全隔离”的承诺。为了兼容上游 WebUI 的动态模块加载和启动注入，CSP 当前仍保留 `unsafe-eval` 与 `unsafe-inline`；数据面也仍是 loopback HTTP，而不是 IPC 级别的隔离。

## 当前限制与路线图

以下内容目前不能当作已经完成的产品能力：

- 真正的 `file://` + fetch-over-IPC 传输：等待上游 webserver 提供正式实现；
- 独立捆绑的 Node 24 runtime：当前打包态使用 Electron 的 `ELECTRON_RUN_AS_NODE` 启动 dsh；
- 签名、公证和自动更新；
- AI 自动代码审查、专用 reviewer turn、GitHub PR bot 或自动评论；
- Review 的 base branch、指定 commit、重命名识别、评论锚点漂移重解析等完整 Git review 能力；
- 归档会话删除；上游目前只提供恢复所需的能力；
- Rewind 的全场景兼容：只支持 live 且 agent 空闲的会话，图片附件不会回填，含墓碑事件的会话会被官方 CLI 拒读；
- Vision 的视频理解或无需额外配置的通用多模态能力；
- Web Search 的内置免费搜索服务；它需要用户提供辅助 endpoint 和凭据。

下一阶段重点包括：

1. 持续跟随上游正式扩展点，减少本地 patch；
2. 完善 Review 的 scope、过滤、导航和大 diff 体验；
3. 根据 Electron 与 dsh 的运行时兼容性决定是否恢复独立 Node runtime；
4. 完成签名、公证、自动更新和正式发行流程；
5. 在上游支持后评估真 IPC 传输。

## 构建与 CI

`pnpm sync:upstream` 是本项目的上游同步入口，负责：

1. 校验上游 submodule；
2. 按 [`patches/patches.yml`](patches/patches.yml) 顺序套用补丁；
3. 构建打过补丁的上游；
4. pack 受影响的上游 workspace 包；
5. 生成带本地 override 的 `vendor/dsh-cli` 安装闭包。

CI 在 Linux、macOS 和 Windows 上执行平台检查，包括：

- workspace lint、typecheck 和单元测试；
- dsh CLI 的真实 Web runtime smoke；
- `node-pty`、`koffi`、`sharp` 等 native runtime 检查；
- Electron sandbox 下的 native 调用检查；
- 未打包桌面应用启动 smoke；
- release workflow 中的安装包、Chromium sandbox 和 packaged smoke。

详情见 [`docs/ci.md`](docs/ci.md)、[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 和 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

## 常见问题

### 这是官方 dsh 的 fork 吗？

不是完整 fork。项目通过 submodule 固定上游版本，用插件和配置扩展功能，必要的上游内部接缝才通过补丁队列维护。这样可以让桌面产品快速迭代，同时保留跟随官方 dsh 升级的路径。

### 桌面版会破坏我的命令行 dsh 配置吗？

默认情况下，桌面版和命令行 dsh 共享 `~/.dsh` 中的用户数据，因此 API key、session 等数据可以互通。但桌面内置插件装配在 app 托管的 `desktop` profile 中，不通过 `dsh plugin add` 写入命令行使用的 `web` profile。需要完全隔离时，请设置独立的 `DSH_HOME`。

### Review 会自动帮我找 bug 吗？

当前不会。Review 是帮助人检查 agent 改动的 diff 面板，支持标记、评论和回灌。AI reviewer、结构化 findings 和 PR bot 属于未来可能增加的能力。

### 可以把插件单独安装到官方 dsh 吗？

当前这些插件是随桌面应用分发的内部产品部件，不以独立用户态插件作为兼容承诺。项目的插件源码和构建方式可以作为 dsh 扩展开发的参考。

### 当前版本适合生产使用吗？

不建议。项目处于 developer preview，且上游 dsh 也没有稳定兼容承诺。请在重要工作前备份数据，并优先使用独立的 `DSH_HOME` 验证新版本。

## 深入阅读

- [架构总览](docs/architecture.md)
- [窗口与标题栏设计](docs/overlay-titlebar.md)
- [CI 与可复现构建](docs/ci.md)
- [Review 功能清单](docs/review-feature-list.md)
- [Review 方案分析](docs/review-feature-analysis.md)
- [ADR-0001：上游源码获取](docs/adr/0001-upstream-sourcing.md)
- [ADR-0002：MVP 传输方案](docs/adr/0002-mvp-transport.md)
- [ADR-0003：Node 运行时策略](docs/adr/0003-node-runtime.md)
- [ADR-0004：内置插件分发](docs/adr/0004-bundled-plugins.md)
- [ADR-0005：归档管理插件](docs/adr/0005-archive-manager-plugin.md)
- [ADR-0006：Review 插件](docs/adr/0006-review-plugin.md)
- [ADR-0007：会话撤回墓碑](docs/adr/0007-session-rewind-tombstone.md)
- [官方 DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

本项目的许可证和上游 dsh、Cordis 及其他第三方依赖的许可证信息，请以仓库中实际提供的许可证文件和声明为准。
