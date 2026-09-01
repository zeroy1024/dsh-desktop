import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(here, '../src/client')
const upstreamDir = resolve(here, '../../../../upstream/packages/client/ui-settings-plugins/src/client')

function source(name: string): string {
  return readFileSync(resolve(clientDir, name), 'utf8')
}

function upstream(name: string): string {
  return readFileSync(resolve(upstreamDir, name), 'utf8')
}

function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`CSS selector not found: ${selector}`)
  const end = css.indexOf('\n}', start)
  if (end < 0) throw new Error(`CSS rule is not closed: ${selector}`)
  return css.slice(start, end + 2)
}

describe('web-search settings card visual contract', () => {
  it('keeps the stock PluginCard shell geometry and states', () => {
    const css = source('PluginCard.module.css')

    expect(css).toBe(upstream('PluginCard.module.css'))
    expect(source('PluginCard.tsx')).toContain('IconChevronDownOutline14')
  })

  it('keeps stock field spacing, typography, controls, and secret markup', () => {
    const css = source('fields.module.css')
    const stockCss = upstream('fields.module.css')
    const fields = source('fields.tsx')

    for (const selector of [
      '.field', '.field + .field', '.head', '.label', '.badges', '.badge', '.badgeMuted',
      '.reset', '.reset:hover:not(:disabled)', '.reset:disabled', '.input', '.input:focus-visible',
      '.input:disabled', '.inputInvalid', '.invalid', '.hint',
    ]) {
      expect(css).toContain(cssRule(stockCss, selector))
    }
    expect(fields).toContain('<div className={css.head}>')
    expect(fields).toContain('<span className={css.badges}>')
    expect(fields).toContain('css.selectInvalid : css.select')
    expect(fields).toContain('type="password"')
    expect(fields).toContain('autoComplete="off"')
  })

  it('uses the stock shell and field components instead of a private card stylesheet', () => {
    const card = source('WebSearchCard.tsx')

    expect(card).toContain("from './PluginCard.tsx'")
    expect(card).toContain("from './fields.tsx'")
    expect(card).not.toContain('WebSearchCard.module.css')
    expect(card).not.toContain("'⌄'")
    expect(card).not.toContain("'⌃'")
  })

  it('keeps the credential slot internal and exposes only one API key control', () => {
    const card = source('WebSearchCard.tsx')
    const controller = source('controller.ts')
    const locale = source('locales.ts')

    expect(card).not.toContain('plugin-config-web-search-credential-ref')
    expect(card).not.toContain('state.apiKeyEnv')
    expect(controller).not.toContain('apiKeyEnv: CardFieldState')
    expect(controller).not.toContain("this.form.field('apiKeyEnv')")
    expect(controller).not.toContain("predicateTextField('apiKeyEnv'")
    expect(controller).toContain('DSH_WEB_SEARCH_API_KEY')
    expect(controller).toContain('DEEPSEEK_API_KEY')
    expect(locale).not.toContain('apiKeyEnv')
  })
})
