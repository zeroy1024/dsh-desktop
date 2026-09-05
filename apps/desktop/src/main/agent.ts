/**
 * agent.ts — AgentSupervisor 的 Electron 侧接线。
 *
 * 每次完整手动重启都新建实例，让事件订阅与重试预算严格归属于这一代进程。
 * 启动前物化 desktop profile（ADR-0004），并以 `--profile desktop` 拉起。
 */
import { AgentSupervisor, materializeDesktopProfile } from '@dsh-desktop/agent-host'
import { join } from 'node:path'
import { app } from 'electron'
import { appVersion, resolveBundledPlugins } from './bundled-plugins'
import { dshHomeDir, logsDir, resolveCliEntry } from './paths'

/** 以桌面配置创建一个新的 supervisor（未 start）。 */
export function createSupervisor(): AgentSupervisor {
  materializeDesktopProfile({
    dshHome: dshHomeDir(),
    plugins: resolveBundledPlugins(),
    version: appVersion(),
  })
  return new AgentSupervisor({
    cliEntry: resolveCliEntry(),
    dshHome: dshHomeDir(),
    logDir: logsDir(),
    // web profile 的 patchReload: live 会加载 cordis-plugin-hmr，要求 Node --expose-internals
    nodeArgs: ['--expose-internals'],
    windowsJobBootstrap: app.isPackaged
      ? join(process.resourcesPath, 'windows-job-bootstrap.cjs')
      : join(import.meta.dirname, 'windows-job-bootstrap.cjs'),
    profileArgs: ['--profile', 'desktop', '--no-open', '--port', '0'],
    // process.execPath 是 Electron 二进制：必须以纯 Node 模式运行，否则 Chromium
    // 会吞掉 --profile 等开关，CLI 报 "--profile <name> is required"
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
}
