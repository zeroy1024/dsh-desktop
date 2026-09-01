import { describe, expect, it } from 'vitest'
import { vendorLockContract } from '../verify-vendor-lock'

const lock = (localIntegrity: string, registryIntegrity = 'sha512-registry'): string => `
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
overrides:
  local: file:../local.tgz
importers:
  .:
    dependencies:
      local:
        specifier: file:../local.tgz
        version: file:../local.tgz(peer@1.0.0(abcdef))
      registry:
        specifier: 1.0.0
        version: 1.0.0
packages:
  local@file:../local.tgz:
    resolution: {integrity: ${localIntegrity}, tarball: file:../local.tgz}
  registry@1.0.0:
    resolution: {integrity: ${registryIntegrity}}
snapshots:
  local@file:../local.tgz(peer@1.0.0(0123456789abcdef0123456789abcdef)):
    dependencies:
      registry: 1.0.0
`

describe('vendorLockContract', () => {
  it('ignores local tarball integrity and derived peer snapshot hashes', () => {
    expect(vendorLockContract(lock('sha512-local-a')))
      .toEqual(vendorLockContract(
        lock('sha512-local-b').replaceAll(
          '0123456789abcdef0123456789abcdef',
          'fedcba9876543210fedcba9876543210',
        ),
      ))
  })

  it('retains registry integrity and importer specifiers', () => {
    expect(vendorLockContract(lock('sha512-local', 'sha512-registry-a')))
      .not.toEqual(vendorLockContract(lock('sha512-local', 'sha512-registry-b')))
    expect(vendorLockContract(lock('sha512-local')))
      .not.toEqual(vendorLockContract(lock('sha512-local').replace('specifier: 1.0.0', 'specifier: 2.0.0')))
    expect(vendorLockContract(lock('sha512-local')))
      .not.toEqual(vendorLockContract(lock('sha512-local').replace('registry: 1.0.0', 'registry: 2.0.0')))
  })
})
