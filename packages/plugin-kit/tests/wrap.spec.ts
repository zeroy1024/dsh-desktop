import { describe, expect, it } from 'vitest'
import { wrapClientFactory } from '../src/client-bundle'

describe('wrapClientFactory', () => {
  it('包进 ModuleLoader 工厂并返回 module.exports', () => {
    const wrapped = wrapClientFactory('@dsh-desktop/hello-panel', 'exports.apply = function apply() {}')
    expect(wrapped).toContain('window.__ModuleLoader__.load({ id: "@dsh-desktop/hello-panel"')
    expect(wrapped).toContain('factory: (require) => {')
    expect(wrapped).toContain('return module.exports; } });')
    const stripped = wrapClientFactory('@dsh-desktop/hello-panel', 'exports.x = 1\n//# sourceMappingURL=client.js.map\n')
    expect(stripped).not.toContain('sourceMappingURL')
  })
})
