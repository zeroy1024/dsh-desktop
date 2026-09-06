<div align="center">

<img src="apps/desktop/resources/icons/icon.png" width="96" alt="DeepSeek Harness Desktop 图标">

# DeepSeek Harness Desktop

**把可组合的 agent harness，变成一个真正适合长期工作的桌面工作台。**

[![CI](https://github.com/zeroy1024/dsh-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/zeroy1024/dsh-desktop/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zeroy1024/dsh-desktop?include_prereleases&style=flat-square)](https://github.com/zeroy1024/dsh-desktop/releases)
![Node](https://img.shields.io/badge/node-%3E%3D%2024-339933?logo=node.js&logoColor=white&style=flat-square)
![Platform](https://img.shields.io/badge/platform-macOS%20%E2%80%A2%20Windows%20%E2%80%A2%20Linux-lightgrey?style=flat-square)
[![LINUX DO](https://img.shields.io/badge/community-LINUX.DO-f5b96e?style=flat-square&labelColor=172a32)](https://linux.do/)

[快速开始](#快速开始) · [功能特性](#功能特性) · [与官方 dsh 的关系](#与官方-dsh-的关系) · [架构](#架构) · [常见问题](#常见问题) · [文档](#文档)

<img src="docs/assets/screenshot-workbench.png" width="820" alt="DeepSeek Harness Desktop 工作台：对话流 + 右侧工作面板（文件浏览与代码预览）">

</div>

## 简介

DeepSeek Harness Desktop 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Electron 桌面宿主与产品插件集合。官方 dsh 的会话、工具和模型协议不变；本项目补齐原生窗口、进程监管、右侧工作面板、文件浏览、改动审查和会话管理。

**Electron 管桌面宿主，dsh 作为独立 agent 子进程运行。** 产品功能优先做插件，上游必要改动通过可审计的最小补丁维护。

> [!IMPORTANT]
> 项目与上游 dsh 均处于 **Developer Preview**。接口、数据格式和插件契约可能发生破坏性变化，适合体验和研究，不建议用于生产。

## 快速开始

### 下载安装包

前往 [GitHub Releases](https://github.com/zeroy1024/dsh-desktop/releases) 下载：

| 平台 | 安装包 |
| --- | --- |
| macOS (Apple Silicon) | `.dmg` / `.zip` |
| Windows (x64) | `.exe`（NSIS）/ `.zip` |
| Linux (x64) | `.AppImage` / `.tar.gz` |

当前不提供 Intel Mac 安装包。安装包内置打过补丁的 dsh CLI 和内置插件，首次启动会解压运行时，无需单独安装 Node.js 或 dsh。

> [!WARNING]
> 安装包**未经签名和公证**：macOS 需在「系统设置 → 隐私与安全性」放行；Windows SmartScreen 可能提示未知发布者；Linux AppImage 依赖 FUSE 或 user namespaces（Chromium sandbox 会自动回退）。

### 首次使用

1. 启动应用，打开**设置**，为模型提供商配置 API key。
2. 若已在用命令行 dsh，桌面版默认读取同一份 `~/.dsh`（key、profiles、sessions 互通），一般不必重配。
3. 需要图片理解或联网搜索时，在设置的插件配置里分别填写 Vision / Web Search 的 endpoint 与 key；未配置时这两项不参与请求。

隔离测试可覆盖主目录：`DSH_HOME=/tmp/dsh-desktop-test`。

### 从源码运行

需要 Node.js 24（[`.nvmrc`](.nvmrc)）、pnpm 11.24.0（[`package.json`](package.json) 固定），并能递归初始化 submodule。

```bash
git clone --recurse-submodules https://github.com/zeroy1024/dsh-desktop.git
cd dsh-desktop

pnpm install --filter . --frozen-lockfile --ignore-scripts
pnpm sync:upstream
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 会校验 vendor、构建插件和桌面壳并启动 Electron。本地缺 Electron 二进制时会自动安装。开发命令、测试与打包见 [文档索引](docs/README.md) 和 [CI 说明](docs/ci.md)。

## 功能特性

- **原生窗口**：Windows 标题栏 / WCO / Mica 回退；macOS hidden inset 与 vibrancy；Linux hidden titlebar。
- **进程监管**：dsh 独立子进程运行，宿主负责生命周期、日志脱敏轮转、崩溃发现与恢复。
- **工作面板**：轨迹视图、活动分组、只读文件浏览（含 Markdown 文档预览）、模型切换。
- **改动审查（Review）**：聚合会话内 write/edit 与 Git 未提交改动，按文件看 diff，支持标记、行级评论并回灌给 agent。
- **会话管理**：撤回编辑（Rewind）、归档与恢复、按模型聚合的本机 token 用量。
- **能力补全**：Vision 为文本模型桥接图片证据；Web Search 为 `web_search` 补充结构化来源。

> [!NOTE]
> Review 是「**人审 agent 改动**」的 diff 面板，不是 AI 自动代码审查；Git 模式只覆盖未提交改动。

内置插件随应用分发、开箱可用，名册与开发桩见 [`packages/plugins/`](packages/plugins/)。

## 与官方 dsh 的关系

官方入口是 `npx @deepseek-ai/dsh web`（本地 Web UI + 浏览器）。本项目**不替代这个核心**，只加桌面宿主和产品插件：

| | 官方 dsh | Desktop |
| --- | --- | --- |
| 入口 | CLI 启动 Web UI | 安装包 / `pnpm dev` |
| 宿主 | 浏览器 | Electron 原生窗口 |
| Agent | dsh 进程 | 仍是独立子进程，由 `AgentSupervisor` 监管 |
| 插件 | 官方插件机制 | 随 app staging，不写入用户的 `web` profile |
| 数据 | dsh 存储目录 | 默认共享 `~/.dsh` |

这不是完整 fork：`upstream/` 是锁版 submodule，接缝才进 [`patches/`](patches/patches.yml)。这也不是另一个 agent：会话、工具、模型和 Web 协议仍是 dsh 的。

## 架构

<div align="center">
<img src="docs/assets/architecture.svg" width="820" alt="四层架构：Electron App 监管独立 dsh Agent CLI；官方 Web 与 Cordis 核心之上叠我们的双面插件">
</div>

四层从上到下、从宿主到核心：

1. **Electron App**（`apps/desktop`）：主进程管窗口与 `AgentSupervisor`，渲染进程只承载页面。
2. **dsh Agent CLI**：独立子进程 `dsh --profile desktop --no-open --port 0`，崩溃与 Electron 隔离。
3. **dsh Web**（`upstream/apps/web`）：官方 SPA，由 CLI 的 webServer 提供给渲染进程；源码不改。
4. **我们的插件**（`packages/plugins`）：双面——浏览器半（`dsh.client`）叠在 WebUI 上，Node 半进 Cordis 树。随 app stage，不写入用户的 `web` profile。

主进程 spawn CLI 并解析 ready 端口；渲染进程经 `http://127.0.0.1:<port>/` 使用同一 loopback 的 HTTP/SSE/WS。细节见 [`docs/architecture.md`](docs/architecture.md)。

> [!CAUTION]
> 当前不是 IPC 级隔离：数据面仍是 loopback HTTP；为兼容上游动态模块加载，CSP 仍含 `unsafe-eval` / `unsafe-inline`。

## 常见问题

### 这是官方 dsh 的 fork 吗？

不是完整 fork。submodule 固定上游版本，功能走插件和配置，必要接缝才用补丁队列，以便跟随官方升级。

### 会破坏我的命令行 dsh 配置吗？

不会。默认共享 `~/.dsh`，内置插件只装配在 `desktop` profile，不写入命令行的 `web` profile。完全隔离时设置独立 `DSH_HOME`。

### Review 会自动帮我找 bug 吗？

不会。它帮**人**检查 agent 改动。AI reviewer 与 PR bot 属于后续方向。

### 可以把插件单独装到官方 dsh 吗？

当前是随桌面应用分发的内部部件，不做独立安装承诺。源码可作为扩展参考。

## 文档

- [文档索引](docs/README.md)
- [架构总览](docs/architecture.md) · [窗口与标题栏](docs/overlay-titlebar.md) · [CI](docs/ci.md)

## 致谢

- [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) — agent harness 核心
- [Cordis](https://github.com/cordisjs/cordis) — dsh 的插件化运行时
- [JetBrains intellij-community](https://github.com/JetBrains/intellij-community) — 文件浏览器图标来源（Apache-2.0；完整文本见 [THIRD_PARTY_NOTICES](packages/plugins/file-browser/THIRD_PARTY_NOTICES)）。JetBrains 名称与商标不随图标许可授予。

本项目以 [MIT](LICENSE) 开源。感谢 [LINUX DO](https://linux.do/) 社区。喜欢的话欢迎点一个 Star。
