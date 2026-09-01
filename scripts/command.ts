import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process'

/**
 * The executable and leading arguments needed to invoke pnpm without a shell.
 *
 * Package-manager lifecycle environments may expose `npm_execpath` either as
 * the package manager's JavaScript entry point or as a PATH command (pnpm 11
 * uses the latter in some environments). Run JavaScript entries through the
 * same Node executable as this script; invoke other entries directly. Windows
 * callers outside a lifecycle are rejected instead of falling back to a
 * `.cmd` shim that would require unsafe shell interpretation.
 */
export interface PnpmInvocation {
  command: string
  args: string[]
}

export interface PnpmInvocationOptions {
  env?: NodeJS.ProcessEnv
  execPath?: string
  platform?: NodeJS.Platform
}

export function pnpmInvocation(options: PnpmInvocationOptions = {}): PnpmInvocation {
  const env = options.env ?? process.env
  const npmExecPath = env.npm_execpath?.trim()
  if (npmExecPath !== undefined && npmExecPath !== '') {
    if (/\.[cm]?js$/iu.test(npmExecPath)) {
      return {
        command: options.execPath ?? process.execPath,
        args: [npmExecPath],
      }
    }
    if ((options.platform ?? process.platform) === 'win32' && /\.(?:cmd|bat)$/iu.test(npmExecPath)) {
      throw new Error(
        'pnpm invocation: Windows 的 .cmd/.bat npm_execpath 不能在 shell:false 下安全执行；'
          + '请使用 pnpm 的 JavaScript 或可执行入口',
      )
    }
    return {
      command: npmExecPath,
      args: [],
    }
  }

  if ((options.platform ?? process.platform) === 'win32') {
    throw new Error('pnpm invocation: Windows 上请通过 pnpm run 启动脚本（缺少 npm_execpath）')
  }
  return { command: 'pnpm', args: [] }
}

/** Execute an argv vector with shell interpretation disabled. */
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
) {
  return spawnSync(command, [...args], { ...options, shell: false })
}

/** Execute pnpm through its lifecycle entry point, or the platform fallback. */
export function spawnPnpmSync(args: readonly string[], options: SpawnSyncOptions = {}) {
  const invocation = pnpmInvocation({ env: options.env })
  return spawnCommandSync(invocation.command, [...invocation.args, ...args], options)
}
