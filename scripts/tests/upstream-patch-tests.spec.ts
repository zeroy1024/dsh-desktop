import { describe, expect, it } from 'vitest'
import { patchedTestPaths } from '../test-upstream-patches'

describe('patchedTestPaths', () => {
  it('collects and sorts existing, new, and renamed test destinations', () => {
    const patch = [
      'diff --git a/packages/demo/tests/z.client.spec.tsx b/packages/demo/tests/z.client.spec.tsx',
      'diff --git a/packages/demo/src/index.ts b/packages/demo/src/index.ts',
      'diff --git a/packages/demo/tests/a.test.mts b/packages/demo/tests/a.test.mts',
      'diff --git a/old/tests/renamed.spec.ts b/new/tests/renamed.spec.ts',
      'similarity index 98%',
      'rename from old/tests/renamed.spec.ts',
      'rename to new/tests/renamed.spec.ts',
      'diff --git a/packages/demo/tests/new.spec.ts b/packages/demo/tests/new.spec.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/packages/demo/tests/new.spec.ts',
      'diff --git a/packages/demo/tests/deleted.spec.ts b/packages/demo/tests/deleted.spec.ts',
      '--- a/packages/demo/tests/deleted.spec.ts',
      '+++ /dev/null',
      'diff --git a/packages/demo/tests/z.client.spec.tsx b/packages/demo/tests/z.client.spec.tsx',
    ].join('\n')

    expect(patchedTestPaths(patch)).toEqual([
      'new/tests/renamed.spec.ts',
      'packages/demo/tests/a.test.mts',
      'packages/demo/tests/new.spec.ts',
      'packages/demo/tests/z.client.spec.tsx',
    ])
  })

  it('rejects fixtures and source files outside tests directories', () => {
    expect(patchedTestPaths([
      'diff --git a/packages/demo/fixtures/sample.spec.ts b/packages/demo/fixtures/sample.spec.ts',
      'diff --git a/packages/demo/src/example.test.ts b/packages/demo/src/example.test.ts',
    ].join('\n'))).toEqual([])
  })
})
