/**
 * Shared fork-naming / remove-confirm / rename dialog trio for a session
 * card's actions. Both the focused card's official-header seat
 * (`CardHeaderActions`, `header-seats.tsx`) and a compact card's own "⋯"
 * dropdown (`CompactCardHeader.tsx`) mount one instance of this — Ruling-6
 * (S3b plan ledger) hides the official header on compact cards via CSS, and
 * Ruling-9 gives the compact card its own trigger for the same actions, so
 * both surfaces need the same dialogs behind different triggers (toolbar
 * buttons + right-click menu vs. one dropdown).
 * @module dsh-plugin-matou-layout/src/client/carousel/card-actions
 */
import { useEffect, useState } from 'react'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import { validateUniqueName } from '../org/naming.ts'
import { ConfirmDialog, RenameDialog } from '../workbench/dialogs.tsx'
import css from './card-actions.module.css'

/** The three fork verbs plus remove — the subset of `WorkbenchActions` a card's dialogs need. */
export interface CardForkActionsFace {
  forkChild(sessionId: string, name: string): Promise<void>
  forkSibling(sessionId: string, name: string): Promise<void>
  forkPeer(sessionId: string, name: string): Promise<void>
  /** `cascade`: archive `sessionId`'s whole (carousel-visible) subtree, not just the one card. */
  removeCard(sessionId: string, cascade: boolean): Promise<void> | void
}

export type ForkMode = 'child' | 'sibling' | 'peer'

export interface CardActionDialogsProps {
  sessionId: string
  /** Current display title — the rename dialog's prefilled draft. */
  title: string
  /** Direct children count — 0 keeps the remove dialog a single confirm; >0 offers the 仅本卡/含所有子代 choice (spec §3/§7.1). */
  childCount: number
  /**
   * Whether this card has an effective parent — decides WHICH of 码头's two
   * "仅本卡" descriptions the dialog shows (`RemoveNodeDialog.tsx:31-35`):
   * the descendants reattach to that parent, or, at the root layer, become
   * root sessions themselves. Defaults to `false` (root) so an unwired
   * caller still describes a real outcome rather than none.
   */
  hasParent?: boolean
  actions: CardForkActionsFace
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** Sibling titles in the fork's target layer, for the "同层唯一" uniqueness check (empty when unknown — every name passes). */
  childTitles: readonly string[]
  siblingTitles: readonly string[]
  renameOpen: boolean
  onRenameClose: () => void
  /** Which fork dialog is open, or `null`. */
  forkMode: ForkMode | null
  onForkClose: () => void
  removeOpen: boolean
  onRemoveClose: () => void
  t: Translate<MatouKey>
}

const FORK_MAX_NAME_LENGTH = 64

/** Localized dialog title per fork mode (matches `card.fork.<mode>.title` in `locales.ts`). */
function forkDialogTitle(mode: ForkMode, t: Translate<MatouKey>): string {
  if (mode === 'child') return t('card.fork.child.title')
  if (mode === 'sibling') return t('card.fork.sibling.title')
  return t('card.fork.peer.title')
}

/** Structural test for "carries an `rpcError` field", ahead of handing it to `remoteErrorOf`. */
function hasRpcError(error: unknown): error is { rpcError: unknown } {
  return typeof error === 'object' && error !== null && 'rpcError' in error
}

/**
 * D5 (S3b Task 11d): map a rejected `forkChild`/`forkSibling`/`forkPeer` call
 * to a localized, human message before it reaches `RenameDialog`'s generic
 * error banner (`workbench/dialogs.tsx`'s `submit`, which otherwise displays
 * `reason.message` verbatim). Left uncaught, a real fork failure surfaces
 * DSH's raw backend prose straight to the user — English, a bare session
 * UUID, and all: `session fork failed: session/fork-unavailable: session
 * "session-48fd4caa-…" has no completed turn to fork from`.
 *
 * `ClientSessions.fork` throws a `SessionForkError` carrying a `RemoteFailure`
 * (`rpcError`) on failure (`@deepseek-ai/dsh-api-session-controller/client`).
 * This deliberately does NOT `instanceof SessionForkError` to recognize it —
 * DSH's own `remoteErrorOf` doc is explicit that Remote failure
 * discrimination is "always by code, never instanceof" (a realm/bundle copy
 * of the class fails `instanceof` even when it is a perfectly good
 * `RemoteFailure`) — so this reads the `rpcError` field structurally instead
 * and lets `remoteErrorOf` do the marker check.
 *
 * Only the one code this UI can act on specifically —
 * `session/fork-unavailable`, the same "no completed turn to fork from"
 * precondition {@link useCardActionState}'s pre-click `startFork` gate (D4)
 * exists to head off — gets its own copy; this is the honest backstop for
 * that gate racing a stale `blank` snapshot, not the primary defense. Every
 * OTHER cause (a same-layer duplicate name the client's own check somehow
 * missed, a workspace/directory failure, a generic gateway error, a rejected
 * post-fork rename, …) collapses to one honest generic failure message
 * rather than guessing at which of DSH's many RemoteError codes it is. The
 * original error always reaches the console for diagnosis; it never reaches
 * the user's screen verbatim.
 * @param error - whatever the rejected fork call threw.
 * @param t - the card's locale seat.
 * @returns a new `Error` carrying only localized copy.
 */
export function humanizeForkError(error: unknown, t: Translate<MatouKey>): Error {
  console.error('matou-layout: fork failed', error)
  const rpcError = hasRpcError(error) ? remoteErrorOf(error.rpcError) : undefined
  return new Error(rpcError?.code === 'session/fork-unavailable' ? t('card.fork.notReady') : t('card.fork.error'))
}

/**
 * 把移除失败翻译成用户读得懂的一句话——与 {@link humanizeForkError} 同构。
 *
 * 首次活体走查逮到的：只剩一张卡的页签里点「确认移除」，`removeCard` 按
 * spec §3「会清空页签时拒绝」抛错，而 `onConfirm` 当时既没 catch 也没翻译，
 * 用户看到的是一句裸英文内部错误（`matou-layout: removing this would leave
 * the tab with no sessions…`）。同文件的 fork 路径早有这套翻译，移除没用上。
 *
 * 判据用的是 `actions.ts` 里那句错误文本的稳定片段而不是错误码——`removeCard`
 * 抛的是普通 `Error`（不是带 code 的 RPC 错误），本仓没有第二处产生这句话。
 * @param error - `removeCard` 抛出的原始错误。
 * @param t - matou 命名空间的翻译器。
 * @returns 一个只带用户可读文案的 Error，供对话框的错误条渲染。
 */
export function humanizeRemoveError(error: unknown, t: Translate<MatouKey>): Error {
  console.error('matou-layout: remove failed', error)
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.includes('leave the tab with no sessions')
    ? t('card.remove.lastInScene')
    : t('card.remove.error'))
}

/**
 * The three dialogs a card's actions open: rename (existing title), fork
 * (new branch name, validated unique within the target layer + a 64-char
 * cap), and remove (archive confirm). Fully controlled — the owner decides
 * when each opens; this component only renders them and wires `onSubmit`/
 * `onConfirm` to the right `actions` method.
 */
export function CardActionDialogs({
  sessionId, title, childCount, hasParent = false, actions, renameSession, childTitles, siblingTitles,
  renameOpen, onRenameClose, forkMode, onForkClose, removeOpen, onRemoveClose, t,
}: CardActionDialogsProps) {
  const forkTitles = forkMode === 'child' ? childTitles : siblingTitles
  // 仅本卡/含所有子代: reset to the non-destructive default every time the
  // dialog (re)opens, so a leftover choice from a previous open never
  // silently cascades.
  const [cascade, setCascade] = useState(false)
  useEffect(() => { if (removeOpen) setCascade(false) }, [removeOpen])
  const removeBody = childCount === 0
    ? t('card.remove.body')
    : (
      <>
        <p className={css.removeBody}>{t('card.remove.scope')}</p>
        <label className={css.removeChoice}>
          <input type="radio" name={`remove-scope-${sessionId}`} checked={!cascade} onChange={() => { setCascade(false) }} />
          {t('card.remove.onlyThis')}
          {/* C2: name the descendants' fate, exactly as 码头 does — this
              branch REPARENTS them (actions.ts's `reparentOps`), it does not
              leave them dangling, and the user has no other way to know. */}
          <em className={css.removeHint}>
            {t(hasParent ? 'card.remove.onlyThis.hint' : 'card.remove.onlyThis.hintRoot')}
          </em>
        </label>
        <label className={css.removeChoice}>
          <input type="radio" name={`remove-scope-${sessionId}`} checked={cascade} onChange={() => { setCascade(true) }} />
          {t('card.remove.withDescendants', { n: childCount })}
        </label>
      </>
    )
  return (
    <>
      <RenameDialog
        open={renameOpen}
        title={t('card.rename.title')}
        initial={title}
        fieldLabel={t('dialog.name')}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('dialog.confirm')}
        closeLabel={t('dialog.close')}
        validate={draft => (draft.trim().length === 0 ? t('validation.empty') : undefined)}
        onSubmit={async (name) => { await renameSession(sessionId, name) }}
        onClose={onRenameClose}
      />
      <RenameDialog
        open={forkMode !== null}
        title={forkMode === null ? '' : forkDialogTitle(forkMode, t)}
        initial=""
        fieldLabel={t('card.fork.name')}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('dialog.confirm')}
        closeLabel={t('dialog.close')}
        validate={draft => validateUniqueName(
          draft, forkTitles, { empty: t('validation.empty'), duplicate: t('card.fork.duplicate') },
        ) ?? (draft.trim().length > FORK_MAX_NAME_LENGTH ? t('card.fork.tooLong') : undefined)}
        onSubmit={async (name) => {
          try {
            if (forkMode === 'child') await actions.forkChild(sessionId, name)
            else if (forkMode === 'sibling') await actions.forkSibling(sessionId, name)
            else if (forkMode === 'peer') await actions.forkPeer(sessionId, name)
          } catch (error) {
            // D5: never let the raw backend error reach RenameDialog's banner — see `humanizeForkError`'s doc.
            throw humanizeForkError(error, t)
          }
        }}
        onClose={onForkClose}
      />
      <ConfirmDialog
        open={removeOpen}
        title={t('card.remove.title', { name: title })}
        body={removeBody}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('card.remove.confirm')}
        closeLabel={t('dialog.close')}
        onConfirm={async () => {
          try {
            await actions.removeCard(sessionId, childCount > 0 && cascade)
          } catch (error) {
            // 同 fork：内部错误不许直出给用户，见 `humanizeRemoveError` 的文档。
            throw humanizeRemoveError(error, t)
          }
        }}
        onClose={onRemoveClose}
      />
    </>
  )
}

/**
 * Why a fork attempt was blocked before the naming dialog ever opened:
 * `'running'` — the source is mid-turn; `'notReady'` — the source has never
 * completed a turn at all (D4, S3b Task 11d). Two distinct reasons because
 * they get two distinct toasts (`card.fork.blocked` vs `card.fork.notReady`)
 * — "wait, it's busy" and "there's nothing to fork from yet" are different
 * facts, not two spellings of the same one.
 */
export type ForkBlockReason = 'running' | 'notReady'

/**
 * Open/close state for the three dialogs above, plus the source-readiness
 * gate (spec §4: "源会话未就绪（运行中）点 fork 只弹提示，不 fork") as one
 * small hook — shared by `CardHeaderActions` and `CompactCardHeader` so
 * neither reimplements the state machine.
 *
 * "未就绪" spec's own wording only names "运行中" (mid-turn), but the exact
 * same backend precondition also rejects a source that has NEVER run at all
 * — DSH's fork RPC requires at least one completed turn
 * (`session/fork-unavailable: session "…" has no completed turn to fork
 * from` — see `header-seats.tsx`'s `forkReadyFromBlank` doc for the honest
 * `blank`-based signal this half of the gate reads). D4 (S3b Task 11d)
 * widens `startFork`'s single `running` gate to the two-reason
 * {@link ForkBlockReason} so both halves of "未就绪" are covered, not just
 * the one the spec's prose happened to spell out.
 */
export function useCardActionState() {
  const [renameOpen, setRenameOpen] = useState(false)
  const [forkMode, setForkMode] = useState<ForkMode | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [blocked, setBlocked] = useState<{ reason: ForkBlockReason; token: number } | null>(null)

  return {
    renameOpen,
    forkMode,
    removeOpen,
    /** Set on every blocked fork attempt (bumped `token` re-keys the `Toast`); render one while non-null. */
    blocked,
    openRename: () => { setRenameOpen(true) },
    closeRename: () => { setRenameOpen(false) },
    /**
     * Opens the named fork dialog, unless `running` or `!ready` names a
     * block reason instead — then the dialog never opens and `blocked` is
     * set for the caller's `Toast`. `ready` defaults to `true` (honest
     * degradation: a caller that never wires the readiness signal simply
     * never blocks on it, same policy as the existing `running` params'
     * `false` defaults upstream).
     */
    startFork: (mode: ForkMode, running: boolean, ready: boolean = true) => {
      const reason: ForkBlockReason | undefined = running ? 'running' : !ready ? 'notReady' : undefined
      if (reason !== undefined) { setBlocked(prev => ({ reason, token: (prev?.token ?? 0) + 1 })); return }
      setForkMode(mode)
    },
    closeFork: () => { setForkMode(null) },
    openRemove: () => { setRemoveOpen(true) },
    closeRemove: () => { setRemoveOpen(false) },
    clearBlocked: () => { setBlocked(null) },
  }
}
