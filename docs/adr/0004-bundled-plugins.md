# ADR-0004：内置插件分发 —— app 托管 desktop profile + 闭包解析

- 状态：已接受
- 日期：2026-08-29

## 背景

本项目的一切二次开发落在 `packages/plugins/` 的 dsh 插件上（边界铁律 #2）。这些插件是**产品的一部分**：随 app 打包分发、版本与 app 一致、用户开箱即用——而不是用户态插件（`dsh plugin add` 装进 `$DSH_HOME/profiles/<name>`）。用户态路径会把插件泄漏到命令行 `dsh` 的共享 profile，版本不受 app 控制，用户卸载/改动会反向影响 app。

机制前提（上游 rc.2 源码核实）：

- 组合包（bundle）解析是双锚点：dsh 安装目录优先，profile 目录其次（`upstream/packages/boot/app-boot/src/profile.ts:344-355` `resolveBundleDir`），锚点解析走 `createRequire(anchor).resolve.paths()` 的父目录 walk（profile.ts:322-330）。
- 裸插件名挂载从 `ctx.baseUrl`（= profile 目录）按 Node 标准 walk 向上找：`profiles/<name>/node_modules` 第一优先，然后是共享后备 `profiles/node_modules`。
- 共享后备由 dsh 每次启动自愈（`healProfilesModuleFallback`，profile.ts:223-255），但 BFS 起点是 **dsh 包自身的 manifest**——只覆盖 dsh 闭包，我们的插件不在其中，需要自己在 profile 级 `node_modules` 建链接。
- profile = 目录里的 manifest（`dsh.profile.bundles`）+ `cordis.patch.yml`；`cordis.yml` 空根每次启动被 dsh 重写（profile-boot.ts:101），不可预置内容。
- 插件包声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 即自激活（配置层随 bundle 进栈）；客户端插件另需 `dsh.client` 声明 + `./client` export（`upstream/packages/client/modules/src/index.ts:49-63,451-453`）。

## 选项

- **A. `dsh plugin add` 装进用户的 web profile**：开箱即用，但污染命令行 dsh、插件版本不受 app 控制。否决。
- **B. 物化带完整 node_modules 的 desktop profile**：隔离最干净，但每版本要往用户目录复制整个依赖闭包，还要处理同名冲突与清理。重。
- **C. app 托管轻量 desktop profile + 插件经 node walk 闭包解析（选定）**：profile 目录只有 manifest、空 patch 和**每插件一个符号链接**（指向 app 内置的插件构建产物）；运行时装配（cordis、服务定义包等 peer 依赖）经符号链接真实位置向上解析，与 dsh 安装闭包保持一致。

## 决定

采用 C。P2 落地时具体化为：

1. `packages/plugins/*` 为双面插件包：node 半（cordis entry，纯 UI 插件可为空 `apply`）+ 浏览器半（`lib/client.js`）；package.json 声明 `dsh.bundle.patch`（自激活）与 `dsh.client`（`platform: 'web'`，浏览器名册）。
2. desktop 主进程启动 agent 前物化/自愈 `$DSH_HOME/profiles/desktop/`：
   - `package.json`：`dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...我们的插件]`；
   - `cordis.patch.yml`：`[]`（我们的配置层由各插件自带的 bundle patch 贡献）；
   - `node_modules/<插件名>` → 插件构建产物的符号链接（dev 指向 workspace，打包态指向 app resources）；
   - 版本戳自愈；`cordis.yml` 不预置（dsh 自己维护）；已存在的非本 app profile 不覆盖。
3. 启动参数从 `--profile web` 切到 `--profile desktop`。用户的 web profile 与命令行 dsh 零接触。
4. 客户端构建 preset（上游 `packages/client/tsdown.client.ts`，不在 npm tarball 内）在本仓库镜像复刻（banner/footer 工厂包装、externals 基线、CSS Modules），注明来源；bump submodule 时对照上游原文更新。

## 后果

- 插件版本 = app 版本；P4 打包时插件构建产物经 extraResources 随包携带，profile 物化逻辑不变。
- dev 循环：插件 `tsdown --watch` 重写 `lib/client.js` → dsh client-hmr 500ms 轮询 → SSE `/plugins/events` → 浏览器热换（HTTP 模式下对仓库外插件天然可用，上游 `scripts/dev-web.ts:1-7` 明示）。node 半改动仍需重启 agent。
- file://（P3）下 HMR 的 EventSource 是硬编码 HTTP 端点（`packages/client/hmr/src/client/index.ts:167`），需随 IPC 桥一并解决。
- 镜像的构建 preset 是维护点：上游 pre-release 无兼容承诺，`dsh.client` schema 与 preset 变更需列入升级 checklist。
- dev 态符号链接目标（workspace 直链 vs vendor 安装副本）以保证 cordis/服务定义包单例为准，P2 实现时验证固化。
