/**
 * A self-built on/off switch. DSH ships no Switch/Toggle primitive (confirmed
 * against `@deepseek-ai/dsh-client-ui-primitives`'s exports) — every DSH
 * surface that needs one hand-rolls the same shape:
 * `ui-settings-plugins/src/client/SubagentModelSelectionCard.tsx`'s
 * enable-toggle (`role="switch"`, `aria-checked`, a track `<span>` holding a
 * thumb `<span>`, the "on" state as a class rather than an inline style) and
 * `ui-trajectory/src/client/TrajectoryToolbar.tsx`'s `actualTime` control
 * (same `role="switch"`/`aria-checked` pair on a plain `<button>`). This
 * component follows that exact convention rather than 码头's own DOM shape
 * (`notification-center.css`'s `.notification-center__switch`, a `<label>`
 * wrapping a visually-hidden native `<input type="checkbox">`): DSH's own
 * precedent is the one to match in a DSH-hosted plugin, and a bare
 * `<button role="switch">` needs no hidden-input trick to be both a real
 * control and an accessible one.
 * @module dsh-plugin-matou-layout/src/client/notifications/Switch
 */
import clsx from 'clsx'
import css from './notifications.module.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Accessible name — this component renders no visible text of its own. */
  ariaLabel: string
  disabled?: boolean
}

/**
 * Render one on/off switch.
 * @param props - checked state, change callback, and accessible name.
 * @returns the switch button.
 */
export function Switch({ checked, onChange, ariaLabel, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={clsx(css.switch, checked && css.switchOn)}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
    >
      <span className={css.switchThumb} />
    </button>
  )
}
