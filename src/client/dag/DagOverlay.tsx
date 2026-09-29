/**
 * The session-relationship overlay's shell (S4 Task 12): the `shell.overlay`
 * seat that mounts `DagCanvas` + `DagSearch` over the whole page, isolates the
 * app behind it, owns `Esc`, persists the viewport per workbench tab, and turns
 * a card click into 「关浮层 → 跳回现场 → 清通知」.
 *
 * ## Why the subtree is portaled to `document.body` (D-2)
 *
 * The seat itself renders into `AppFrame.module.css`'s `.overlayLayer`, which
 * is `position: absolute` WITH `z-index: 20` — that pair makes it a stacking
 * context, so nothing inside it can rise above anything painted outside it, no
 * matter what `z-index` it asks for. Everything this overlay has to cover is
 * outside it: DSH's `Modal` portal (1000, `Modal.module.css:5`), `Toast` (1100,
 * `Toast.module.css:12`), `Menu`'s portal (1100, `Menu.module.css:48`). The
 * component therefore does what DSH's own `ImageLightbox.tsx:49-63` and
 * `OnboardingSurface.tsx:20-25` do — `createPortal(..., document.body)` — and
 * paints at `z-index: 1200`. The seat registration is unchanged; only the DOM
 * moves, so spec §4's 「同页全局浮层」 still holds.
 *
 * ## Modal isolation is `inert`, not a focus trap
 *
 * DSH has no focus trap anywhere in the repo; its answer to 「浮层期间底下不能
 * 被操作」 is `document.getElementById('root').inert = true`
 * (`OnboardingSurface.tsx:13-18`). This overlay copies that verbatim, with ONE
 * addition: a ref remembers whether THIS component is the one that set it. Both
 * surfaces target the same node and the same property, so without that check a
 * DAG overlay closing while an onboarding surface is still up would clear the
 * onboarding surface's isolation. The overlay's own DOM is portaled outside
 * `#root`, so it is never inert itself.
 *
 * ## Esc runs in the CAPTURE phase and stops there (裁定 T-4)
 *
 * Every other Escape handler in reach — DSH's `Modal`/`Menu`/`ContextMeter`,
 * this plugin's own `NotificationCenter.tsx:239-241` — listens on `document`'s
 * bubble phase and none of them stop propagation, so one keystroke closes all
 * of them at once. This overlay is the topmost modal surface on the page, so it
 * listens on the CAPTURE phase (which runs before every one of those) and
 * spends the event there: `preventDefault` + `stopPropagation` +
 * `stopImmediatePropagation`. **This is the opposite of
 * `NotificationCenter.tsx:242-249`'s deliberate bubble-phase choice, for a
 * different reason:** that panel wants nested controls to consume their own
 * Escape first; this overlay has no nested Escape consumer (the search box's
 * Escape is handled right here) and everything it must NOT wake is underneath
 * it. `preventDefault` also suppresses the browser's native 「Esc 清空
 * type=search」 so the input and this handler cannot disagree about the query.
 *
 * First Escape with a non-empty query clears the query; only the next one
 * closes. That is why the query lives here rather than inside `DagSearch`.
 *
 * ## The click sequence, and the one place it departs from spec §4
 *
 * spec §4 orders it 「关浮层 / 清通知 / 切层 / 聚焦居中」. The dismiss is moved
 * to AFTER a successful reveal, for exactly the reason
 * `NotificationCenter.tsx:222-227` removes a notification row only on success:
 * spending a user's unread marker on a jump that did not land is a pure loss.
 * What the user perceives is unchanged — a jump that lands still clears.
 *
 * 裁定 T-2 adds the subagent fallback: subagents are excluded from every
 * carousel layer (`workbench/known-sessions.ts:24`), so revealing one would
 * park the carousel on a session that is not on screen. {@link
 * nearestCarouselTarget} climbs to the first non-subagent ancestor instead and
 * a `Toast` says so; with no such ancestor the click takes the same failure
 * toast as a vanished session.
 *
 * Both toasts render OUTSIDE the `open` gate. The failure path closes the
 * overlay and raises the toast in the same commit, so a toast inside the
 * overlay subtree would be unmounted in the frame that shows it — the trap
 * `NotificationCenter.tsx:262-274` already documents. `Toast` portals to
 * `document.body` itself, so hoisting it changes only its lifetime.
 *
 * ## Viewport persistence lives here, not in the canvas
 *
 * `DagCanvas` only REPORTS transforms; it does not know which scene it is
 * drawing. This component reads `dag/viewport-store.ts` on open, debounces
 * reports by 200ms, and flushes the pending write when the overlay closes or
 * unmounts — 「卸载提交而非丢弃」, the same rule
 * `carousel/useCarouselController.ts:772-780` follows, and the one that makes
 * 「缩放后立刻按 Esc」 keep the user's observation point.
 * @module dsh-plugin-matou-layout/src/client/dag/DagOverlay
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, ReactPortal } from 'react'
// `react-dom` ships no type declarations of its own and THIS package does not
// depend on `@types/react-dom` — DSH's primitives package carries its own copy
// (`node_modules/@deepseek-ai/dsh-client-ui-primitives/node_modules/@types/`),
// which is why its `Toast.tsx`/`OnboardingSurface.tsx` compile against the same
// import while this file cannot borrow it. The single imported function is
// re-typed on the line below, so nothing downstream of it is `any`. The proper
// fix is a `@types/react-dom` devDependency; when it lands, tsc will flag this
// directive as unused and point straight here.
// @ts-expect-error — see above.
import { createPortal as untypedCreatePortal } from 'react-dom'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkbenchInjected } from '../workbench/face.ts'
import { useWorkbenchView } from '../workbench/useWorkbenchView.ts'
import { DagCanvas } from './DagCanvas.tsx'
import { DagSearch } from './DagSearch.tsx'
import { buildDagGraph } from './graph.ts'
import type { DagGraphView, DagNodeView, DagPlacementFacts } from './graph.ts'
import { readDagViewport, writeDagViewport } from './viewport-store.ts'
import type { DagTransform } from './viewport.ts'
import css from './dag.module.css'

/** React's own portal, with the signature the untyped `react-dom` import above cannot supply. */
const createPortal = untypedCreatePortal as (children: ReactNode, container: Element | DocumentFragment) => ReactPortal

/** The registered seat id — stable across HMR/reload (mirrors `NOTIFICATION_CENTER_SEAT_ID`). */
export const DAG_OVERLAY_SEAT_ID = 'matou-dag-overlay'

/** `aria-labelledby` target for the dialog; one overlay exists at a time, so a constant id is safe. */
const DAG_OVERLAY_TITLE_ID = 'matou-dag-overlay-title'

/** How long a pan/zoom must stay put before it is written to `localStorage` (裁定 T-1). */
const VIEWPORT_DEBOUNCE_MS = 200

/** Nothing to draw: the scene resolved to no graph at all (no active tab). */
const NO_GRAPH: DagGraphView = { sceneId: '', nodes: [], edges: [] }

export type DagOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<WorkbenchInjected>
  & PropsLocale<'matou'>

/**
 * The session this click should actually take the carousel to (裁定 T-2).
 *
 * A non-subagent node is its own answer. A subagent has no carousel layer of
 * its own, so the walk climbs the graph's parent edges to the first
 * non-subagent ancestor — the session whose header the subagent's UI hangs off
 * in DSH, and therefore the place 「去看这条线在哪」 actually leads. The walk is
 * cycle-guarded because nothing validates lineage upstream, and answers
 * `undefined` when the chain runs out (a subagent drawn as a root, which
 * happens when its placement row names a parent this graph does not contain)
 * or when the id is not in the graph at all.
 * @param graph - the projection being drawn.
 * @param sessionId - the clicked node.
 * @returns the session to reveal, or `undefined` when there is none.
 */
export function nearestCarouselTarget(graph: DagGraphView, sessionId: string): string | undefined {
  const byId = new Map(graph.nodes.map(node => [node.sessionId, node]))
  const seen = new Set<string>()
  let cursor: DagNodeView | undefined = byId.get(sessionId)
  while (cursor !== undefined && cursor.subagent) {
    if (seen.has(cursor.sessionId)) return undefined
    seen.add(cursor.sessionId)
    cursor = cursor.parentSessionId === undefined ? undefined : byId.get(cursor.parentSessionId)
  }
  return cursor?.sessionId
}

/**
 * Render the DAG overlay.
 *
 * Every hook runs unconditionally on every render; the `if (!open)` return sits
 * after all of them (the same rule `NotificationCenter.tsx` states for itself).
 * @param props - composed slot props (global runtime share + shared workbench face + locale seat).
 * @returns the body-portaled overlay while open, plus any live toast; only the
 * toast while closed.
 */
export function DagOverlay(props: DagOverlayProps) {
  const {
    t, useDag, useSessionPendingInteraction, useNotifications, closeDag, revealSession, dismissSessionIndicator,
  } = props
  const open = useDag(snapshot => snapshot.open)
  // The SAME projection every other surface reads (Ruling-20) rather than a
  // second derivation: `shell.overlay` is root-scoped, so this seat receives
  // all five hooks `useWorkbenchView` needs.
  const { sessions, org, active, archivedSessionIds } = useWorkbenchView(props)
  const pending = useSessionPendingInteraction(snapshot => snapshot)
  const notificationRecords = useNotifications(snapshot => snapshot.notifications)
  const [query, setQuery] = useState('')
  // `token` re-keys the `Toast` so a second failure restarts its hold/fade
  // cycle instead of riding out the first one's timer (`card-actions.tsx`'s
  // established shape).
  const [toast, setToast] = useState<{ token: number; text: string } | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const ownsInert = useRef(false)

  const sceneId = active.scene?.id
  const placementBySession = useMemo(
    () => new Map<string, DagPlacementFacts>(org.org.placements.map(placement => [placement.sessionId, placement])),
    [org.org.placements],
  )
  const pendingSessionIds = useMemo(() => new Set<string>(pending.keys()), [pending])
  const untitledLabel = t('session.untitled')
  // Gated on `open`: this seat stays mounted for the whole session, and
  // scanning DSH's entire session list on every summary tick while the overlay
  // is closed buys nothing.
  const graph = useMemo(() => (!open || sceneId === undefined
    ? NO_GRAPH
    : buildDagGraph({
      sceneId,
      sceneSessionRefs: active.scene?.sessions ?? [],
      allSessionIds: sessions.ids,
      summaryOf: id => sessions.byId[id as never],
      placementOf: id => placementBySession.get(id),
      archivedIds: archivedSessionIds,
      pendingSessionIds,
      notifications: notificationRecords,
      untitledLabel,
    })), [
    open, sceneId, active.scene, sessions, placementBySession, archivedSessionIds,
    pendingSessionIds, notificationRecords, untitledLabel,
  ])

  /**
   * 码头 `DagWindowApp.tsx:242-244`'s own fallback chain, with DSH's current
   * session standing in for its `context.sessionId`: the current session when
   * this graph draws it, else the first node, else nothing.
   */
  const current: string | undefined = sessions.current
  const focusedSessionId = current !== undefined && graph.nodes.some(node => node.sessionId === current)
    ? current
    : graph.nodes[0]?.sessionId ?? ''

  const raiseToast = useCallback((text: string) => {
    setToast(previous => ({ token: (previous?.token ?? 0) + 1, text }))
  }, [])
  const clearToast = useCallback(() => { setToast(null) }, [])

  const onSelectNode = useCallback((sessionId: string) => {
    const target = nearestCarouselTarget(graph, sessionId)
    closeDag()
    if (target === undefined) { raiseToast(t('dag.missing')); return }
    if (!revealSession(target)) { raiseToast(t('dag.missing')); return }
    // Step 6 AFTER the reveal landed — see the module doc's note on the
    // deliberate departure from spec §4's literal ordering.
    dismissSessionIndicator(target)
    if (target === sessionId) return
    const title = graph.nodes.find(node => node.sessionId === sessionId)?.title ?? ''
    raiseToast(t('dag.subagentRedirect', { title }))
  }, [graph, closeDag, revealSession, dismissSessionIndicator, raiseToast, t])

  // --- Viewport persistence (裁定 T-1). The queued write carries its own
  // scene id so a tab switch between the last gesture and the flush cannot
  // write one tab's viewport under another tab's key.
  const queuedWrite = useRef<{ sceneId: string; transform: DagTransform } | null>(null)
  const debounceTimer = useRef<number | null>(null)
  const flushViewport = useCallback(() => {
    if (debounceTimer.current !== null) {
      window.clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    const queued = queuedWrite.current
    queuedWrite.current = null
    if (queued !== null) writeDagViewport(queued.sceneId, queued.transform)
  }, [])
  const persistTransform = useCallback((transform: DagTransform) => {
    if (sceneId === undefined) return
    queuedWrite.current = { sceneId, transform }
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current)
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null
      flushViewport()
    }, VIEWPORT_DEBOUNCE_MS)
  }, [sceneId, flushViewport])
  const initialTransform = useMemo(
    () => (open && sceneId !== undefined ? readDagViewport(sceneId) : undefined),
    [open, sceneId],
  )
  useEffect(() => {
    if (!open) return
    // Runs on close AND on unmount — both are 「用户不再看着它了」, and both
    // must land the last gesture rather than drop it.
    return () => { flushViewport() }
  }, [open, flushViewport])

  // A reopened overlay starts with an empty search box; leaving the last query
  // in place would show stale results over a graph that has moved on.
  useEffect(() => { if (!open) setQuery('') }, [open])

  useEffect(() => {
    if (!open) return
    const appRoot = document.getElementById('root')
    // Already inert means somebody else (DSH's own `OnboardingSurface`) owns
    // the isolation; leave both the set and the restore to them.
    if (appRoot === null || appRoot.inert) return
    appRoot.inert = true
    ownsInert.current = true
    return () => {
      if (!ownsInert.current) return
      ownsInert.current = false
      appRoot.inert = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Spend the event here — see the module doc's T-4 section.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (queryRef.current !== '') { setQuery(''); return }
      closeDag()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, closeDag])

  // Outlives the overlay by design (see the module doc).
  const toastNode = toast === null
    ? null
    : <Toast key={toast.token} text={toast.text} onDone={clearToast} />

  if (!open) return toastNode

  return (
    <>
      {createPortal((
        <div className={css.overlay} role="dialog" aria-modal="true" aria-labelledby={DAG_OVERLAY_TITLE_ID}>
          {/* A slim title strip rather than a ✕ floating over the canvas: the
              canvas's own toolbar already owns both top corners
              (`.toolbar` spans `left: 16px` to `right: 16px`), and 码头's DAG
              is a separate window with a real title bar, so a strip is the
              closer analogue as well as the one that cannot overlap. */}
          <header className={css.overlayBar}>
            <h2 className={css.overlayTitle} id={DAG_OVERLAY_TITLE_ID}>{t('dag.label')}</h2>
            <button type="button" className={css.overlayClose} aria-label={t('dag.close')} onClick={closeDag}>
              <span aria-hidden="true">✕</span>
            </button>
          </header>
          {sceneId === undefined
            ? <p className={css.overlayEmpty} role="status">{t('dag.empty')}</p>
            : (
              <DagCanvas
                key={sceneId}
                graph={graph}
                focusedSessionId={focusedSessionId}
                onSelect={onSelectNode}
                initialTransform={initialTransform}
                onTransformChange={persistTransform}
                renderSearch={handlers => (
                  <DagSearch
                    nodes={graph.nodes}
                    onPreview={handlers.onPreview}
                    onChoose={handlers.onChoose}
                    query={query}
                    onQueryChange={setQuery}
                    t={t}
                  />
                )}
                t={t}
              />
            )}
        </div>
      ), document.body)}
      {toastNode}
    </>
  )
}

/**
 * Register the overlay into `shell.overlay`. Extracted from `apply()` (mirrors
 * `registerNotificationCenterSeat`/`registerBellSeat`) so the registration is
 * testable without standing up the plugin's full service graph.
 * @param ctx - client root context.
 * @param workbenchFace - the SAME face factory `apply()` hands every other seat.
 * @returns disposer removing the injected registration.
 */
export function registerDagOverlaySeat(
  ctx: ClientContext,
  workbenchFace: () => WorkbenchInjected,
): () => void {
  return ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: DAG_OVERLAY_SEAT_ID,
    locale: 'matou',
    inject: workbenchFace,
  }, DagOverlay))
}
