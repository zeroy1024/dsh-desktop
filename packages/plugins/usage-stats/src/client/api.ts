/**
 * summary 路由的同源 fetch 封装（照 review 三段式：网络/HTTP/解析分层）。
 * 认证走首载 ready URL 换取的签名 Cookie，同源请求浏览器自动携带。
 */
import type { UsageSummary } from '../aggregator.ts'
import { USAGE_SUMMARY_PATH } from '../shared.ts'

export type UsageApiErrorKind = 'network' | 'forbidden' | 'internal'

export class UsageApiError extends Error {
  constructor(readonly kind: UsageApiErrorKind) {
    super(kind)
    this.name = 'UsageApiError'
  }
}

export interface SummaryResponse {
  ok: true
  generatedAt: number
  total: number
  scanned: number
  failed: number
  cached: number
  summary: UsageSummary
}

/** 只读 POST（同源 GET fetch 不带 Origin 头会被同源栅栏 403，与 node 半同一取舍）。 */
export async function fetchUsageSummary(signal?: AbortSignal): Promise<SummaryResponse> {
  let response: Response
  try {
    response = await fetch(USAGE_SUMMARY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new UsageApiError('network')
  }
  if (!response.ok) throw new UsageApiError(response.status === 403 ? 'forbidden' : 'internal')
  try {
    return await response.json() as SummaryResponse
  } catch {
    throw new UsageApiError('internal')
  }
}

/** 区分主动中止与真实网络错误（中止不进错误态）。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
