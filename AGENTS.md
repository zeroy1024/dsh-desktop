# AGENTS.md

DeepSeek Harness Desktop：用 Electron 封装 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的桌面应用。这不是套壳项目——后续所有二次开发遵循下面的边界铁律。架构详见 [docs/architecture.md](docs/architecture.md)。

## 边界铁律

1. `upstream/`（git submodule）**永不直接编辑**。一切上游源码变更 = `patches/*.patch`，且必须在 `patches/patches.yml` 登记理由；`scripts/sync-upstream.ts` 负责套用，CI 演练校验。
2. 新功能实现优先级：**dsh 插件 > cordis.patch.yml 配置叠层 > patches/*.patch**。功能大头全部放 `packages/plugins/`。
3. UI 变更优先做**客户端插件**（package.json 的 `dsh.client` 段），不改上游 `apps/web` 源码。
4. 我们的代码**不 import 上游 src**；编译期依赖只经 `vendor/` 里 `pnpm pack` 产出的 tarball。
5. 运行时依赖只经「子进程 + 协议」（当前为渲染进程直连 `http://127.0.0.1:<port>/`；真 IPC 等上游有实现再做），不把上游进程内嵌进 Electron 主进程。不维护自定义协议 HTTP 代理。

## 目录结构

```
upstream/           git submodule，pin 到 npm 已发布版本对应的 tag（当前 dsh-v0.1.2-rc.1）
patches/            对上游的最小补丁队列 + patches.yml 登记
apps/desktop/       Electron 壳（主进程 + preload）
packages/agent-host/  dsh 子进程监管库（纯 Node，可单测）
packages/bridge/    当前一代 agent 的 loopback HTTP origin 判定
packages/plugin-kit/  客户端插件打包（ModuleLoader 工厂，镜像上游 tsdown.client 契约）
packages/plugins/   我们的 dsh 插件群（功能大头；app 内置分发，ADR-0004，不走 dsh plugin add 装用户 profile）
scripts/            sync-upstream / dev
vendor/             上游包 tarball + dsh-cli 独立安装（gitignore，可重新生成）
docs/               README.md 索引 + 当前维护说明 + adr/ 决策 + history/ 历史记录
```
注：`packages/webui`（自组 WebUI 构建）为预留，尚未创建；真 IPC 接入时才建（ADR-0002）。

## 常用命令

```bash
pnpm sync:upstream      # 套补丁 → build → 自动 pack/override 补丁涉及的包 → 重建 vendor/dsh-cli
pnpm dev                # 一键开发：校验产物 → 构建插件 + desktop → 启动 Electron
pnpm test               # 全部单测
pnpm lint               # oxlint
pnpm typecheck          # 根 tsc（scripts/）+ 全部 workspace 类型检查
```

## Release 规范

- 每次发布必须更新根目录 `CHANGELOG.md`，它是 GitHub Release 版本变更摘要的唯一来源。
  文案随发布提交纳入版本控制；CI 从该提交提取目标版本章节，创建或更新 Release。
- 变更范围必须明确为「上一已发布版本 tag → 当前发布 tag/提交」。当前预览阶段，
  上一版本包含已发布的 prerelease，不包含 draft 或尚未发布的 tag。比较基线须在
  版本章节的 Full Changelog 链接中固定；重跑旧版本不得重新选择基线，也不得纳入
  目标发布提交之后的改动。首次发布无前序版本时，明确标注首次发布并总结初始能力。
- 每个版本必须提供内容对应的中文和英文说明，中文在前、英文在后。按「新增 / Added」
  「改进 / Changed」「修复 / Fixed」分类，省略空分类。如有破坏性变更、迁移要求或
  重要已知问题，必须在两种语言中明确说明。
- 发布说明面向用户描述变化与影响。根据提交差异和实际代码核实内容，合并同一功能的
  多次提交，不直接堆砌 commit 标题。纯重构、测试、CI 或补丁整理通常不单列，除非
  影响安装、兼容性或使用行为。
- 固定安装说明保持简短，并提供中英双语；详细平台说明链接到安装文档。不得以通用
  安装说明替代本版本的实际变更摘要。
- 发布前必须校验目标版本章节、双语内容和比较链接完整且无占位文本；首次发布按上述
  例外处理。缺失时应在打包前报错，不得静默回退为固定模板。同一发布提交重复执行，
  应生成一致的 Release 文案。脚本负责结构校验，双语语义一致性及摘要与代码相符由
  准备版本的维护者或 agent 审阅。
- 修改发布规范、脚本或文案不等于授权发布。创建或推送发布 tag、发布新版本，以及
  修改已发布 Release，均须在用户明确授权的范围内执行；已有明确授权时不重复确认。

## 环境注意

- Node 24（`.nvmrc`）；上游强依赖 `node:sqlite`。
- 上游处于 developer preview，接口可随时破坏；submodule pin 跟随 **npm 已发布版本**（`pnpm view @deepseek-ai/dsh versions`），仓库 tag 可能领先 registry 而不可用于 vendor 安装。
- electron@44+ **不再自动下载二进制**：`pnpm install` 后如缺 `dist/`，`pnpm dev` 会自动跑 `install-electron`，手动则是 `pnpm --filter @dsh-desktop/desktop exec install-electron`。
- pnpm 11 默认禁止依赖安装脚本；本仓库经 `pnpm-workspace.yaml` 的 `allowBuilds` 放行 esbuild/electron。
- TypeScript 6 不再自动包含 `@types/*`，`tsconfig.base.json` 已显式 `"types": ["node"]`。
- 桌面版 `DSH_HOME` 默认共用 `~/.dsh`（与命令行互通）；需隔离测试时设 `DSH_HOME` 环境变量覆盖。
