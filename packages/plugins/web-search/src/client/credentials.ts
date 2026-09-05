/** Adapt the 0.1.2 generated Remote face to the card's local form controller. */
import type { CredentialView, CredentialsApi } from './types.ts'

type Result<T> = { ok: true; value: T } | { ok: false }
export interface CredentialRemote {
  credentials: {
    describe(refs: string[]): Promise<Result<Record<string, CredentialView>>>
    set(ref: string, value: string): Promise<Result<void>>
  }
}

export function credentialAdapter(remote: CredentialRemote): CredentialsApi {
  return {
    async describe({ refs }) {
      const result = await remote.credentials.describe(refs)
      return { result: result.ok ? { ok: true, value: { credentials: result.value } } : { ok: false } }
    },
    async set({ ref, value }) {
      const result = await remote.credentials.set(ref, value)
      return { result: result.ok ? { ok: true, value: {} } : { ok: false } }
    },
  }
}
