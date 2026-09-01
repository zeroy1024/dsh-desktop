import { describe, expect, it } from 'vitest'
import {
  clampFileTreeWidth, defaultFileBrowserLayout, effectiveFileTreeWidth, FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MAX_WIDTH, FILE_PREVIEW_MIN_WIDTH, FILE_TREE_MIN_WIDTH, fileBrowserLayoutKey,
  effectiveFileTreeHidden, fileTreeGeometry, fileTreeMaxWidthForAvailable, loadFileBrowserLayout,
  normalizeFileBrowserLayout, saveFileBrowserLayout,
} from '../src/client/layout.ts'

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('file-browser layout geometry', () => {
  it('keeps a 160px preview beside a 160–320px tree', () => {
    expect(FILE_TREE_MIN_WIDTH).toBe(160)
    expect(FILE_TREE_DEFAULT_WIDTH).toBe(200)
    expect(FILE_TREE_MAX_WIDTH).toBe(320)
    expect(FILE_PREVIEW_MIN_WIDTH).toBe(160)
  })

  it('clamps and rounds widths within the accessible splitter range', () => {
    expect(clampFileTreeWidth(Number.NaN)).toBe(FILE_TREE_DEFAULT_WIDTH)
    expect(clampFileTreeWidth(FILE_TREE_MIN_WIDTH - 1)).toBe(FILE_TREE_MIN_WIDTH)
    expect(clampFileTreeWidth(FILE_TREE_MAX_WIDTH + 1)).toBe(FILE_TREE_MAX_WIDTH)
    expect(clampFileTreeWidth(221.6)).toBe(222)
  })

  it('concedes rendered width without rewriting a wider preference', () => {
    expect(fileTreeMaxWidthForAvailable(600)).toBe(FILE_TREE_MAX_WIDTH)
    expect(fileTreeMaxWidthForAvailable(400)).toBe(240)
    expect(fileTreeMaxWidthForAvailable(320)).toBe(FILE_TREE_MIN_WIDTH)
    expect(effectiveFileTreeWidth(300, 400)).toBe(240)
    expect(effectiveFileTreeWidth(300, 600)).toBe(300)
  })

  it('exposes the same live range used for separator ARIA values', () => {
    expect(fileTreeGeometry(300, 400)).toEqual({ min: 160, max: 240, value: 240 })
    expect(fileTreeGeometry(300, 600)).toEqual({ min: 160, max: 320, value: 300 })
  })

  it('normalizes malformed values without accepting string coercion', () => {
    expect(normalizeFileBrowserLayout(null)).toEqual(defaultFileBrowserLayout)
    expect(normalizeFileBrowserLayout({ treeWidth: '320', treeHidden: 1 })).toEqual(defaultFileBrowserLayout)
    expect(normalizeFileBrowserLayout({ treeWidth: 999, treeHidden: true })).toEqual({
      treeWidth: FILE_TREE_MAX_WIDTH,
      treeHidden: true,
    })
  })
})

describe('file-browser layout persistence', () => {
  it('round-trips width and hidden state through the versioned key', () => {
    const storage = memoryStorage()
    const layout = { treeWidth: 312, treeHidden: true }
    saveFileBrowserLayout(storage, layout)
    expect(storage.getItem(fileBrowserLayoutKey)).toBe(JSON.stringify(layout))
    expect(loadFileBrowserLayout(storage)).toEqual(layout)
  })

  it('returns defaults for broken JSON and tolerates storage failures', () => {
    expect(loadFileBrowserLayout(memoryStorage({ [fileBrowserLayoutKey]: '{oops' })))
      .toEqual(defaultFileBrowserLayout)
    const failing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('quota') },
    }
    expect(loadFileBrowserLayout(failing)).toEqual(defaultFileBrowserLayout)
    expect(() => saveFileBrowserLayout(failing, defaultFileBrowserLayout)).not.toThrow()
  })

  it('keeps external-open hiding transient instead of changing the saved preference', () => {
    const visible = { treeWidth: 240, treeHidden: false }
    expect(effectiveFileTreeHidden(visible, true)).toBe(true)
    expect(visible.treeHidden).toBe(false)
    expect(effectiveFileTreeHidden(visible, false, true)).toBe(true)
    expect(effectiveFileTreeHidden(visible, false, false)).toBe(false)
  })
})
