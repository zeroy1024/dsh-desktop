/**
 * ci-electron-sandbox-probe.ts — 在真实 Electron 宿主里验证 koffi 的拷贝式
 * UTF-16 读取（upstream patches/0015 的 readUtf16 修复面）。
 *
 * patches/0015 把 win32 目录选择器的字符串读出改为 `koffi.decode.string16(addr)`：
 * 它是拷贝式读取，构建全新的 V8 字符串；而 `koffi.view` 把外来内存包成外部
 * ArrayBuffer，在 Electron 全进程强制启用的 V8 Sandbox 下会 fatal。CI 的
 * fake-koffi 单测只能验证调用路径，覆盖不了真实宿主。本探针以
 * `ELECTRON_RUN_AS_NODE=1` 启动 Electron 二进制，在其携带的 V8 运行时里做一次
 * `koffi.alloc` → `koffi.encode` → `koffi.decode.string16` round-trip，失败即
 * 非零退出。V8 Sandbox 是 Electron 所有平台的强制行为，故探针不需要平台分叉。
 *
 * Usage:
 *   pnpm ci:probe-electron-sandbox
 *   pnpm exec tsx scripts/ci-electron-sandbox-probe.ts [--electron-binary <path>]
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export interface ElectronSandboxKoffiProbeOptions {
  /** Electron 可执行文件路径；缺省解析 apps/desktop 的 electron 依赖。 */
  electronBinary?: string
  /** Electron 宿主子进程超时（ms），缺省 60s。 */
  timeoutMs?: number
}

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultVendorPackageJson = join(scriptRoot, 'vendor', 'dsh-cli', 'package.json')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 解析 apps/desktop 依赖的 Electron 可执行文件路径（未下载时给出可操作的错误）。 */
export function resolveElectronBinary(): string {
  const desktopPackageJson = join(scriptRoot, 'apps', 'desktop', 'package.json')
  let electronBinary: unknown
  try {
    electronBinary = createRequire(desktopPackageJson)('electron')
  } catch (error) {
    throw new Error(
      `无法解析 Electron 二进制（${errorMessage(error)}）；`
        + '请先运行 pnpm --filter @dsh-desktop/desktop exec install-electron。',
      { cause: error },
    )
  }
  if (typeof electronBinary !== 'string' || electronBinary === '') {
    throw new Error(`electron 包导出不是可执行文件路径：${String(electronBinary)}`)
  }
  return electronBinary
}

/**
 * 探针入口源码（.mjs，在 ELECTRON_RUN_AS_NODE 的 Electron 进程里执行）：从
 * vendor/dsh-cli 闭包加载 koffi，写入已知含非 ASCII 的 UTF-16LE 串（含终止
 * NUL），用 0015 同款 `koffi.decode.string16` 读回并断言 round-trip 相等。
 */
const PROBE_ENTRY_SOURCE = [
  "import { createRequire } from 'node:module'",
  "const vendorPackageJson = process.env.PROBE_VENDOR_PACKAGE_JSON",
  "if (vendorPackageJson === undefined || vendorPackageJson === '') {",
  "  console.error('[probe] PROBE_VENDOR_PACKAGE_JSON is not set')",
  '  process.exit(1)',
  '}',
  'const require = createRequire(vendorPackageJson)',
  'let koffi',
  'try {',
  "  koffi = require('koffi')",
  '} catch (error) {',
  "  console.error('[probe] failed to load koffi from vendor closure:', error)",
  '  process.exit(1)',
  '}',
  'try {',
  "  const sample = '桌面A1'",
  '  const units = []',
  '  for (const ch of sample) units.push(ch.charCodeAt(0))',
  '  const length = units.length + 1 // 终止 NUL',
  "  const buffer = koffi.alloc('char16_t', length)",
  '  try {',
  "    koffi.encode(buffer, 'char16_t', [...units, 0], length)",
  '    const decoded = koffi.decode.string16(buffer)',
  '    if (decoded !== sample) {',
  '      throw new Error(',
  "        `round-trip mismatch: expected ${JSON.stringify(sample)}, got ${JSON.stringify(decoded)}`,",
  '      )',
  '    }',
  '  } finally {',
  '    koffi.free(buffer)',
  '  }',
  "  console.log('[probe] electron sandbox koffi decode.string16 ok')",
  '} catch (error) {',
  "  console.error('[probe]', error)",
  '  process.exit(1)',
  '}',
].join('\n')

/** 在真实 Electron 宿主里执行探针；非零退出或超时即抛错。 */
export async function probeElectronSandboxKoffi(
  options: ElectronSandboxKoffiProbeOptions = {},
): Promise<void> {
  const electronBinary = options.electronBinary !== undefined ? options.electronBinary : resolveElectronBinary()
  const timeoutMs = options.timeoutMs ?? 60_000
  // 入口写在系统临时目录，Electron 子进程以独立脚本方式执行；失败路径照常清理。
  const probeEntry = join(tmpdir(), `probe-${process.pid}.mjs`)
  writeFileSync(probeEntry, PROBE_ENTRY_SOURCE, 'utf8')
  try {
    const result = spawnSync(electronBinary, [probeEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PROBE_VENDOR_PACKAGE_JSON: defaultVendorPackageJson,
      },
      stdio: 'inherit',
      timeout: timeoutMs,
    })
    if (result.error !== undefined) {
      if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error(`Electron sandbox probe 超时（${String(timeoutMs)}ms）`, { cause: result.error })
      }
      throw new Error(`Electron 宿主启动失败：${errorMessage(result.error)}`, { cause: result.error })
    }
    if (result.status !== 0) {
      throw new Error(`Electron sandbox probe 退出码 ${String(result.status)}（预期 0，探针入口日志见上）`)
    }
  } finally {
    rmSync(probeEntry, { force: true })
  }
}

interface CliOptions extends ElectronSandboxKoffiProbeOptions {
  help: boolean
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = { help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--electron-binary': {
        const value = argv[index + 1]
        if (value === undefined || value.trim() === '') throw new Error('--electron-binary 需要路径')
        options.electronBinary = resolve(value)
        index += 1
        break
      }
      case '--timeout-ms': {
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--timeout-ms 需要数值')
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--timeout-ms 必须是正整数')
        options.timeoutMs = parsed
        index += 1
        break
      }
      case '--help':
      case '-h':
        console.log([
          'Usage: ci-electron-sandbox-probe [options]',
          '',
          '  --electron-binary <path>   Electron 可执行文件路径（缺省解析 apps/desktop 依赖）',
          '  --timeout-ms <ms>          Electron 宿主子进程超时（默认 60000）',
        ].join('\n'))
        options.help = true
        return options
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv)
  if (options.help) return
  await probeElectronSandboxKoffi(options)
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`[probe-electron-sandbox] ${errorMessage(error)}`)
    process.exitCode = 1
  })
}