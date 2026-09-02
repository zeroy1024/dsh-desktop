/**
 * stage-runtime-archive.ts — 把 vendor/dsh-cli 运行时闭包打成单个未压缩 tar。
 *
 * 动机：NSIS/dmg/zip 逐文件携带上万个小文件时，Windows 安装/升级/卸载极慢
 * （每个文件写入都过 Defender 实时扫描）。打包态改为只携带一个 tar，首启时
 * 由主进程解压到 userData（见 src/main/runtime-archive.ts）。
 *
 * 不做内层压缩：NSIS solid lzma / dmg UDZO / zip deflate 会在外层压缩，
 * .tar 原样进入产物，安装包体积基本持平，首启解压免 gunzip。
 *
 * 用法（package:* 脚本链内调用，需先完成 pnpm build 即插件 staging）：
 *   tsx ./stage-runtime-archive.ts
 */
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)))
const sourceDir = resolve(appDir, '..', '..', 'vendor', 'dsh-cli')
const outputDir = join(appDir, '.runtime-archive')
const outputTar = join(outputDir, 'dsh-cli.tar')
const fileListPath = join(outputDir, '.file-list.txt')

/** 与 electron-builder.yml 历史上 extraResources 的剪枝 filter 保持一致。 */
const PRUNE_EXTENSIONS = ['.map', '.ts', '.mts', '.cts', '.md', '.pdb']
const PRUNE_DIR_NAMES = new Set([
  'example',
  'examples',
  'test',
  'tests',
  'spec',
  '__tests__',
  'coverage',
])
/** 顶层随包携带的 CLI 安装契约文件。 */
const TOP_LEVEL_FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
/** 验收抽查：运行时必要入口与内置插件 scope。 */
const REQUIRED_MEMBERS = [
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@dsh-desktop/',
]

function shouldPrune(relativePath: string): boolean {
  const segments = relativePath.split('/')
  const base = segments[segments.length - 1]!
  if (base.startsWith('CHANGELOG')) return true
  if (PRUNE_EXTENSIONS.some((extension) => base.endsWith(extension))) return true
  // yaml 包的 doc/ 是运行时依赖（directives.js），不在剪枝名单内
  return segments.some((segment) => PRUNE_DIR_NAMES.has(segment))
}

/** 递归收集 node_modules 下的文件与符号链接（tar -h 负责解引用），空目录忽略。 */
function collectFiles(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      collectFiles(fullPath, relativePath, out)
      continue
    }
    // 符号链接（.bin shim）与实体文件一样登记；目录符号链接由 -h 展开目标内容
    if (entry.isFile() || entry.isSymbolicLink()) {
      if (!shouldPrune(relativePath)) out.push(relativePath)
    }
  }
}

function runTar(args: string[]): string {
  const result = spawnSync('tar', args, {
    cwd: sourceDir,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) {
    throw new Error(`stage runtime archive: 无法执行系统 tar：${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`stage runtime archive: tar 失败（exit ${result.status}）：${result.stderr.trim()}`)
  }
  return result.stdout
}

function main(): void {
  if (!existsSync(join(sourceDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error('stage runtime archive: 缺少 vendor/dsh-cli 安装产物，请先运行 pnpm sync:upstream')
  }
  if (!existsSync(join(sourceDir, 'node_modules', '@dsh-desktop'))) {
    throw new Error('stage runtime archive: 缺少已 staging 的内置插件，请先运行 pnpm build')
  }

  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  const members: string[] = []
  for (const file of TOP_LEVEL_FILES) {
    if (existsSync(join(sourceDir, file))) members.push(file)
  }
  collectFiles(join(sourceDir, 'node_modules'), 'node_modules', members)

  // ./ 前缀避免 GNU tar 把以 - 开头的 -T 条目当成选项
  const fd = openSync(fileListPath, 'w')
  try {
    for (const member of members) writeSync(fd, `./${member}\n`)
  } finally {
    closeSync(fd)
  }

  runTar(['-cf', outputTar, '-h', `-T${fileListPath}`])
  rmSync(fileListPath, { force: true })

  const listing = runTar(['-tf', outputTar])
  for (const required of REQUIRED_MEMBERS) {
    if (!listing.includes(`./${required}`) && !listing.includes(required)) {
      throw new Error(`stage runtime archive: 产物缺少必要成员 ${required}`)
    }
  }

  const sizeMiB = (statSync(outputTar).size / 1024 / 1024).toFixed(1)
  console.log(`[runtime-archive] staged: ${outputTar}（${members.length} 个文件，${sizeMiB} MiB）`)
}

main()
