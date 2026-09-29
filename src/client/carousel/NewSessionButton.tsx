import { useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import { ActionIcon } from '../workbench/ActionIcon.tsx'
import css from './carousel.module.css'

/** Shared by compact and official headers; a fresh session, never a fork. */
export function NewSessionButton({ sessionId, create, t }: {
  sessionId: string
  create: (sessionId: string) => Promise<void>
  t: Translate<MatouKey>
}) {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return <>
    <button
      type="button"
      className={css.newSessionButton}
      aria-label={t('session.add')}
      title={t('session.add')}
      disabled={busy}
      aria-busy={busy}
      onClick={async (event) => {
        event.stopPropagation()
        if (lock.current) return
        lock.current = true
        setBusy(true)
        setError(undefined)
        try { await create(sessionId) }
        catch (reason) {
          console.error('matou-layout: new session failed', reason)
          setError(t(reason instanceof Error && reason.message.includes('changed elsewhere')
            ? 'scene.action.conflict' : 'scene.action.error'))
        } finally { lock.current = false; setBusy(false) }
      }}
    >
      <ActionIcon name="panel-right-open" />
    </button>
    {error !== undefined && <Toast text={error} onDone={() => { setError(undefined) }} />}
  </>
}
