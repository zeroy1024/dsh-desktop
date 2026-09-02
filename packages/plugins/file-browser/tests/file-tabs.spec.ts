/**
 * 文件 tab 账本与持久化纯函数测（含 relPathsUnderRoot 的路径两态收敛）。
 */
import { describe, expect, it } from 'vitest'
import {
  activateFile, closeFile, emptyFileTabs, fileTabsKey, loadFileTabs,
  openFile, relPathsUnderRoot, saveFileTabs,
} from '../src/client/file-tabs.ts'

/** 内存 Storage 替身（只实现用到的两面）。 */
function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('账本操作', () => {
  it('openFile：新文件入尾并激活；重复打开只挪激活位', () => {
    let state = openFile(emptyFileTabs, 'a.md')
    state = openFile(state, 'b.ts')
    expect(state).toEqual({ openPaths: ['a.md', 'b.ts'], activePath: 'b.ts' })
    state = openFile(state, 'a.md')
    expect(state.openPaths).toEqual(['a.md', 'b.ts'])
    expect(state.activePath).toBe('a.md')
  })

  it('closeFile：激活位回落右邻，末尾回落左邻，全空回 null', () => {
    const three = { openPaths: ['a', 'b', 'c'], activePath: 'b' }
    expect(closeFile(three, 'b')).toEqual({ openPaths: ['a', 'c'], activePath: 'c' })
    expect(closeFile(three, 'c')).toMatchObject({ activePath: 'b' })
    expect(closeFile({ openPaths: ['only'], activePath: 'only' }, 'only'))
      .toEqual({ openPaths: [], activePath: null })
  })

  it('activateFile 只认账本内路径', () => {
    expect(activateFile(emptyFileTabs, 'ghost').activePath).toBeNull()
  })

  it('外部绝对路径 key 与工作区 relPath 混存互不干扰', () => {
    let state = openFile(emptyFileTabs, 'src/app.ts')
    state = openFile(state, '/Users/z/.dsh/settings.yaml')
    expect(state.openPaths).toEqual(['src/app.ts', '/Users/z/.dsh/settings.yaml'])
    expect(state.activePath).toBe('/Users/z/.dsh/settings.yaml')
    // 同名文件名不同域不算重复：relPath `settings.yaml` 与外部键并存。
    state = openFile(state, 'settings.yaml')
    expect(state.openPaths).toHaveLength(3)
    // 关闭外部 tab 后激活位回落仍正常。
    state = closeFile(state, '/Users/z/.dsh/settings.yaml')
    expect(state.activePath).toBe('settings.yaml')
  })

  it('v1 持久化数据（纯 relPath）天然兼容', () => {
    const restored = loadFileTabs(
      memoryStorage({ [fileTabsKey('s')]: '{"openPaths":["a.md","b.ts"],"activePath":"a.md"}' }),
      's',
    )
    expect(restored).toEqual({ openPaths: ['a.md', 'b.ts'], activePath: 'a.md' })
  })
})

describe('持久化', () => {
  it('save → load 往返', () => {
    const storage = memoryStorage()
    const state = openFile(openFile(emptyFileTabs, 'x.ts'), 'y.ts')
    saveFileTabs(storage, 'sess', state)
    expect(loadFileTabs(storage, 'sess')).toEqual(state)
  })

  it('坏 JSON / 形状漂移 / activePath 越界都回安全值', () => {
    expect(loadFileTabs(memoryStorage({ [fileTabsKey('s')]: '{oops' }), 's')).toEqual(emptyFileTabs)
    expect(loadFileTabs(memoryStorage({ [fileTabsKey('s')]: '{"openPaths":"x"}' }), 's')).toEqual(emptyFileTabs)
    expect(loadFileTabs(memoryStorage({ [fileTabsKey('s')]: '{"openPaths":["a"],"activePath":"z"}' }), 's'))
      .toEqual({ openPaths: ['a'], activePath: null })
  })

  it('按会话分键', () => {
    const storage = memoryStorage()
    saveFileTabs(storage, 's1', openFile(emptyFileTabs, 'a'))
    expect(loadFileTabs(storage, 's2')).toEqual(emptyFileTabs)
  })
})

describe('relPathsUnderRoot', () => {
  it('绝对路径按 root 前缀剥；root 外丢弃', () => {
    expect(relPathsUnderRoot('/repo', ['/repo/a/b.ts', '/etc/passwd']))
      .toEqual(['a/b.ts'])
  })

  it('相对形态直通；../ 与绝对但 root 外丢弃', () => {
    expect(relPathsUnderRoot('/repo', ['src/x.ts', '../out.ts', '/other/f']))
      .toEqual(['src/x.ts'])
  })
})
