/**
 * Compact one-level model selector: provider headings own indented model rows,
 * followed by a divider and an unlabeled-on-screen effort segmented control.
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from 'react'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ModelProviderGroup, ModelReasoning, ModelSelection, ModelSelectProps,
} from './types.ts'
import css from './ModelSelect.module.css'

interface ModelChoice {
  groupId: string
  model: {
    id: string
    name: string
    description?: string
    reasoning?: ModelReasoning
  }
}

interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

interface PendingEffort {
  effort: string | undefined
}

function sameModel(left: ModelSelection | null, right: ModelSelection): boolean {
  return left?.provider === right.provider && left.model === right.model
}

function selectionForChoice(current: ModelSelection | null, choice: ModelChoice): ModelSelection {
  const sameRoute = current?.provider === choice.groupId && current.model === choice.model.id
  const reasoningEffort = sameRoute
    ? current?.reasoningEffort ?? choice.model.reasoning?.defaultEffort
    : choice.model.reasoning?.defaultEffort
  return {
    provider: choice.groupId,
    model: choice.model.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function modelChoices(groups: readonly ModelProviderGroup[]): readonly ModelChoice[] {
  return groups.flatMap(group => group.models.map(model => ({ groupId: group.id, model })))
}

function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** Render the shadow occupant of `conversation.input.model`. */
export function ModelSelect({
  locked,
  available,
  load,
  select,
  getError,
  useModelDirectory,
  t,
}: ModelSelectProps) {
  const state = useModelDirectory(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [pendingEffort, setPendingEffort] = useState<PendingEffort | null>(null)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSequence = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const modelOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const effortOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectionPending = useRef(false)
  const id = useId()
  const lastAction = useRef<'load' | 'select'>('load')

  const choices = useMemo(() => modelChoices(state.groups), [state.groups])
  const choiceIndexes = useMemo(() => new Map(
    choices.map((choice, index) => [routeKey(choice.groupId, choice.model.id), index]),
  ), [choices])
  const currentChoice = choices.find(choice =>
    state.current?.provider === choice.groupId && state.current.model === choice.model.id)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const displayedEffort = pendingEffort === null ? effectiveEffort : pendingEffort.effort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => {
    if (reasoning === undefined) return []
    return [
      ...(reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : []),
      ...reasoning.efforts.map(effort => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
    ]
  }, [reasoning, t])
  const loading = state.status === 'loading'
  const selecting = state.status === 'selecting'
  const pending = loading || selecting
  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const effortLabel = reasoning === undefined
    ? undefined
    : displayedEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(effort => effort.id === displayedEffort)?.name ?? displayedEffort
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  const dismissToast = useCallback(() => { setToast(null) }, [])

  const announceSelectionError = (): void => {
    toastSequence.current += 1
    setToast({
      seq: toastSequence.current,
      text: t('error.action', { message: getError() ?? t('error.unknown') }),
    })
  }

  const reload = (): void => {
    lastAction.current = 'load'
    load()
  }

  useEffect(() => {
    if (available) reload()
  }, [available, load])

  useEffect(() => {
    if (!locked && available) return
    setOpen(false)
    setPendingEffort(null)
  }, [available, locked])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnOutsideFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOnOutsideFocus)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOnOutsideFocus)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const selected = rootRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    )
    ;(selected ?? modelOptionRefs.current.find(option => option !== null))?.focus()
  }, [open])

  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) window.setTimeout(() => { triggerRef.current?.focus() }, 0)
  }

  const show = (): void => {
    setOpen(true)
    reload()
  }

  const moveModelFocus = (offset: number): void => {
    const options = modelOptionRefs.current.filter(option => option !== null)
    if (options.length === 0) return
    const active = options.findIndex(option => option === document.activeElement)
    const next = active === -1
      ? offset > 0 ? 0 : options.length - 1
      : (active + offset + options.length) % options.length
    options[next]?.focus()
  }

  const onModelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveModelFocus(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key !== 'Home' && event.key !== 'End') return
    const options = modelOptionRefs.current.filter(option => option !== null)
    if (options.length === 0) return
    event.preventDefault()
    const target = event.key === 'Home' ? options[0] : options.at(-1)
    target?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || event.key !== 'Escape') return
    event.preventDefault()
    close(true)
  }

  const onEffortKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (selecting || selectionPending.current) return
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (!forward && !backward && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const targetIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? effortChoices.length - 1
        : forward
          ? (index + 1) % effortChoices.length
          : (index - 1 + effortChoices.length) % effortChoices.length
    const target = effortOptionRefs.current[targetIndex]
    target?.focus()
    target?.click()
  }

  const submitSelection = (
    selection: ModelSelection,
    closeOnSuccess = false,
    onSettled?: () => void,
  ): void => {
    if (selecting || selectionPending.current) return
    selectionPending.current = true
    lastAction.current = 'select'
    void select(selection)
      .then((accepted) => {
        if (!accepted) announceSelectionError()
        else if (closeOnSuccess) close(true)
      })
      .catch(announceSelectionError)
      .finally(() => {
        selectionPending.current = false
        onSettled?.()
      })
  }

  const chooseModel = (choice: ModelChoice): void => {
    if (selecting || selectionPending.current) return
    const selection = selectionForChoice(state.current, choice)
    if (sameModel(state.current, selection)) {
      close(true)
      return
    }
    submitSelection(selection, true)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (selecting || selectionPending.current || state.current === null || effectiveEffort === effort) return
    setPendingEffort({ effort })
    submitSelection({
      provider: state.current.provider,
      model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }, false, () => { setPendingEffort(null) })
  }

  if (!available) return null

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => { if (open) close(false); else show() }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="dialog"
          aria-label={t('menu.aria')}
          aria-busy={pending}
        >
          {pending && (
            <span className={css.srOnly} role="status">
              {selecting ? t('status.selecting') : t('status.loading')}
            </span>
          )}
          {lastAction.current === 'load' && state.error !== null && (
            <div className={css.inlineError} role="alert">
              <span>{t('error.action', { message: state.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
            </div>
          )}
          {state.status === 'loading' && choices.length === 0 && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
            </div>
          ))}

          <div
            className={`${css.groups} scrollable`}
            role="menu"
            aria-label={t('menu.model')}
            aria-busy={selecting}
            onKeyDown={onModelKeyDown}
          >
            {state.groups.map(group => (
              <section role="group" aria-label={group.name} className={css.group} key={group.id}>
                <div className={css.groupTitle}>{group.name}</div>
                {group.models.map(model => {
                  const selected = state.current?.provider === group.id && state.current.model === model.id
                  const choice: ModelChoice = { groupId: group.id, model }
                  return (
                    <button
                      ref={(node) => {
                        const index = choiceIndexes.get(routeKey(group.id, model.id))
                        if (index !== undefined) modelOptionRefs.current[index] = node
                      }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`${css.option} ${selected ? css.optionSelected : ''}`}
                      key={model.id}
                      title={model.description === undefined ? model.name : `${model.name} — ${model.description}`}
                      aria-disabled={selecting}
                      onClick={() => { chooseModel(choice) }}
                    >
                      <span className={css.check} aria-hidden="true">
                        {selected ? <IconCheckOutline16 /> : null}
                      </span>
                      <span className={css.modelName}>{model.name}</span>
                    </button>
                  )
                })}
              </section>
            ))}
          </div>
          {state.status === 'ready' && choices.length === 0 && (
            <div className={css.empty}>{t('empty.models')}</div>
          )}

          {reasoning !== undefined && (
            <>
              <div className={css.separator} role="separator" />
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : (
                  <div
                    className={css.effortSegments}
                    role="radiogroup"
                    aria-label={t('menu.effort')}
                    aria-busy={selecting}
                  >
                    {effortChoices.map((choice, index) => {
                      const selected = displayedEffort === choice.effort
                      const tabIndex = selected ? 0 : index === 0 && !effortChoices.some(
                        candidate => candidate.effort === displayedEffort,
                      ) ? 0 : -1
                      return (
                        <button
                          ref={(node) => { effortOptionRefs.current[index] = node }}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={choice.label}
                          tabIndex={tabIndex}
                          className={`${css.effortChoice} ${selected ? css.effortChoiceSelected : ''}`}
                          key={choice.key}
                          title={choice.description}
                          disabled={locked}
                          aria-disabled={selecting}
                          onKeyDown={(event) => { onEffortKeyDown(event, index) }}
                          onClick={() => { chooseEffort(choice.effort) }}
                        >
                          <span>{choice.label}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
            </>
          )}
        </div>
      )}

      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={dismissToast}
        />
      )}
    </div>
  )
}
