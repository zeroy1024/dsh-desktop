import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../src/client-bundle'

const here = dirname(fileURLToPath(import.meta.url))
const upstreamPlatformSource = resolve(here, '../../../upstream/packages/client/web/src/platform.ts')

/** 提取 `export const NAME = [...]` 块内引号字符串的有序列表。 */
function extractSpecifiers(source: string, name: string): string[] {
  const start = source.indexOf(`export const ${name} = [`)
  if (start < 0) throw new Error(`upstream platform.ts 找不到 ${name} 声明`)
  const end = source.indexOf('] as const', start)
  if (end < 0) throw new Error(`upstream platform.ts 的 ${name} 声明未闭合`)
  const block = source.slice(start, end)
  const specifiers: string[] = []
  for (const match of block.matchAll(/'([^']+)'|"([^"]+)"/g)) {
    specifiers.push((match[1] ?? match[2]) as string)
  }
  return specifiers
}

/** 有序全等断言；漂移时抛出带修复指引的失败消息（保留 toEqual 的 diff）。 */
function expectMirror(ours: readonly string[], upstream: string[], table: string): void {
  try {
    expect(ours).toEqual(upstream)
  } catch (error) {
    throw new Error(
      `上游 platform.ts 已漂移，同步更新 client-bundle.ts 镜像（${table}）\n${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// 直读 upstream 工作树（仓内先例：vision/web-search 的视觉契约测试）。
// 本地未 sync upstream 时不挡测试，CI 在 sync 后跑。
const upstreamExists = existsSync(upstreamPlatformSource)
const describeMaybe = upstreamExists ? describe : describe.skip

describeMaybe('client-bundle 平台模块表与上游零漂移', () => {
  const upstream = readFileSync(upstreamPlatformSource, 'utf8')

  it('PLATFORM_MODULES 镜像与上游有序全等', () => {
    expectMirror(PLATFORM_MODULES, extractSpecifiers(upstream, 'PLATFORM_MODULES'), 'PLATFORM_MODULES')
  })

  it('PRELOADED_CLIENT_EXTERNALS 镜像与上游有序全等', () => {
    expectMirror(
      PRELOADED_CLIENT_EXTERNALS,
      extractSpecifiers(upstream, 'PRELOADED_CLIENT_EXTERNALS'),
      'PRELOADED_CLIENT_EXTERNALS',
    )
  })
})