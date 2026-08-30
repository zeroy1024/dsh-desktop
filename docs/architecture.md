# 架构

DeepSeek Harness Desktop = Electron 壳 + 上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。上游「万物皆插件」（Cordis 插件 + YAML patch 叠层），本项目的一切二次开发都优先落在插件层，见[边界铁律](../AGENTS.md#边界铁律)。

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

## 数据流

```
Electron 主进程 ──spawn──▶ dsh --profile desktop --no-open --port 0
        │                        │ stdout ready 行（port/token 留在主进程）
        ▼
渲染进程 loadURL(dsh://127.0.0.1/)
        │  文档/脚本/fetch  → protocol.handle → net.fetch(http://127.0.0.1:<port>)
        │  /api/events.* WS → IPC → 主进程 WebSocket
```

- agent 与 Electron 主进程是**两个进程**，崩溃隔离、可独立升级；主进程通过 `@dsh-desktop/agent-host` 监管子进程（ready 解析、指数退避重启、日志落盘 `userData/logs/dsh-agent.log`）。
- 数据位置：`DSH_HOME` 默认与命令行共用 `~/.dsh`（API key/profiles/sessions 互通），设 `DSH_HOME` 环境变量可覆盖以隔离测试。
- 渲染层安全基线：`contextIsolation` + `sandbox` + 禁 `nodeIntegration`；导航只放行 `dsh://127.0.0.1`，其余外链走系统浏览器。

## 插件分发（P2 起，ADR-0004）

我们的插件是 **app 内置产品部件**，不是用户态插件——不走 `dsh plugin add`，不碰用户的 web profile。

```
packages/plugins/*（双面包：node 半 + dsh.client 浏览器半，dsh.bundle.patch 自激活）
        │ 构建（镜像的 tsdown.client preset）→ lib/index.js + lib/client.js
        ▼
app 启动时物化 ~/.dsh/profiles/desktop/：manifest（bundles = dsh-base + dsh-web-app + 我们的插件）
        + 空 cordis.patch.yml + node_modules/ 每插件一个符号链接 → 插件构建产物
        ▼
spawn: --profile desktop --no-open --port 0
```

- 解析链路：bundle 双锚点（安装目录 → profile 目录）+ 裸名 Node walk（profile 级 `node_modules` 第一优先），全部为上游既有机制，零上游改动。
- 插件版本 = app 版本；P4 时构建产物经 extraResources 随包携带。
- dev 循环：`tsdown --watch` 重写 `lib/client.js` 即触发 dsh client-hmr 热换（HTTP 模式天然可用）。

## 目录结构与所有权

| 路径 | 内容 | 变更规则 |
| --- | --- | --- |
| `upstream/` | 上游源码 submodule（pin tag） | 只读；升级 = bump submodule |
| `patches/` | 对上游的最小补丁 + `patches.yml` 登记 | 最后手段，须写理由，CI 演练可套用 |
| `apps/desktop/` | Electron 主进程/preload | 我们的代码 |
| `packages/agent-host/` | dsh 子进程监管（纯 Node 库） | 我们的代码 |
| `packages/plugin-kit/` | 客户端插件打包（ModuleLoader 工厂契约） | 我们的代码 |
| `packages/plugins/` | dsh 插件（功能大头，app 内置分发，ADR-0004） | 我们的代码，P2 起 |
| `packages/bridge/` | dsh:// ↔ agent HTTP 映射与 WS 垫片 | 我们的代码 |
| `packages/webui/` | 自组 WebUI 构建 | 我们的代码，P3 起 |
| `vendor/` | 上游包 tarball + `dsh-cli` 独立安装产物（`pnpm pack` + `pnpm install --prod`） | 生成物，可重建 |
| `scripts/` | `sync-upstream.ts` / `dev.ts` / `bundle-node.ts`(P4) | 我们的代码 |

跨 workspace 消费上游的关键：我们的包**不 import 上游 src**，只用 `vendor/` tarball（`pnpm pack` 会把上游内部 `workspace:` 协议解析成实体版本号）。

## 分阶段路线图

- **P0 仓库骨架 + 上游同步链路**（已完成）：submodule 锁版、patch 队列机制、`sync-upstream.ts`、CI 演练。
- **P1 MVP 桌面壳**（已完成）：`dsh web` 子进程 + `loadURL`，零上游改动跑通全功能。
- **P2 插件工作流**（已完成通道）：`@dsh-desktop/hello-panel` 走通「构建 → 物化 `~/.dsh/profiles/desktop` → `--profile desktop` 启动 → `shell.overlay` 出现徽章」（ADR-0004）；此后功能一律走 `packages/plugins/`。
- **P3 官方 Electron 路径**（已完成渲染侧隔离）：`dsh://127.0.0.1` 加载（file:// 的可用替代）+ 主进程代理 agent HTTP；WS 经 IPC。端口/token 不出渲染进程。agent 仍是 loopback HTTP（上游无进程内 IPC 实现）。
- **P4 打包分发**：electron-builder + 捆绑 Node 24 运行时（`scripts/bundle-node.ts`）、签名/公证、自动更新。

## 决策记录

- [ADR-0001 上游源码获取：submodule + patch 队列](adr/0001-upstream-sourcing.md)
- [ADR-0002 MVP 走 HTTP 内嵌，P3 迁 IPC 桥](adr/0002-mvp-transport.md)
- [ADR-0003 Node 运行时策略](adr/0003-node-runtime.md)
- [ADR-0004 内置插件分发：app 托管 desktop profile + 闭包解析](adr/0004-bundled-plugins.md)
