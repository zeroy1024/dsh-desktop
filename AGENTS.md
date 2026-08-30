# AGENTS.md

DeepSeek Harness Desktop：用 Electron 封装 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的桌面应用。这不是套壳项目——后续所有二次开发遵循下面的边界铁律。架构详见 [docs/architecture.md](docs/architecture.md)。

## 边界铁律

1. `upstream/`（git submodule）**永不直接编辑**。一切上游源码变更 = `patches/*.patch`，且必须在 `patches/patches.yml` 登记理由；`scripts/sync-upstream.ts` 负责套用，CI 演练校验。
2. 新功能实现优先级：**dsh 插件 > cordis.patch.yml 配置叠层 > patches/*.patch**。功能大头全部放 `packages/plugins/`。
3. UI 变更优先做**客户端插件**（package.json 的 `dsh.client` 段），不改上游 `apps/web` 源码。
4. 我们的代码**不 import 上游 src**；编译期依赖只经 `vendor/` 里 `pnpm pack` 产出的 tarball。
5. 运行时依赖只经「子进程 + 协议」（当前为 127.0.0.1 HTTP/SSE + launch token，P3 迁 IPC 桥），不把上游进程内嵌进 Electron 主进程。

## 目录结构

```
upstream/           git submodule，pin 到 npm 已发布版本对应的 tag（当前 dsh-v0.1.1-rc.2）
patches/            对上游的最小补丁队列 + patches.yml 登记
apps/desktop/       Electron 壳（主进程 + preload）
packages/agent-host/  dsh 子进程监管库（纯 Node，可单测）
packages/bridge/    (P3) fetch-over-IPC 载体
packages/webui/     (P3) 自组 WebUI 构建
packages/plugin-kit/  客户端插件打包（ModuleLoader 工厂，镜像上游 tsdown.client 契约）
packages/plugins/   我们的 dsh 插件群（功能大头；app 内置分发，ADR-0004，不走 dsh plugin add 装用户 profile）
scripts/            sync-upstream / dev / bundle-node
vendor/             上游包 tarball + dsh-cli 独立安装（gitignore，可重新生成）
docs/               architecture.md + adr/
```

## 常用命令

```bash
pnpm sync:upstream      # 上游同步：套用补丁 → install → build → pack 到 vendor/
pnpm dev                # 一键开发：校验产物 → 构建插件 + desktop → 启动 Electron
pnpm test               # 全部单测
pnpm lint               # oxlint
pnpm -r typecheck       # 全部类型检查
```

## 环境注意

- Node 24（`.nvmrc`）；上游强依赖 `node:sqlite`。
- 上游处于 developer preview，接口可随时破坏；submodule pin 跟随 **npm 已发布版本**（`pnpm view @deepseek-ai/dsh versions`），仓库 tag 可能领先 registry 而不可用于 vendor 安装。
- electron@44+ **不再自动下载二进制**：`pnpm install` 后如缺 `dist/`，`pnpm dev` 会自动跑 `install-electron`，手动则是 `pnpm --filter @dsh-desktop/desktop exec install-electron`。
- pnpm 11 默认禁止依赖安装脚本；本仓库经 `pnpm-workspace.yaml` 的 `allowBuilds` 放行 esbuild/electron。
- TypeScript 6 不再自动包含 `@types/*`，`tsconfig.base.json` 已显式 `"types": ["node"]`。
- 桌面版 `DSH_HOME` 默认共用 `~/.dsh`（与命令行互通）；需隔离测试时设 `DSH_HOME` 环境变量覆盖。
