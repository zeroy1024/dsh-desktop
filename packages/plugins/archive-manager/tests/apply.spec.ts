import { describe, expect, it, vi } from 'vitest'
import { ArchiveManagerSection } from '../src/client/ArchiveManagerSection.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { ClientContext } from '../src/client/types.ts'

describe('client plugin wiring', () => {
  it('registers the locale dictionaries and mounts the archive section', () => {
    const registerLocale = vi.fn(() => () => {})
    const bind = vi.fn(() => (key: string) => `zh:${key}`)
    let sectionKey: string | undefined
    let options: Record<string, unknown> | undefined
    let component: unknown
    const context: ClientContext = {
      effect: factory => factory(),
      locale: { register: registerLocale, bind },
      slots: {
        inject: (name, factory) => { sectionKey = name; return factory() },
        register: (next, entry) => {
          options = next as unknown as Record<string, unknown>
          component = entry
          return () => {}
        },
      },
    }

    apply(context)
    expect(inject).toEqual(['locale', 'slots'])
    expect(registerLocale).toHaveBeenCalledWith(
      'archive-manager',
      expect.objectContaining({ zh: expect.anything(), en: expect.anything() }),
    )
    expect(sectionKey).toBe('settings.section')
    expect(options).toMatchObject({
      name: 'settings.section',
      id: 'archive-manager',
      order: 90,
      locale: 'archive-manager',
    })
    // label 是 locale-following thunk：绑定本插件命名空间的 t。
    const label = options?.label as () => string
    expect(label()).toBe('zh:nav')
    expect(bind).toHaveBeenCalledWith('archive-manager')
    expect(component).toBe(ArchiveManagerSection)
  })
})
