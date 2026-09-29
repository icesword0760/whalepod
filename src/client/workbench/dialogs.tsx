/**
 * The two dialogs the workbench reuses everywhere: rename (validated input)
 * and confirm (destructive action with honest impact copy).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives/src/Modal.tsx'
import css from './workbench.module.css'

export interface RenameDialogProps {
  open: boolean
  title: string
  initial: string
  fieldLabel: string
  cancelLabel: string
  confirmLabel: string
  closeLabel: string
  validate: (draft: string) => string | undefined
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}

export function RenameDialog(props: RenameDialogProps) {
  const [draft, setDraft] = useState(props.initial)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const composing = useRef(false)

  useEffect(() => {
    if (props.open) {
      setDraft(props.initial)
      setError(undefined)
      setBusy(false)
    }
  }, [props.open, props.initial])

  const submit = useCallback(async () => {
    const failure = props.validate(draft)
    if (failure !== undefined) {
      setError(failure)
      return
    }
    setBusy(true)
    try {
      await props.onSubmit(draft.trim())
      props.onClose()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }, [draft, props])

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      closeLabel={props.closeLabel}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>{props.cancelLabel}</Button>
          <Button variant="primary" disabled={busy || error !== undefined} onClick={() => { void submit() }}>
            {props.confirmLabel}
          </Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label={props.fieldLabel}
        autoFocus
        disabled={busy}
        onFocus={(event) => { event.target.select() }}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(undefined)
        }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      {error !== undefined && <div className={css.fieldError} role="alert">{error}</div>}
    </Modal>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  /** Plain impact copy, or richer content (e.g. a cascade-scope choice) — see `card-actions.tsx`'s remove dialog. */
  body: ReactNode
  cancelLabel: string
  confirmLabel: string
  closeLabel: string
  onConfirm: () => Promise<void>
  onClose: () => void
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (props.open) {
      setBusy(false)
      setError(undefined)
    }
  }, [props.open])
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      closeLabel={props.closeLabel}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>{props.cancelLabel}</Button>
          <Button
            variant="primary"
            disabled={busy}
            className={css.dangerButton}
            onClick={() => {
              setBusy(true)
              props.onConfirm().then(props.onClose, (reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason))
                setBusy(false)
              })
            }}
          >
            {props.confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={css.confirmBody}>{props.body}</div>
      {error !== undefined && <div className={css.fieldError} role="alert">{error}</div>}
    </Modal>
  )
}
