/**
 * paths.ts — 运行时路径解析。
 *
 * 开发态：dsh CLI 来自 vendor/dsh-cli（sync-upstream 把 CLI tarball 安装成完整
 * node_modules 布局；monorepo 里的 apps/cli/lib/bin.js 无法自行解析插件包）。
 * 打包态：安装产物只携带单个 dsh-cli.tar，首启由 runtime-archive.ts 解压到
 * userData/dsh-runtime/<version>/ 后使用。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'

/**
 * dsh-cli 运行时根目录（内含 node_modules/）。
 * 打包态指向首启解压目标；该目录由 ensureDshRuntime 保证存在。
 */
export function dshRuntimeRoot(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), 'dsh-runtime', app.getVersion())
    : resolve(app.getAppPath(), '../../vendor/dsh-cli')
}

/**
 * 解析 dsh CLI 入口（bin.js）的绝对路径。
 *
 * @returns 存在的候选路径。
 * @throws 打包态：首启解压未完成或安装包损坏；开发态：提示先执行 pnpm sync:upstream。
 */
export function resolveCliEntry(): string {
  const entry = join(dshRuntimeRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) {
    throw new Error(
      app.isPackaged
        ? `dsh 运行时缺失（${entry}）；请重装应用，或删除 ${dshRuntimeRoot()} 后重试`
        : `未找到 dsh CLI 安装产物，请先执行 pnpm sync:upstream（候选：${entry}）`,
    )
  }
  return entry
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
