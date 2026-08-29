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
