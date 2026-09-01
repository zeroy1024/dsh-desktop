import { describe, expect, it } from 'vitest'
import { pnpmInvocation } from '../command'

describe('pnpmInvocation', () => {
  it('uses npm_execpath through the current Node executable', () => {
    expect(pnpmInvocation({
      env: { npm_execpath: '/tmp/pnpm entry.cjs' },
      execPath: '/opt/node/bin/node',
      platform: 'win32',
    })).toEqual({
      command: '/opt/node/bin/node',
      args: ['/tmp/pnpm entry.cjs'],
    })
  })

  it('recognizes uppercase JavaScript entry extensions', () => {
    expect(pnpmInvocation({
      env: { npm_execpath: 'C:\\pnpm.CJS' },
      execPath: 'C:\\node.exe',
      platform: 'win32',
    })).toEqual({ command: 'C:\\node.exe', args: ['C:\\pnpm.CJS'] })
  })

  it('rejects Windows command shims that require a shell', () => {
    expect(() => pnpmInvocation({
      env: { npm_execpath: 'C:\\pnpm.cmd' },
      platform: 'win32',
    })).toThrow(/\.cmd\/\.bat.*shell:false/u)
  })

  it('invokes a command-style npm_execpath directly', () => {
    expect(pnpmInvocation({
      env: { npm_execpath: 'pnpm' },
      execPath: '/opt/node/bin/node',
      platform: 'win32',
    })).toEqual({
      command: 'pnpm',
      args: [],
    })
  })

  it('rejects an unsafe shell fallback outside a lifecycle on Windows', () => {
    expect(() => pnpmInvocation({ env: {}, platform: 'win32' }))
      .toThrow(/Windows.*pnpm run.*npm_execpath/u)
  })

  it('uses pnpm outside a package-manager lifecycle on POSIX', () => {
    expect(pnpmInvocation({ env: {}, platform: 'darwin' })).toEqual({
      command: 'pnpm',
      args: [],
    })
  })

  it('treats whitespace-only npm_execpath as unset', () => {
    expect(pnpmInvocation({ env: { npm_execpath: '  ' }, platform: 'linux' })).toEqual({
      command: 'pnpm',
      args: [],
    })
  })
})
