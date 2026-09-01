import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const local = (name: string): string => readFileSync(resolve(here, '../src/client', name), 'utf8')
const upstream = (name: string): string => readFileSync(
  resolve(here, '../../../../upstream/packages/client/ui-settings-plugins/src/client', name),
  'utf8',
)

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`CSS selector not found: ${selector}`)
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error(`CSS rule is not closed: ${selector}`)
  return source.slice(start, end + 2)
}

describe('vision settings card visual contract', () => {
  it('keeps the card chrome byte-for-byte aligned with dsh', () => {
    expect(local('PluginCard.module.css')).toBe(upstream('PluginCard.module.css'))
  })

  it('keeps every shared field metric and token aligned with dsh', () => {
    const localFields = local('fields.module.css')
    const upstreamFields = upstream('fields.module.css')
    for (const selector of [
      '.field', '.field + .field', '.head', '.label', '.badges', '.badge', '.badgeMuted',
      '.reset', '.reset:hover:not(:disabled)', '.reset:disabled', '.input', '.input:focus-visible',
      '.input:disabled', '.inputInvalid', '.invalid', '.hint',
    ]) {
      expect(localFields).toContain(cssRule(upstreamFields, selector))
    }
  })

  it('uses the official icon and card/field DOM seams', () => {
    const card = local('PluginCard.tsx')
    const fields = local('fields.tsx')
    const vision = local('VisionCard.tsx')
    expect(card).toContain("@deepseek-ai/dsh-client-ui-primitives")
    expect(card).toContain('<IconChevronDownOutline14 className=')
    expect(card).toContain('className={css.discard}')
    expect(card).toContain('className={css.save}')
    expect(card).not.toContain('VisionCard.module.css')
    expect(fields).toContain("import css from './fields.module.css'")
    expect(fields).toContain('<input')
    expect(fields).toContain('<select')
    expect(fields).not.toContain('css.badges}>\n          <span className={props.configured')
    expect(vision).not.toContain('className={css.advanced}')
  })

  it('matches models by Host-reported capabilities instead of model-name rules', () => {
    const controller = local('vision-card-controller.ts')
    const locale = local('locales.ts')
    const vision = local('VisionCard.tsx')

    expect(vision).not.toContain('targetProvider')
    expect(vision).not.toContain('families')
    expect(vision).not.toContain('models')
    expect(controller).not.toContain('targetProvider')
    expect(controller).not.toContain('families')
    expect(controller).not.toContain('models')
    expect(controller).not.toContain("apiKeyEnv: CardFieldState")
    expect(controller).not.toContain("this.form.field('apiKeyEnv')")
    expect(controller).not.toContain("textField('apiKeyEnv')")

    expect(controller).toContain("unknownCapabilityPolicy")
    expect(controller).toContain("['passthrough', 'bridge']")
    expect(vision).toContain('plugin-config-vision-unknown-capability-policy')
    expect(vision).toContain("value: 'passthrough'")
    expect(vision).toContain("value: 'bridge'")
    expect(vision).not.toContain('plugin-config-vision-credential-ref')
    expect(vision).not.toContain('state.apiKeyEnv')
    expect(locale).toContain('unknownCapabilityPolicy')
    expect(locale).not.toContain('apiKeyEnv')
    expect(locale).not.toContain('targetProvider')
    expect(locale).not.toContain('familiesHint')
    expect(locale).not.toContain('modelsHint')
  })
})
