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
        inputMode={props.numeric ? 'numeric' : undefined}
        aria-invalid={props.invalid || undefined}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>{props.invalid ? props.invalidLabel : props.hint}</p>
    </div>
  )
}

export function SelectField(props: FieldProps & { options: readonly { value: string; label: string }[] }) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {resetBadge(props)}
      </div>
      <select
        id={props.id}
        className={props.invalid ? css.selectInvalid : css.select}
        aria-invalid={props.invalid || undefined}
        value={props.text}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => { props.onEdit(event.target.value) }}
      >
        {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <p className={props.invalid ? css.invalid : css.hint}>{props.invalid ? props.invalidLabel : props.hint}</p>
    </div>
  )
}

export function CheckboxField(props: FieldProps) {
  const checked = props.text === 'true'
  return (
    <div className={css.field}>
      <div className={css.checkboxRow}>
        <input
          id={props.id}
          className={css.checkbox}
          type="checkbox"
          checked={checked}
          disabled={props.disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => { props.onEdit(String(event.target.checked)) }}
        />
        <div className={css.checkboxText}>
          <label className={css.label} htmlFor={props.id}>{props.label}</label>
          <p className={props.invalid ? css.invalid : css.hint}>{props.invalid ? props.invalidLabel : props.hint}</p>
        </div>
      </div>
      {resetBadge(props)}
    </div>
  )
}

export function SecretField(props: {
  id: string
  label: string
  hint: string
  text: string
  configured: boolean
  configuredLabel: string
  notConfiguredLabel: string
  disabled: boolean
  onEdit: (text: string) => void
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        <span className={props.configured ? css.badge : css.badgeMuted}>
          {props.configured ? props.configuredLabel : props.notConfiguredLabel}
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
