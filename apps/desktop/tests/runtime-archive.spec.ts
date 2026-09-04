import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  canSelfHealRuntime,
  ensureDshRuntime,
  invalidateDshRuntime,
  sweepOldRuntimes,
} from '../src/main/runtime-archive'

/** 用系统 tar 造一个最小合法运行时包（仅 CLI 入口与一个普通文件）。 */
function buildFixtureArchive(archivePath: string): void {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-runtime-fixture-'))
  try {
    const entryDir = join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(join(entryDir, 'bin.js'), '// stub cli entry\n')
    writeFileSync(join(staging, 'package.json'), '{"name":"dsh-cli-fixture"}\n')
    execFileSync('tar', ['-cf', archivePath, '-C', staging, '.'])
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

let workDir = ''
let userDataDir = ''
let archivePath = ''

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dsh-runtime-test-'))
  userDataDir = join(workDir, 'userData')
  archivePath = join(workDir, 'dsh-cli.tar')
  buildFixtureArchive(archivePath)
  await mkdir(userDataDir, { recursive: true })
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

const VERSION = '0.0.1'
const versionDir = (): string => join(userDataDir, 'dsh-runtime', VERSION)

describe('ensureDshRuntime', () => {
  it('首次解压出 CLI 入口并写完成标记', async () => {
    const dir = await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    expect(dir).toBe(versionDir())
    expect(readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8'))
      .toBe('// stub cli entry\n')
    const marker = JSON.parse(readFileSync(join(dir, '.complete'), 'utf8')) as { size: number }
    expect(marker.size).toBe(statSync(archivePath).size)
  })

  it('标记命中时短路，不触碰已有目录', async () => {
    const sentinel = join(versionDir(), 'sentinel.txt')
    await writeFile(sentinel, 'keep\n')
    const markerMtime = statSync(join(versionDir(), '.complete')).mtimeMs
    const dir = await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    expect(dir).toBe(versionDir())
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n')
    expect(statSync(join(versionDir(), '.complete')).mtimeMs).toBe(markerMtime)
  })

  it('标记与 tar 不一致时重新解压', async () => {
    await writeFile(join(versionDir(), '.complete'), '{"size":-1,"mtimeMs":-1}\n')
    await writeFile(join(versionDir(), 'stale.txt'), 'stale\n')
    await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    expect(readFileSync(join(versionDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8'))
      .toBe('// stub cli entry\n')
    expect(readdirSync(versionDir())).not.toContain('stale.txt')
  })

  it('标记命中但 CLI 入口缺失时重新解压（AV 隔离/部分删除自愈）', async () => {
    await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    const entry = join(versionDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    rmSync(entry) // 模拟 AV 隔离/部分删除：标记完好但入口被移走
    await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    expect(readFileSync(entry, 'utf8')).toBe('// stub cli entry\n')
  })

  it('标记命中且入口完好时仍短路，不重解压', async () => {
    await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    const sentinel = join(versionDir(), 'sentinel2.txt')
    await writeFile(sentinel, 'keep\n')
    const markerMtime = statSync(join(versionDir(), '.complete')).mtimeMs
    const dir = await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    expect(dir).toBe(versionDir())
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n')
    expect(statSync(join(versionDir(), '.complete')).mtimeMs).toBe(markerMtime)
  })

  it('原子写标记不留临时文件残留', async () => {
    await ensureDshRuntime({ userDataDir, version: VERSION, archivePath })
    expect(readdirSync(versionDir()).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('解压失败时清理临时目录，不留半成品', async () => {
    const notTar = join(workDir, 'not-a-tar.bin')
    await writeFile(notTar, 'definitely not a tar archive\n')
    await expect(ensureDshRuntime({ userDataDir, version: '9.9.9', archivePath: notTar }))
      .rejects.toThrow('解压失败')
    const rootEntries = readdirSync(join(userDataDir, 'dsh-runtime'))
    expect(rootEntries.filter((entry) => entry.includes('9.9.9'))).toEqual([])
  })

  it('安装产物缺少 tar 时给出可读错误', async () => {
    await expect(ensureDshRuntime({
      userDataDir,
      version: '9.9.8',
      archivePath: join(workDir, 'missing.tar'),
    })).rejects.toThrow('缺少运行时包')
  })

  it('拒绝非法版本号', async () => {
    await expect(ensureDshRuntime({ userDataDir, version: '../escape', archivePath }))
      .rejects.toThrow('非法版本号')
  })
})

describe('canSelfHealRuntime / invalidateDshRuntime', () => {
  it('自愈决策：仅打包态且自愈预算未用', () => {
    expect(canSelfHealRuntime(true, false)).toBe(true)
    expect(canSelfHealRuntime(false, false)).toBe(false)
    expect(canSelfHealRuntime(true, true)).toBe(false)
  })

  it('invalidateDshRuntime 删除版本目录（含标记与入口），且幂等', async () => {
    const dir = join(userDataDir, 'dsh-runtime', '0.0.2')
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, '.complete'), '{"size":1,"mtimeMs":1}\n')
    await invalidateDshRuntime({ userDataDir, version: '0.0.2' })
    expect(existsSync(dir)).toBe(false)
    // 目录本就不存在也不抛
    await expect(invalidateDshRuntime({ userDataDir, version: '0.0.2' })).resolves.toBeUndefined()
  })

  it('invalidateDshRuntime 拒绝非法版本号', async () => {
    await expect(invalidateDshRuntime({ userDataDir, version: '../escape' })).rejects.toThrow('非法版本号')
  })
})

describe('sweepOldRuntimes', () => {
  it('清掉旧版本与中断的临时目录，保留当前版本', async () => {
    const rootDir = join(userDataDir, 'dsh-runtime')
    await mkdir(join(rootDir, '0.0.0'), { recursive: true })
    await mkdir(join(rootDir, '.extract-0.0.0-1234'), { recursive: true })
    await sweepOldRuntimes(rootDir, VERSION)
    const entries = readdirSync(rootDir)
    expect(entries).toContain(VERSION)
    expect(entries).not.toContain('0.0.0')
    expect(entries).not.toContain('.extract-0.0.0-1234')
  })
})
