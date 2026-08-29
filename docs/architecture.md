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

## 数据流（P1 MVP）

```
Electron 主进程 ──spawn──▶ node vendor/dsh-cli/…/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0
        │                        │ stdout: "dsh web: http://127.0.0.1:<port>/?token=<t>"
        │                        ▼
        │◀── AgentSupervisor 解析 ready 行 ──┘
        ▼
BrowserWindow.loadURL(带 token 的 URL) ──▶ dsh webui（HTTP + SSE/WS，token 换签名 cookie）
```

- agent 与 Electron 主进程是**两个进程**，崩溃隔离、可独立升级；主进程通过 `@dsh-desktop/agent-host` 监管子进程（ready 解析、指数退避重启、日志落盘 `userData/logs/dsh-agent.log`）。
- 数据位置：`DSH_HOME` 默认与命令行共用 `~/.dsh`（API key/profiles/sessions 互通），设 `DSH_HOME` 环境变量可覆盖以隔离测试。
- 渲染层安全基线：`contextIsolation` + `sandbox` + 禁 `nodeIntegration`；导航/弹窗只放行 agent origin，其余外链走系统浏览器。

## 目录结构与所有权

| 路径 | 内容 | 变更规则 |
| --- | --- | --- |
| `upstream/` | 上游源码 submodule（pin tag） | 只读；升级 = bump submodule |
| `patches/` | 对上游的最小补丁 + `patches.yml` 登记 | 最后手段，须写理由，CI 演练可套用 |
| `apps/desktop/` | Electron 主进程/preload | 我们的代码 |
| `packages/agent-host/` | dsh 子进程监管（纯 Node 库） | 我们的代码 |
| `packages/plugins/` | dsh 插件（功能大头） | 我们的代码，P2 起 |
| `packages/bridge/` | fetch-over-IPC 载体 | 我们的代码，P3 起 |
| `packages/webui/` | 自组 WebUI 构建 | 我们的代码，P3 起 |
| `vendor/` | 上游包 tarball + `dsh-cli` 独立安装产物（`pnpm pack` + `pnpm install --prod`） | 生成物，可重建 |
| `scripts/` | `sync-upstream.ts` / `dev.ts` / `bundle-node.ts`(P4) | 我们的代码 |

跨 workspace 消费上游的关键：我们的包**不 import 上游 src**，只用 `vendor/` tarball（`pnpm pack` 会把上游内部 `workspace:` 协议解析成实体版本号）。

## 分阶段路线图

- **P0 仓库骨架 + 上游同步链路**（已完成）：submodule 锁版、patch 队列机制、`sync-upstream.ts`、CI 演练。
- **P1 MVP 桌面壳**（已完成）：`dsh web` 子进程 + `loadURL`，零上游改动跑通全功能。
- **P2 插件工作流**：示例插件 hello-panel 走通「开发 → pack → `dsh plugin add` → UI 出现」；此后功能一律走插件。
- **P3 官方 Electron 路径**：`file://` 加载 + `packages/bridge` IPC fetch 载体（上游在 `packages/host/webserver/src/index.ts` 明确预留此接缝：*"Electron uses file:// plus IPC instead"*）；组装专用 `desktop` profile（配置叠层）；移除端口/token 面。
- **P4 打包分发**：electron-builder + 捆绑 Node 24 运行时（`scripts/bundle-node.ts`）、签名/公证、自动更新。

## 决策记录

- [ADR-0001 上游源码获取：submodule + patch 队列](adr/0001-upstream-sourcing.md)
- [ADR-0002 MVP 走 HTTP 内嵌，P3 迁 IPC 桥](adr/0002-mvp-transport.md)
- [ADR-0003 Node 运行时策略](adr/0003-node-runtime.md)
