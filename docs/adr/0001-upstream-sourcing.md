# ADR-0001：上游源码获取 —— git submodule + patch 队列

- 状态：已接受
- 日期：2026-08-29

## 背景

上游处于 developer preview（`0.1.2-alpha.1`），官方明示不保证兼容性。我们既要跟随上游更新，又要在「非必要不动源码、动了也是最小变更」的前提下保留改源码的能力。

## 选项

- **A. git submodule + patch 队列**：完整源码在手，可读源码调试、可 `pnpm pack` 任意包、可用 `git apply` 打最小补丁；同步 = bump submodule + 修 patches。
- **B. 纯 npm 消费**：最省事，但无法打补丁、受发布节奏限制、调试不便。

## 决定

选 A。`upstream/` 为 submodule 并 pin 到具体 tag；**pin 策略：跟随 npm 已发布版本对应的 tag**（当前 `dsh-v0.1.2-rc.1`）。原因：仓库 tag 可能领先 npm 发布（如 `dsh-v0.1.2-alpha.1` 的依赖 `@deepseek-ai/dsh-client-ui-cordis@^0.1.2-alpha.1` 当时并未发布到 registry），而我们的 `vendor/dsh-cli` 安装等价于 `npx @deepseek-ai/dsh`，依赖必须从 registry 可解析。一切源码变更以 `patches/*.patch` 表达并在 `patches/patches.yml` 登记理由；`scripts/sync-upstream.ts` 套用补丁 → install → build → `pnpm pack` 关键包到 `vendor/`；CI 每次演练全链路，保证补丁始终能干净套用。

## 后果

- 升级上游的动作固定为：先确认目标版本已发布到 npm（`pnpm view @deepseek-ai/dsh versions`），再 `git -C upstream fetch && git -C upstream checkout <new-tag>` → 跑 `pnpm sync:upstream` → 修失效补丁。
- 补丁是最后手段：能插件化的不动配置，能配置叠层的不动源码。
- `vendor/` 生成产物不入库，`vendor/dsh-cli/pnpm-lock.yaml` 作为依赖契约入库（其余可由锁定的 submodule 经 `pnpm sync:upstream` 重建）：含上游包 tarball 与 `dsh-cli` 独立安装产物。桌面运行时只使用 `vendor/dsh-cli` 的完整 node_modules 布局——monorepo 里直接跑 `apps/cli/lib/bin.js` 无法解析动态加载的插件包（源码形态靠 tsx 的 tsconfig paths，构建形态按 npm 安装布局设计）。
