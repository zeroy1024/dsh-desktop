# 架构

DeepSeek Harness Desktop = Electron 壳 + 上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。上游「万物皆插件」（Cordis 插件 + YAML patch 叠层），本项目的一切二次开发都优先落在插件层，见[边界铁律](../AGENTS.md#边界铁律)。窗框实现与平台分流的来龙去脉见 [overlay-titlebar.md](overlay-titlebar.md)。

## 三层结构

```
┌──────────────────────────────────────────────────────────┐
│ Electron 层（apps/desktop）                                │
│  主进程：窗口/生命周期/安全策略/AgentSupervisor/IPC          │
├──────────────────────────────────────────────────────────┤
│ dsh WebUI 层（upstream/apps/web 静态 SPA + 我们的客户端插件） │
│  React 18 + Vite 产物；UI 定制走 dsh.client 插件，不改源码   │
├──────────────────────────────────────────────────────────┤
│ dsh Agent 层（upstream dsh CLI 子进程）                     │
│  Cordis 插件树按 profile 组合；扩展走 dsh 插件/cordis.patch  │
└──────────────────────────────────────────────────────────┘
```

## 窗口宿主：Windows 与 macOS/Linux 平台分流

主进程的窗口宿主按平台分流（`apps/desktop/src/main/index.ts`，详见
[overlay-titlebar.md](overlay-titlebar.md)）：

```
Windows                      macOS / Linux
BrowserWindow                BaseWindow
├─ primary webContents:      └─ contentView
│   dsh WebUI（WCO 原生 caption）   ├─ WebUI WebContentsView
└─ contentView                     └─ splash WebContentsView
   └─ splash child view
```

- **Windows**：`titleBarStyle:'hidden'` + `titleBarOverlay`，WebUI 直接加载在
  BrowserWindow primary——WCO rect（`env(titlebar-area-*)` 与
  `navigator.windowControlsOverlay`）只有 primary 能拿到非零值，这是
  0.0.3/0.0.4 叠键回归的根因；splash 是 contentView 顶层 child view（全不透明，
  primary 在其下预加载）。外观由 `windows-appearance.ts` 控制（Mica/solid
  回退、`nativeTheme` 深浅/forced colors/减少透明度）；应用菜单由
  `application-menu.ts` 持有（roles/accelerator 保留、原生菜单栏隐藏、菜单
  popup 由 renderer 传 id+anchor 触发）。
- **macOS/Linux**：维持 `BaseWindow` + child view；macOS `hiddenInset` +
  vibrancy，Linux `hidden` 无 overlay。两种模式共用 `splash.ts` 的
  `WebuiResource` 所有权模型：Windows 借用 primary（不创建/不关闭），其他
  平台拥有 child view（dispose 时关闭）。非 win32 不暴露 Electron 默认菜单
  （含 reload/devtools）：macOS 装最小菜单（app + edit role），Linux
  置空 application menu（`application-menu.ts` 的 `installMinimalNativeMenu`）。

## 数据流

```
Electron 主进程 ──spawn──▶ dsh --profile desktop --no-open --port 0
        │                        │ stdout ready 行（port 写入导航锁）
        ▼
渲染进程 loadURL(http://127.0.0.1:<port>/)
        │  文档/脚本/fetch/WS 直连这一代 agent（同 origin）
```

- agent 与 Electron 主进程是**两个进程**，崩溃隔离、可独立升级；主进程通过 `@dsh-desktop/agent-host` 监管子进程（ready 解析、指数退避重启、稳定运行后才重置预算）。每次重启的随机端口都会更新导航锁并重载页面；日志写入 `userData/logs/dsh-agent.log`，launch token 脱敏、权限收紧并按 5 MiB 轮转。
- 首载使用 ready URL 的一次性 token 换取上游签名 Cookie，再跳转到干净 URL。应用保留原有 Electron session 的 UI 存储，每代导航前只清理该 session 中旧端口的 `dsh-auth-*` Cookie；清理与导航串行执行，避免端口代际交叉。自有 Host 路由通过 `bridge/host-routes` 调用公开 `connection.requestRejection`，并由调用插件的 Cordis effect 管理注册/卸载。
- 监管器在 `exit` 时立即使连接失效，`close` 负责管道与日志收尾；清理都有截止时间。升级时依据 PID 记录中的旧入口核验进程，入口必须属于应用管理的 runtime 根，无需等待新版本解压。
- Windows 监管器在 dsh 执行前通过 bootstrap 加入父进程持有的 Job Object，开启
  `KILL_ON_JOB_CLOSE` 且不放行 breakaway；关闭或强制终止 Electron 会由内核回收该树。
  bootstrap 位于 `extraResources`，FFI 从当前 CLI 的 vendor 闭包解析。旧版本遗留
  进程仍先核验 PID/入口再用 taskkill 回收；Job 是生命周期管理，不覆盖外部 broker
  代为创建的进程，也不替代 dsh 的执行沙箱。
- 数据位置：`DSH_HOME` 默认与命令行共用 `~/.dsh`（API key/profiles/sessions 互通），设 `DSH_HOME` 环境变量可覆盖以隔离测试。
- 渲染层安全基线：`contextIsolation` + `sandbox` + 禁 `nodeIntegration`；导航按解析后的 scheme/host/port 精确放行当前 `http://127.0.0.1:<port>`，IPC 只接受该 origin 的主 frame，其余 HTTP(S) 外链走系统浏览器。文档 URL 不含 token。主文档响应钉 CSP（`security.ts` 的 `AGENT_CSP`）：禁 object/base/form/frame-ancestors、连接限同源；`script-src` 含 `'unsafe-eval'`（上游 `__jsExpr` 的 `new Function` + `eval`）与 `'unsafe-inline'`（上游 webserver 向主文档注入 `__ModuleLoader__` facade 与 `__DSH_BOOT__` 全局，无 nonce 通道）。

## 插件分发（P2 起，ADR-0004）

我们的插件是 **app 内置产品部件**，不是用户态插件——不走 `dsh plugin add`，不碰用户的 web profile。

```
packages/plugins/*（双面包：node 半 + dsh.client 浏览器半，dsh.bundle.patch 自激活）
        │ 构建（镜像的 tsdown.client preset）→ lib/index.js + lib/client.js
        │ stage → vendor/dsh-cli/node_modules/@dsh-desktop/*
        ▼
app 启动时物化 ~/.dsh/profiles/desktop/：manifest（bundles = dsh-base + dsh-web-app + 我们的插件）
        + 空 cordis.patch.yml + node_modules/ 每插件一个符号链接 → CLI 闭包内 staged 插件
        ▼
spawn: --profile desktop --no-open --port 0
```

- 解析链路：bundle 双锚点（安装目录 → profile 目录）+ 裸名 Node walk（profile 级 `node_modules` 第一优先），全部为上游既有机制，零上游改动。`stage:plugins` 先把发布面放进 CLI 的 canonical `node_modules` 闭包，避免 profile 符号链接被 Node realpath 回 workspace 后加载第二份 Cordis／HarnessError；物化前校验插件名/manifest/路径，托管文件原子替换，版本戳记录插件名册以清理旧的托管链接。
- 插件版本 = app 版本；打包时随 dsh-cli 闭包一起由 `stage-runtime-archive.ts` 打成单个 `dsh-cli.tar` 随包携带，首启解压到 `userData/dsh-runtime/<version>/`（安装器不再逐文件写上万个运行时文件，Windows 安装/升级/卸载提速；解压与自愈细节见 `apps/desktop/src/main/runtime-archive.ts`：标记命中仍校验 CLI 入口，ready 前启动失败会失效重解压一次）。
- dev 启动：先构建全部插件，再把 manifest `files[]` staging 到 CLI 闭包，然后物化 profile。重建插件后需再次执行 `pnpm stage:plugins`，staged `lib/client.js` 的变更才会进入 dsh client-hmr。

## 目录结构与所有权

| 路径 | 内容 | 变更规则 |
| --- | --- | --- |
| `upstream/` | 上游源码 submodule（pin tag） | 只读；升级 = bump submodule |
| `patches/` | 对上游的最小补丁 + `patches.yml` 登记 | 最后手段，须写理由，CI 演练可套用 |
| `apps/desktop/` | Electron 主进程/preload | 我们的代码 |
| `packages/agent-host/` | dsh 子进程监管（纯 Node 库） | 我们的代码 |
| `packages/plugin-kit/` | 客户端插件打包（ModuleLoader 工厂契约） | 我们的代码 |
| `packages/plugins/` | dsh 插件（功能大头，app 内置分发，ADR-0004） | 我们的代码，P2 起 |
| `packages/bridge/` | loopback/路径判定及复用上游鉴权的 Host 路由注册 | 我们的代码；不代理 HTTP |
| `vendor/` | 上游包 tarball + `dsh-cli` 独立安装产物（`pnpm pack` + `pnpm install --prod`） | 生成物，可重建 |
| `scripts/` | `sync-upstream.ts` / `dev.ts` | 我们的代码 |

跨 workspace 消费上游的关键：我们的包**不 import 上游 src**，只用 `vendor/` tarball。`sync-upstream.ts` 会从登记补丁自动推导受影响的 workspace package，逐一 pack，并在 `vendor/dsh-cli` 中同时设为本地依赖和 pnpm override；否则 pack 后的 CLI 会重新从 registry 安装官方包，导致补丁只在源码测试中生效、运行时失效。

改写已套用的补丁队列前保存旧 `patches/` 目录，再运行 `pnpm sync:upstream -- --replace-patches-from <旧目录>`。脚本在临时 Git index 上核对工作树等于旧登记队列，并预先验证新队列，最后一次性套用两者差量；存在未登记或已暂存修改时拒绝覆盖。无需直接编辑或 reset `upstream/`。

## 分阶段路线图

- **P0 仓库骨架 + 上游同步链路**（已完成）：submodule 锁版、patch 队列机制、`sync-upstream.ts`、CI 演练。
- **P1 MVP 桌面壳**（已完成）：`dsh web` 子进程 + `loadURL`，零上游改动跑通全功能。
- **P2 插件工作流**（已完成通道）：`@dsh-desktop/hello-panel` 走通「构建 → 物化 `~/.dsh/profiles/desktop` → `--profile desktop` 启动 → `shell.overlay` 出现徽章」（ADR-0004）；此后功能一律走 `packages/plugins/`。
- **P3 传输**（自定义协议已撤销）：渲染进程直连 loopback HTTP；当前首载通过 ready token 交换 Cookie，再进入干净 URL（见上文数据流）。自定义协议代理的撤销原因见 ADR-0002；真 IPC 仍等上游正式实现。
- **P4 打包分发**（部分实施）：electron-builder 打包 + `dsh-cli.tar` 随包携带、首启解压到 `userData/dsh-runtime/<version>/` 已落地；捆绑 Node 24 运行时（`scripts/bundle-node.ts`）、签名/公证、自动更新未做（运行时改用 `ELECTRON_RUN_AS_NODE` 复用 Electron 内嵌 Node，见 [ADR-0003 修订](adr/0003-node-runtime.md)）。

## 决策记录

- [ADR-0001 上游源码获取：submodule + patch 队列](adr/0001-upstream-sourcing.md)
- [ADR-0002 HTTP 内嵌，真 IPC 暂缓](adr/0002-mvp-transport.md)
- [ADR-0003 Node 运行时策略](adr/0003-node-runtime.md)
- [ADR-0004 内置插件分发：app 托管 desktop profile + 闭包解析](adr/0004-bundled-plugins.md)
- [ADR-0005 归档管理插件与公开取消归档 API](adr/0005-archive-manager-plugin.md)
- [ADR-0006 审查插件：会话事件流聚合的面板页 + 行级评论回灌](adr/0006-review-plugin.md)
- [ADR-0007 会话撤回墓碑](adr/0007-session-rewind-tombstone.md)

全部维护说明与插件用法见[文档索引](README.md)。
