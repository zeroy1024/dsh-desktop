// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import type {
  ModelDirectoryState, ModelSelection, ModelSelectProps, Translate,
} from '../src/client/types.ts'

const t: Translate = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (match, name: string) => (
        name in params ? String(params[name]) : match
      ))
}

const DEEPSEEK_REASONING = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: DEEPSEEK_REASONING,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

interface HarnessProps {
  initial?: ModelDirectoryState
  available?: boolean
  locked?: boolean
  load?: () => void
  onSelect?: (selection: ModelSelection) => Promise<boolean>
  failureMessage?: string
}

const NOOP_LOAD = (): void => {}

function Harness({
  initial = state(),
  available = true,
  locked = false,
  load = NOOP_LOAD,
  onSelect = () => Promise.resolve(true),
  failureMessage = 'model-unavailable: rejected',
}: HarnessProps): ReactElement {
  const [snapshot, setSnapshot] = useState(initial)
  const useModelDirectory: ModelSelectProps['useModelDirectory'] = selector => selector(snapshot)
  const select = async (selection: ModelSelection): Promise<boolean> => {
    setSnapshot(previous => ({ ...previous, status: 'selecting', error: null }))
    const accepted = await onSelect(selection)
    setSnapshot(previous => accepted
      ? { ...previous, current: selection, status: 'ready', error: null }
      : { ...previous, status: 'error', error: failureMessage })
    return accepted
  }
  return (
    <ModelSelect
      locked={locked}
      available={available}
      load={load}
      select={select}
      getError={() => failureMessage}
      useModelDirectory={useModelDirectory}
      t={t}
    />
  )
}

afterEach(cleanup)

function openDialog(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /选择模型/ })
  fireEvent.click(trigger)
  return screen.getByRole('dialog', { name: '模型与推理等级' })
}

describe('direct reasoning selection', () => {
  it('renders adapter-owned efforts and switches directly without closing the dialog', async () => {
    const onSelect = vi.fn().mockResolvedValue(true)
    render(<Harness onSelect={onSelect} />)

    const dialog = openDialog()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Flash' }).getAttribute('aria-checked'))
      .toBe('true')
    expect(screen.getAllByRole('radio').map(radio => radio.getAttribute('aria-label')))
      .toEqual(['Off', 'Low', 'High', 'Max'])
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Flash' }))
    })

    fireEvent.click(screen.getByText('Max', { selector: 'span' }))
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(screen.getByRole('radio', { name: 'Max' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(dialog.isConnected).toBe(true)
    expect(screen.getByRole('dialog', { name: '模型与推理等级' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Max' }).getAttribute('title')).toBe('Largest budget')
  })

  it('offers provider default only without an adapter default and omits the wire field', async () => {
    const onSelect = vi.fn().mockResolvedValue(true)
    render(<Harness
      initial={state({
        current: { provider: 'provider', model: 'model', reasoningEffort: 'standard' },
        groups: [{
          id: 'provider',
          name: 'Provider',
          models: [{
            id: 'model',
            name: 'Model',
            reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
          }],
        }],
      })}
      onSelect={onSelect}
    />)

    openDialog()
    expect(screen.getAllByRole('radio').map(radio => radio.getAttribute('aria-label')))
      .toEqual(['Default', 'Standard'])
    fireEvent.click(screen.getByRole('radio', { name: 'Default' }))
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({ provider: 'provider', model: 'model' })
    })
  })

  it('omits the effort group for non-reasoning and stale catalog selections', () => {
    const first = render(<Harness initial={state({
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      }],
    })} />)
    openDialog()
    expect(screen.queryByRole('radiogroup', { name: '推理等级' })).toBeNull()

    first.unmount()
    render(<Harness initial={state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    })} />)
    const trigger = screen.getByRole('button', { name: '选择模型' })
    fireEvent.click(trigger)
    expect(screen.queryByRole('radiogroup', { name: '推理等级' })).toBeNull()
    expect(screen.queryByText('removed-model')).toBeNull()
  })

  it('closes after selecting a model and exposes its effort set on the next open', async () => {
    const onSelect = vi.fn().mockResolvedValue(true)
    render(<Harness
      initial={state({
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: DEEPSEEK_REASONING },
            {
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro',
              reasoning: {
                efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }],
                defaultEffort: 'max',
              },
            },
          ],
        }],
      })}
      onSelect={onSelect}
    />)

    openDialog()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }))
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    openDialog()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Pro' }).getAttribute('aria-checked'))
      .toBe('true')
    expect(screen.getAllByRole('radio').map(radio => radio.getAttribute('aria-label')))
      .toEqual(['Off', 'Max'])
  })

  it('also closes when the current model is selected again', async () => {
    render(<Harness />)
    openDialog()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek V4 Flash' }))

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('keeps the previous selection and reports a rejected effort through an alert', async () => {
    render(<Harness onSelect={vi.fn().mockResolvedValue(false)} />)
    openDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Max' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('model-unavailable: rejected')
    expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('dialog', { name: '模型与推理等级' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('disables the whole chooser while one selection is pending', async () => {
    let resolveSelection!: (accepted: boolean) => void
    const onSelect = vi.fn(() => new Promise<boolean>((resolve) => { resolveSelection = resolve }))
    render(<Harness onSelect={onSelect} />)
    const dialog = openDialog()
    const max = screen.getByRole('radio', { name: 'Max' })
    max.focus()
    fireEvent.click(max)

    await waitFor(() => {
      expect(dialog.getAttribute('aria-busy')).toBe('true')
      expect((max as HTMLButtonElement).disabled).toBe(false)
      expect(max.getAttribute('aria-disabled')).toBe('true')
      expect(max.getAttribute('aria-checked')).toBe('true')
      expect(document.activeElement).toBe(max)
    })
    fireEvent.click(max)
    expect(onSelect).toHaveBeenCalledTimes(1)

    await act(async () => { resolveSelection(true); await Promise.resolve() })
    await waitFor(() => {
      expect(dialog.getAttribute('aria-busy')).toBe('false')
      expect(max.getAttribute('aria-disabled')).toBe('false')
      expect(document.activeElement).toBe(max)
    })
  })

  it('keeps last-known efforts interactive while the directory refreshes in the background', async () => {
    const onSelect = vi.fn().mockResolvedValue(true)
    render(<Harness initial={state({ status: 'loading' })} onSelect={onSelect} />)
    const dialog = openDialog()
    const max = screen.getByRole('radio', { name: 'Max' }) as HTMLButtonElement

    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(max.disabled).toBe(false)
    expect(max.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(max)
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
    })
  })
})

describe('availability and keyboard contract', () => {
  it('does not mount an addressed-subagent control and never loads it', () => {
    const load = vi.fn()
    render(<Harness available={false} load={load} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('keeps a locked trigger inert', () => {
    render(<Harness locked />)
    const trigger = screen.getByRole('button', { name: /选择模型/ }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('exposes dialog relationships and restores trigger focus on Escape', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    const dialog = openDialog()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)
    expect(screen.getByRole('radiogroup', { name: '推理等级' })).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })
})
