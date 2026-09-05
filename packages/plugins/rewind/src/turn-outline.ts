/** Desktop replacement for the native turn outline, retaining rewind-aware previews. */
import { z } from 'zod'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
import { REWIND_EVENT_TYPE } from './shared.ts'

type Entry = TurnOutlineEntry
interface Position { prompt: number | null; promptPreview: number | null; response: number | null }
interface State {
  turns: readonly Entry[]
  positions: readonly Position[]
  draft: string
  draftSeq: number | null
}

// Preserve the native preview limits and truncation rules, so loaded and
// unloaded navigation cards show the same text.
function preview(content: readonly { type: string; text?: string }[], limit: number): string {
  let text = ''
  let unread = false
  for (const block of content) {
    if (block.type !== 'text' || block.text === undefined) continue
    if (text.length >= limit * 2) { unread = true; break }
    const clipped = block.text.length > limit * 2
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) { unread = true; break }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

const seq = z.number().int().nonnegative()
const entriesSchema: z.ZodType<readonly Entry[]> = z.array(z.object({
  turn: seq,
  seq: seq.transform(SessionSeq),
  prompt: z.string().max(50),
  response: z.string().max(120),
}).strict()).superRefine((turns, context) => {
  if (turns.some((entry, index) => index > 0 && entry.turn <= turns[index - 1]!.turn)) {
    context.addIssue({ code: 'custom', message: 'turn outline must advance in turn order' })
  }
})
const stateSchema: z.ZodType<State> = z.object({
  turns: entriesSchema,
  positions: z.array(z.object({ prompt: seq.nullable(), promptPreview: seq.nullable(), response: seq.nullable() }).strict()),
  draft: z.string().max(120),
  draftSeq: seq.nullable(),
}).strict().superRefine((state, context) => {
  if (state.turns.length !== state.positions.length) {
    context.addIssue({ code: 'custom', message: 'turn outline position count mismatch' })
  }
})

/** Replace the native unit via cordis.patch.yml; never register both owners. */
export const rewindTurnOutlineProjection = {
  key: 'turnOutline' as const,
  // Different persisted schema from native v2, so its cached previews cannot seed us.
  stateVersion: 1001,
  stateSchema,
  init: (): State => ({ turns: [], positions: [], draft: '', draftSeq: null }),
  apply(state: State, event: SessionEvent): State {
    if (event.type === REWIND_EVENT_TYPE) {
      const atSeq = (event.data as { atSeq?: unknown } | undefined)?.atSeq
      if (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0 || atSeq > event.seq) return state
      const turns: Entry[] = []
      const positions: Position[] = []
      for (const [index, turn] of state.turns.entries()) {
        const position = state.positions[index]!
        // A turn starts before its user prompt. Dropping by turn/start alone
        // would leave the withdrawn first prompt in the navigation rail.
        if (turn.seq >= atSeq || (position.prompt !== null && position.prompt >= atSeq)) continue
        const keepResponse = position.response === null || position.response < atSeq
        const keepPrompt = position.promptPreview === null || position.promptPreview < atSeq
        turns.push(keepPrompt && keepResponse ? turn : { ...turn, prompt: keepPrompt ? turn.prompt : '', response: keepResponse ? turn.response : '' })
        positions.push({ ...position, promptPreview: keepPrompt ? position.promptPreview : null, response: keepResponse ? position.response : null })
      }
      return { turns, positions, draft: '', draftSeq: null }
    }
    switch (event.type) {
      case 'turn/start': {
        if ((state.turns.at(-1)?.turn ?? -1) >= event.data.turn) return state
        return {
          turns: [...state.turns, { turn: event.data.turn, seq: event.seq, prompt: '', response: '' }],
          positions: [...state.positions, { prompt: null, promptPreview: null, response: null }],
          draft: '', draftSeq: null,
        }
      }
      case 'user/message': {
        const last = state.turns.at(-1)
        if (event.data.source.kind !== 'user' || last === undefined || last.prompt !== '') return state
        const prompt = preview(event.data.content, 50)
        const position = state.positions.at(-1)!
        if (prompt === '' && position.prompt !== null) return state
        return {
          ...state,
          turns: prompt === '' ? state.turns : [...state.turns.slice(0, -1), { ...last, prompt }],
          // Even an image-only or blank human message owns the turn boundary.
          // A later steering message may provide its first textual preview.
          positions: [...state.positions.slice(0, -1), { ...position, prompt: position.prompt ?? event.seq, promptPreview: prompt === '' ? null : event.seq }],
        }
      }
      case 'assistant/message': {
        const draft = preview(event.data.message.content, 120)
        if (draft === '') return state
        return { ...state, draft, draftSeq: event.seq }
      }
      case 'turn/end': {
        const last = state.turns.at(-1)
        if (state.draft === '') return state
        if (last === undefined) return { ...state, draft: '', draftSeq: null }
        return {
          turns: last.response === state.draft ? state.turns : [...state.turns.slice(0, -1), { ...last, response: state.draft }],
          positions: [...state.positions.slice(0, -1), { ...state.positions.at(-1)!, response: state.draftSeq }],
          draft: '', draftSeq: null,
        }
      }
      default: return state
    }
  },
  wire: { viewSchema: entriesSchema, view: (state: State): readonly Entry[] => state.turns },
} satisfies ProjectionDefinition<'turnOutline', State>
