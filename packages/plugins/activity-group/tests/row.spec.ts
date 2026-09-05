import { expect, it, vi } from 'vitest'
vi.mock('react', () => ({
  useMemo: (fn: () => unknown) => fn(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}))
vi.mock('react/jsx-dev-runtime', () => ({ jsxDEV: (type: unknown, props: unknown) => ({ type, props }) }))
vi.mock('react/jsx-runtime', () => ({ jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: 'disclosure', IconApiOutline14: 'api', IconChecklistOutline14: 'check', IconThinkOutline14: 'think',
}))
import { ActivityGroupRow } from '../src/client/ActivityGroupRow.tsx'
import type { ChatNode } from '../src/client/types.ts'

it('reads keyed chat nodes from useChat, independently of the Session control snapshot', () => {
  const node = { key: 'user:1', kind: 'user', data: { seq: 1 } } as ChatNode
  const renderMember = vi.fn(() => null)
  ActivityGroupRow({
    nodes: [node], renderMember,
    useSession: selector => selector({ running: false }),
    useChat: selector => selector({ order: [node.key], nodes: new Map([[node.key, node]]) }),
    t: key => key,
  })
  expect(renderMember).toHaveBeenCalledWith(node.key)
})
