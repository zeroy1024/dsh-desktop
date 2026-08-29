/**
 * paths.ts — 运行时路径解析。
 *
 * 开发态：dsh CLI 来自 vendor/dsh-cli（sync-upstream 把 CLI tarball 安装成完整
 * node_modules 布局；monorepo 里的 apps/cli/lib/bin.js 无法自行解析插件包）。
 * 打包态（P4）：同一安装产物由 electron-builder extraResources 携带。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'

/**
 * 解析 dsh CLI 入口（bin.js）的绝对路径。
 *
 * @returns 存在的候选路径。
 * @throws 所有候选都不存在时，提示先执行 pnpm sync:upstream。
 */
export function resolveCliEntry(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
    : [
        resolve(
          app.getAppPath(),
          '../../vendor/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js',
        ),
      ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`未找到 dsh CLI 安装产物，请先执行 pnpm sync:upstream（候选：${candidates.join('、')}）`)
  }
  return found
}

/**
 * DSH_HOME：默认与命令行 `dsh` 共用 `~/.dsh`（API key/profiles/sessions 开箱即用），
 * 设了 `DSH_HOME` 环境变量则用其覆盖（隔离测试时手动指定）。
 */
export function dshHomeDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** agent 日志目录（dsh-agent.log）。 */
export function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}
