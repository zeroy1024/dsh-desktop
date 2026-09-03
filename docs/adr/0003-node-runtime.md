# ADR-0003：Node 运行时策略

- 状态：已接受
- 日期：2026-08-29

## 背景

上游要求 Node `^22.19 || >=24` 且依赖 `node:sqlite`。dsh 以子进程运行，需要一个 Node 可执行文件。Electron 内嵌的 Node 版本不可控（随 Electron 版本漂移），`ELECTRON_RUN_AS_NODE` 虽能复用它，但无法保证满足 `node:sqlite` 等要求。

## 决定

- **开发期**：用系统 Node 24（`.nvmrc` 锁定）起 agent 子进程，`AgentSupervisor` 默认 `process.execPath`。
- **分发期（P4）**：`scripts/bundle-node.ts` 按平台下载官方 Node 24 运行时并校验 SHA256，经 electron-builder `extraResources` 携带；`AgentSupervisor` 在 `app.isPackaged` 时指向捆绑运行时。

## 后果

- 不依赖用户机器上的 Node 版本；升级 Node = 改 `bundle-node.ts` 里的版本与校验值。
- Electron 升级不再受「内嵌 Node 是否满足上游」约束。

## 修订（2026-09）

P4 打包落地时**未捆绑独立 Node 运行时**（`scripts/bundle-node.ts` 从未存在）：打包态 agent 子进程改用 `ELECTRON_RUN_AS_NODE` 复用 Electron 内嵌的 Node——`apps/desktop/src/main/agent.ts` 以 `process.execPath` + `env: { ELECTRON_RUN_AS_NODE: '1' }` 拉起 dsh（`apps/desktop/electron-builder.yml` 注释也自认「独立 Node 24 runtime、签名/公证与自动更新仍属于后续完整 P4」）。依据：三平台 packaged smoke（`scripts/smoke-packaged.ts`）分别启动 darwin/win32/linux 打包产物，验证 dsh（含 `node:sqlite`）在该宿主下可用。

回退条件：若 Electron 内嵌 Node 版本不再满足 dsh engines（`^22.19 || >=24`），或 `node:sqlite` 的编译选项随 Electron 升级不再满足，回到捆绑方案（届时再引入 `bundle-node.ts`）。本修订取代上文「决定·分发期（P4）」与「后果」中为捆绑 Node 写的表述。
