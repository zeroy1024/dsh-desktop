/**
 * Hand-written controls that follow the DOM and spacing contract of the
 * upstream ui-settings-plugins fields.  They stage text only; the card owns
 * the save boundary.
 */

import type { ChangeEvent } from 'react'
import type { CardFieldState } from './card-form.ts'
import css from './fields.module.css'

export interface FieldProps extends CardFieldState {
  id: string
  label: string
  hint: string
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}

function resetBadge(props: Pick<FieldProps, 'overridden' | 'overriddenLabel' | 'resetLabel' | 'disabled' | 'onReset'>) {
  if (!props.overridden) return null
  return (
    <span className={css.badges}>
      <span className={css.badge}>{props.overriddenLabel}</span>
      <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
        {props.resetLabel}
      </button>
    </span>
  )
}

/** Text field with the upstream ValueField DOM shape. */
export function ValueField(props: FieldProps & { numeric?: boolean; placeholder?: string }) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {resetBadge(props)}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** Enum field using the same control geometry as an upstream ValueField. */
export function SelectField(props: FieldProps & {
  options: readonly { value: string; label: string }[]
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {resetBadge(props)}
      </div>
      <select
        id={props.id}
        className={props.invalid ? css.selectInvalid : css.select}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => { props.onEdit(event.target.value) }}
      >
        {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** Boolean field with the same label, hint, badge, and reset treatment. */
export function CheckboxField(props: FieldProps) {
  return (
    <div className={css.field}>
      <div className={css.checkboxRow}>
        <input
          id={props.id}
          className={css.checkbox}
          type="checkbox"
          checked={props.text === 'true'}
          disabled={props.disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => { props.onEdit(String(event.target.checked)) }}
        />
        <div className={css.checkboxText}>
          <label className={css.label} htmlFor={props.id}>{props.label}</label>
          <p className={props.invalid ? css.invalid : css.hint}>
            {props.invalid ? props.invalidLabel : props.hint}
          </p>
        </div>
      </div>
      {resetBadge(props)}
    </div>
  )
}

/** Write-only credential field copied from the upstream SecretField shape. */
export function SecretField(props: {
  id: string
  label: string
  hint: string
  text: string
  configured: boolean
  stateLabel: string
  disabled: boolean
  onEdit: (text: string) => void
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        <span className={css.badges}>
          <span className={props.configured ? css.badge : css.badgeMuted}>{props.stateLabel}</span>
        </span>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="password"
        autoComplete="off"
        value={props.text}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
