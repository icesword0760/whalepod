/**
 * The notification-center panel (`shell.overlay` seat, S5 Task 7). Ported
 * from 码头's `NotificationCenter.tsx` (spec §5): a fixed left panel — 382px
 * wide, 49px down from the top, 5px clear at the bottom, 12px radius, 220ms
 * drop-in — with a `通知 (总数)` header (the STORED total, never the unread
 * count — 码头's own header does the same), a time-descending list (the
 * store already keeps `notifications` newest-first via `unshift` — see
 * `store.ts`'s module doc — so this component does NOT re-sort, unlike
 * 码头's own redundant `[...snapshot.notifications].sort(...)`), and a
 * "通知声音" footer switch, plus (S5 Task 8) click-to-navigate — see the
 * dedicated section below.
 *
 * Registration lives in this same file (mirrors `Bell.tsx`'s
 * `registerBellSeat` / `header-seats.tsx`'s `registerHeaderSeats` — this
 * repo's established convention of registration + component sharing one
 * module) rather than being inlined in `index.ts`.
 *
 * ## Closing: Esc, click-outside, and why not a full-screen capture div
 *
 * `shell.overlay` (`AppFrame.module.css`'s `.overlayLayer`) is
 * `pointer-events: none` with `> * { pointer-events: auto }` restoring it on
 * direct children. This component's only rendered element (while open) is
 * the 382px `<section>` panel itself — the direct `.overlayLayer` child — so
 * it alone becomes the click-through boundary automatically; nothing wider
 * needs a pointer-events override, and no full-screen transparent sibling is
 * rendered to capture "outside" clicks (a design the brief's own technical
 * note flags as needing that override — this component simply doesn't reach
 * for that shape). Outside-click and Escape instead follow DSH's own
 * precedent for exactly this problem: `dsh-client-ui-primitives`'s
 * `Menu.tsx` attaches `document`-level `pointerdown`/`keydown` listeners
 * scoped to `open`, checking containment against a ref. This component does
 * the same, with one deliberate difference the effect itself documents:
 * pointerdown listens on the CAPTURE phase (`MenuView.tsx`'s choice) rather
 * than `Menu.tsx`'s bubble phase.
 *
 * Both paths call `closePanel` (`panel-store.ts`'s `setOpen(false)`) rather
 * than `togglePanel`, simply because Esc/click-outside/the close button mean
 * "closed", never "flip" — see `WorkbenchInjected.closePanel`'s doc.
 *
 * ## The bell-click double-flip (S5 Task 7 review finding, corrected here)
 *
 * `Menu.tsx`'s outside-click check is safe because its anchor and its list
 * share one `rootRef` — clicking the anchor is never "outside". The bell
 * (`sidebar.footer.action`) and this panel (`shell.overlay`) are different
 * seats in different React subtrees (Ruling-S5-1) with no shared ref, so a
 * naive port of that check treats a click on the bell as "outside" too — and
 * that is a REAL bug, not a hypothetical one: while the panel is open,
 * clicking the bell fires `pointerdown` first (bubbles to `document`, target
 * is the bell, not inside `panelRef` → this effect's handler calls
 * `closePanel()`, `open` flips to `false`, this component unmounts and its
 * own listeners come off) and THEN `click` (the bell's own `onClick` runs
 * `togglePanel()`, which now sees `open === false` and flips it straight
 * back to `true`) — net effect, the panel never actually closes; a user
 * clicking the bell to dismiss it sees nothing happen (or a flicker). An
 * EARLIER version of this file's docs (and `WorkbenchInjected.closePanel`'s)
 * claimed using `closePanel` instead of `togglePanel` here already prevented
 * this race — that reasoning was wrong: `closePanel` only ever runs while
 * `open` is already `true` (this effect is scoped to `open`), so at that
 * instant `setOpen(false)` and `toggle()` produce the IDENTICAL result: the
 * second flip comes from the BELL's own `togglePanel`, not from which write
 * this effect happens to call.
 *
 * The actual fix: the outside-click check also excludes anything under
 * `Bell.tsx`'s `BELL_ANCHOR_ATTR` DOM attribute — the bell stamps it on its
 * own root button precisely so this file can recognize "that's the bell,
 * not outside" without a shared ref. DSH does the same thing in
 * `ui-input-trigger`'s `MenuView.tsx:60-72`, whose outside-pointerdown check
 * exempts a region owned by another package via
 * `closest('[data-composer-card]')`; 码头's own bell exemption
 * (`TaskSidebar.tsx:93-95`) is the same idea reached through
 * `document.querySelector('.flat-sidebar__notify')?.contains(target)` —
 * `closest()` from the event target is strictly safer than that, since a
 * document-wide `querySelector` silently picks the FIRST match once a second
 * bell exists. Note what is deliberately NOT copied: DSH's other answer to
 * this race is `stopPropagation()` on the trigger's own pointerdown
 * (`ui-conversation`'s `InputBar.tsx:385-393`). That works for DSH's own
 * composer because it owns the surrounding surface; a plugin's sidebar
 * button swallowing pointerdown would blind EVERY other document-level
 * dismisser (DSH's `Menu`, `ModelSelect`, …), so a DSH dropdown left open
 * would stop closing when the user clicks our bell. With the bell excluded, its
 * `pointerdown` no longer closes the panel at all, so its `click`'s
 * `togglePanel()` is the ONLY write in the sequence — exactly one flip,
 * exactly what a single click on the bell should do.
 *
 * ## Click-to-navigate (S5 Task 8, 码头's "点条目跳转")
 *
 * 码头's `TaskSidebar.tsx:159-182` `navigateNotification` ends:
 *
 * ```ts
 * if (success) notificationStore.remove(notification.id)
 * setNotificationCenterOpen(false)
 * ```
 *
 * — the panel closes either way; the row is removed ONLY when the jump
 * landed. That split is reproduced verbatim here. Everything that decides
 * `success` (locate the session's live workspace/task/scene, reset that
 * scene's drill layer to the target's parent, activate all four levels,
 * focus the session) is one `revealSession` call into `workbench/actions.ts`
 * — see its doc for the two rulings that make it a single boolean rather
 * than 码头's two failure branches (Ruling-S5-7: no "detached window"
 * dimension in DSH; Ruling-S5-8: a missing workspace is not a silent dead
 * click but the same toast as a missing session).
 *
 * A row with no `sessionId` at all takes the failure path WITHOUT calling
 * `revealSession`: `AgentNotification.sessionId` is nullable in the store
 * even though this plugin's derivation layer (`derive.ts`) always sets it,
 * and "reveal nothing" is not a question the actions face should be asked.
 *
 * The toast is rendered OUTSIDE the `open` gate on purpose. Both failure
 * effects fire together — the panel closes AND the toast appears — so a
 * toast rendered inside the panel subtree would be unmounted in the same
 * commit that shows it, and the user would see nothing at all. `Toast`
 * portals to `document.body` (see its own doc), so hoisting it out of the
 * panel changes nothing about where it draws; it only decouples its lifetime
 * from the panel's. The `token`-keyed state is `card-actions.tsx`'s own
 * established shape for a re-showable toast.
 * @module dsh-plugin-matou-layout/src/client/notifications/NotificationCenter
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { defaultTaskId } from '../../org/model.ts'
import type { MatouTask } from '../../org/model.ts'
import type { MatouKey } from '../locales.ts'
import type { WorkbenchInjected } from '../workbench/face.ts'
import { BELL_ANCHOR_ATTR } from './Bell.tsx'
import type { AgentNotification } from './store.ts'
import { NotificationItem } from './NotificationItem.tsx'
import { Switch } from './Switch.tsx'
import css from './notifications.module.css'

/** `event.target.closest()` selector matching the bell's root button — see `BELL_ANCHOR_ATTR`'s doc. */
const BELL_ANCHOR_SELECTOR = `[${BELL_ANCHOR_ATTR}]`

/** The registered seat id — stable across HMR/reload (mirrors `BELL_SEAT_ID`'s convention). */
export const NOTIFICATION_CENTER_SEAT_ID = 'matou-notification-center'

export type NotificationCenterProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<WorkbenchInjected>
  & PropsLocale<'matou'>

/**
 * Resolve a workspace's breadcrumb name, or 码头's own "未知工作区" fallback
 * (spec §5) when `workspaceId` is absent or no longer resolves against DSH's
 * live workspace list.
 * @param items - DSH's own workspace list (`useWorkspaces(s => s.items)`).
 * @param workspaceId - the notification's recorded workspace id, or `null`.
 * @param t - the `matou` namespace translator.
 * @returns the resolved display name.
 */
export function workspaceNameFor(
  items: readonly { workspaceId: string, title: string }[],
  workspaceId: string | null,
  t: Translate<MatouKey>,
): string {
  const found = workspaceId === null ? undefined : items.find(item => item.workspaceId === workspaceId)
  return found?.title ?? t('notification.unknownWorkspace')
}

/**
 * Resolve a task's breadcrumb name: a stored row's own title, the
 * synthesized "默认" for an unmaterialized default task (`org/model.ts`'s
 * `defaultTaskId`), or 码头's own "未知事项" fallback once neither applies.
 *
 * Reads the RAW organization document (`useOrg(s => s.org.tasks)`), not the
 * rendering-oriented `deriveOrgView` projection: that view drops an empty
 * virtual default task from its tree entirely once it holds no known
 * sessions (`org/derive.ts`'s module doc — "An empty unmaterialized default
 * renders nothing"), which would misreport an otherwise-real default task as
 * "未知事项" the moment its last session leaves — exactly the situation a
 * notification is likely to outlive.
 * @param tasks - the raw organization document's stored tasks (`useOrg(s => s.org.tasks)`).
 * @param workspaceId - the notification's recorded workspace id, or `null`.
 * @param taskId - the notification's recorded task id, or `null`.
 * @param t - the `matou` namespace translator.
 * @returns the resolved display name.
 */
export function taskNameFor(
  tasks: readonly MatouTask[],
  workspaceId: string | null,
  taskId: string | null,
  t: Translate<MatouKey>,
): string {
  if (taskId === null) return t('notification.unknownTask')
  const stored = tasks.find(task => task.id === taskId)
  if (stored !== undefined) return stored.title
  if (workspaceId !== null && taskId === defaultTaskId(workspaceId)) return t('task.default')
  return t('notification.unknownTask')
}

/**
 * Render the notification-center panel.
 *
 * Every hook below runs unconditionally on every render, open or closed —
 * the `if (!open) return null` branch comes AFTER all of them, never before
 * (oxlint's rules-of-hooks would catch a reordering, but the module doc
 * calls it out explicitly per the brief's own constraint).
 * @param props - composed slot props (runtime share + shared workbench face + locale seat).
 * @returns the panel while open; `null` while closed (no DOM at all — 码头's
 * own panel is a mount/unmount, not a hidden node).
 */
export function NotificationCenter(props: NotificationCenterProps) {
  const {
    t, usePanel, useNotifications, useOrg, useWorkspaces,
    removeNotification, clearNotifications, setNotificationSoundEnabled, closePanel, revealSession,
  } = props
  const open = usePanel(snapshot => snapshot.open)
  const notifications = useNotifications(snapshot => snapshot.notifications)
  const soundEnabled = useNotifications(snapshot => snapshot.soundEnabled)
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const tasks = useOrg(snapshot => snapshot.org.tasks)
  const panelRef = useRef<HTMLElement | null>(null)
  // `token` re-keys the `Toast` so a second failed jump restarts its
  // hold/fade cycle instead of riding out the first one's timer
  // (`card-actions.tsx`'s `blocked` state, same shape).
  const [missingToast, setMissingToast] = useState<{ token: number } | null>(null)
  const clearMissingToast = useCallback(() => { setMissingToast(null) }, [])

  const onNavigate = useCallback((notification: AgentNotification) => {
    const revealed = notification.sessionId !== null && revealSession(notification.sessionId)
    if (revealed) removeNotification(notification.id)
    else setMissingToast(previous => ({ token: (previous?.token ?? 0) + 1 }))
    closePanel()
  }, [revealSession, removeNotification, closePanel])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (panelRef.current?.contains(event.target) === true) return
      // The bell-click double-flip fix — see the module doc's dedicated
      // section for the full sequence this exclusion closes.
      if (event.target instanceof Element && event.target.closest(BELL_ANCHOR_SELECTOR) !== null) return
      closePanel()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    // Capture phase, like `MenuView.tsx:73`'s own outside-pointerdown
    // listener — and unlike `Menu.tsx`'s bubble-phase one. A bubble listener
    // is invisible to any surface that stops pointerdown propagation, which
    // DSH's own composer capsule does in its workspace-trigger state
    // (`InputBar.tsx:392`) and any third-party plugin may do anywhere: the
    // panel would then sit open over a surface the user just clicked. What
    // counts as "inside" here is decided by the target, never by
    // propagation, so running earlier changes nothing else.
    //
    // Escape stays on the bubble phase on purpose: a focused control inside
    // the panel (a menu, a dialog) must get to consume its own Escape first
    // rather than have the whole panel yanked out from under it.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, closePanel])

  // The toast outlives the panel by design (see the module doc): the failure
  // path closes the panel in the same commit that raises the toast.
  const toast = missingToast === null
    ? null
    : (
      <Toast
        key={missingToast.token}
        text={t('notification.navigate.missing')}
        onDone={clearMissingToast}
      />
    )

  if (!open) return toast

  return (
    <>
    <section ref={panelRef} className={css.panel} role="region" aria-label={t('notification.center.label')}>
      <header className={css.header}>
        <h2 className={css.title}>{t('notification.center.heading', { n: notifications.length })}</h2>
        <div className={css.headerActions}>
          {notifications.length > 0 && (
            <button type="button" className={css.actionBtn} onClick={clearNotifications}>
              {t('notification.center.clear')}
            </button>
          )}
          <button type="button" className={css.closeBtn} onClick={closePanel}>
            {t('notification.center.close')}
          </button>
        </div>
      </header>
      <div className={css.list}>
        {notifications.length === 0
          ? (
            <div className={css.empty}>
              <p className={css.emptyText}>{t('notification.center.empty')}</p>
            </div>
          )
          : (
            <div className={css.group}>
              <div className={css.items}>
                {notifications.map(notification => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    workspaceName={workspaceNameFor(workspaces, notification.workspaceId, t)}
                    taskName={taskNameFor(tasks, notification.workspaceId, notification.taskId, t)}
                    onRemove={removeNotification}
                    onNavigate={onNavigate}
                    t={t}
                  />
                ))}
              </div>
            </div>
          )}
      </div>
      <footer className={css.footer}>
        <div className={css.soundToggle}>
          <span className={css.soundLabel}>{t('notification.center.sound')}</span>
          <Switch
            checked={soundEnabled}
            onChange={setNotificationSoundEnabled}
            ariaLabel={t('notification.center.sound')}
          />
        </div>
      </footer>
    </section>
    {toast}
    </>
  )
}

/**
 * Register the panel into `shell.overlay`. Extracted from `apply()` (mirrors
 * `registerBellSeat`) so registration itself is testable without standing up
 * the plugin's full service graph.
 * @param ctx - client root context.
 * @param workbenchFace - the SAME face factory `apply()` hands `root`,
 * `sidebar.workspaces`, and `sidebar.footer.action` (already carrying
 * `hooks.panel`/`hooks.notifications`/`hooks.org` and the
 * `closePanel`/`removeNotification`/`clearNotifications`/
 * `setNotificationSoundEnabled` write passthroughs).
 * @returns disposer removing the injected registration (mirrors `ctx.slots.inject`'s own return).
 */
export function registerNotificationCenterSeat(
  ctx: ClientContext,
  workbenchFace: () => WorkbenchInjected,
): () => void {
  return ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: NOTIFICATION_CENTER_SEAT_ID,
    locale: 'matou',
    inject: workbenchFace,
  }, NotificationCenter))
}
