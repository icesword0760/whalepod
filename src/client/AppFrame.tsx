/**
 * The three-column shell frame, registered into the built-in 'root' slot:
 * DSH sidebar (its "工作区" region seats the Matou task tree, see
 * TaskSidebarSeat) | stage (scene tabs, an optional drill-layer breadcrumb,
 * and the S3b sibling-session carousel replacing the old session strip +
 * side-by-side panes) | details. Reads come through framework hooks
 * (sessions, workspaces, org mirror, nav memory, carousel drill layer);
 * writes go through the injected workbench actions. The carousel's current
 * layer (`level.parentBySceneId`) is deliberately unpersisted React state —
 * see `carousel/level-store.ts`'s module doc — and the DSH "staged" set
 * (multi-stage patch) is kept in sync with whatever the carousel's
 * virtualized render window actually mounts (`onRenderWindowChange` below).
 * Otherwise pure apart from the sync hook that reconciles navigation with
 * DSH's current session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { Breadcrumb } from './carousel/Breadcrumb.tsx'
import type { CardModel } from './carousel/CardShell.tsx'
import { Carousel } from './carousel/Carousel.tsx'
import type { CompactCardMenuProps } from './carousel/CompactCardHeader.tsx'
import { aggregateChildState, forkReadyFromBlank } from './carousel/header-seats.tsx'
import { childrenOfLevel } from './carousel/graph.ts'
import type { CarouselNode } from './carousel/graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from './carousel/nodes.ts'
import { computeColumns, DETAILS_DEFAULT, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import { DesktopChrome, desktopChromeBridge } from './DesktopChrome.tsx'
import { DocumentTitle } from './DocumentTitle.tsx'
import { locateSession } from './nav/navigation.ts'
import { readLevelGeometry } from './carousel/geometry-store.ts'
import { interactionCommits } from './carousel/interaction-commit.ts'
import { levelFocusTargetOf } from './carousel/level-focus.ts'
import { useWindowAttention } from './notifications/attention.ts'
import { deriveNotificationEvents } from './notifications/derive.ts'
import type {
  LocateSession, NotificationSnapshot, SessionLifecycleSnapshot, SessionLocation, SessionsSnapshot,
} from './notifications/derive.ts'
import { sessionHasUnread } from './notifications/selectors.ts'
import type { createLayoutStore } from './stores.ts'
import { sessionDotState } from './workbench/status.ts'
import { useWorkbenchSync } from './workbench/useWorkbenchSync.ts'
import { useWorkbenchActions, useWorkbenchView } from './workbench/useWorkbenchView.ts'
import type { WorkbenchInjected } from './workbench/face.ts'
import css from './AppFrame.module.css'
import wb from './workbench/workbench.module.css'

/** Full composed props: runtime share + child-slot render share + store share + workbench face. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & InjectFace<WorkbenchInjected>
  & PropsLocale<'matou'>

/** `locate()`'s fallback for a session the org-derived view cannot place (derive.ts rule 5). */
const NOWHERE_LOCATION: SessionLocation = { workspaceId: null, taskId: null, sceneId: null }

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode; overlayWidth?: number | undefined }) {
  return <div className={css.detailsCol} data-details-overlay={props.overlayWidth ? true : undefined} style={props.overlayWidth ? { position: 'absolute', right: 0, top: 0, bottom: 0, width: props.overlayWidth, zIndex: 30, background: 'var(--surface, #fff)', boxShadow: '-8px 0 28px #0002' } : undefined}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The stage frame (see module doc). */
export function AppFrame(props: AppFrameProps) {
  const {
    useStore, useSessionPendingInteraction, useSessionLifecycle, actions, renderSlot, t,
    pushNotification, useNotifications, useReveal, dismissSessionIndicator,
  } = props
  const panels = useStore(s => s)
  const pending = useSessionPendingInteraction(s => s)
  const { sessions, org, view, active, level, archivedSessionIds } = useWorkbenchView(props)
  const workbenchActions = useWorkbenchActions(props)
  const current = sessions.current

  // --- S5 notifications (Task 5): the read side of the store Task 4 feeds,
  // for the four-level lighting rules (spec §5's 点亮层级 row — card ring,
  // scene tab dot, task badge; the workspace row is deliberately NOT lit,
  // see `notifications/selectors.ts`'s module doc). ONE hook call here
  // regardless of how many cards/scenes render this pass — the per-session
  // predicate below is a plain array scan (`selectors.ts`), not a hook, so
  // running it once per card in the `cards` projection never varies this
  // component's own hook-call count.
  const notificationRecords = useNotifications(s => s.notifications)

  // --- S4 Task 8 (裁定 T-5): the per-scene forced-recenter counter
  // (`carousel/reveal-store.ts`). Read here rather than inside
  // `useWorkbenchView` because it has exactly one consumer — the `Carousel`
  // element below — same as `useNotifications` above. Selecting the whole
  // record (not `[sceneId]`) keeps the selector free of a value that changes
  // on every tab switch; the record's identity only moves when a reveal is
  // actually requested.
  const revealByScene = useReveal(s => s.bySceneId)

  // --- S5 notifications (Task 4): diff DSH's own global session state into
  // the notification store on every change. `pending`/`sessions` are the
  // GLOBAL standard props above — never filtered to the active scene, so a
  // notification survives navigating away from wherever it fired.
  // `locate()` reuses the same org-derived placement lookup
  // `workbench/actions.ts`'s `locationOf` calls (`nav/navigation.ts`'s
  // `locateSession`), falling back to the shared all-null `SessionLocation`
  // for a session the view cannot place (derive.ts rule 5).
  // `prevNotificationSnapshot` starts `undefined`, the ONLY value
  // `deriveNotificationEvents` reads as "no prior observation yet"
  // (Ruling-S5-6) — every later run hands it the real previous snapshot,
  // even a genuinely empty one, so a transition out of "no sessions at all"
  // still produces its notification instead of being swallowed as "first".
  const sessionsSnapshot = useMemo<SessionsSnapshot>(() => {
    const result: Record<string, SessionLifecycleSnapshot> = {}
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary === undefined) continue
      result[id] = {
        running: summary.running,
        ...(summary.completed === undefined ? {} : { completed: summary.completed }),
        displayTitle: summary.displayTitle,
        // 派生规则 8 要读它。这里**只是把 DSH 已知的事实原样带过去**，判定留在
        // `derive.ts`——第三轮走查里子代理跑完会在通知中心多出一条
        // 「未知工作区 / 未知事项」，就是因为这个快照当时是 `sessions.ids` 全集。
        ...(summary.origin === undefined ? {} : { origin: summary.origin }),
      }
    }
    return result
  }, [sessions])
  const locate = useCallback<LocateSession>(
    sessionId => locateSession(view, sessionId) ?? NOWHERE_LOCATION,
    [view],
  )
  const notificationSnapshot = useMemo<NotificationSnapshot>(
    () => ({ pending, sessions: sessionsSnapshot }),
    [pending, sessionsSnapshot],
  )
  const documentTitle = current === undefined ? undefined : sessions.byId[current]?.title
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  useWorkbenchSync({ view, active, currentSessionId: current, actions: workbenchActions })

  // --- Card carousel (S3b): the active scene's sessions as one graph, the
  // current drill layer's children as cards. See graph.ts for
  // effectiveParentOf/childrenOfLevel; see the field-mapping comment below
  // for the CarouselNode projection's honest DSH approximation.
  const sceneId = active.scene?.id
  /** This tab's own reveal request (S4 Task 8); other tabs' requests are none of this strip's business. */
  const revealRequest = sceneId === undefined ? undefined : revealByScene[sceneId]
  const explicitParentId = sceneId === undefined ? undefined : level.parentBySceneId[sceneId]
  const placementsBySession = useMemo(
    () => placementsBySessionOf(org.org.placements),
    [org.org.placements],
  )
  /** 已提交的排序键（`org/model.ts` 的 `interactionAt`）；缺席的会话退回 DSH 的 live 值。 */
  const interactionAtBySession = useMemo(
    () => new Map(org.org.placements.flatMap(placement => (
      placement.interactionAt === undefined ? [] : [[placement.sessionId, placement.interactionAt] as const]
    ))),
    [org.org.placements],
  )
  const pendingIds = useMemo(() => new Set(pending.keys()), [pending])
  /**
   * The active scene's sessions through the SHARED projection
   * (`carousel/nodes.ts`, Ruling-20) — the same one `header-seats.tsx` and
   * `workbench/actions.ts` read, so a card's badge count, its drill target,
   * and the fork dialog's same-layer name check cannot disagree.
   *
   * Field-mapping decision (Task 2 left this open; settled in Task 10's
   * report §8, refined by the final review's I1): DSH's `SessionSummary`
   * carries one `updatedAt`, not 码头's split `lastInteractionAt` (bumped
   * only when focus LEAVES a card, per `SessionCarousel.tsx`'s
   * reorder-on-blur rule) / `createdAt` (a creation sequence). The
   * projection maps a never-interacted (blank) session to `0` so a new card
   * lands rightmost as 码头's does, and otherwise falls back to `updatedAt`
   * — still NOT the same signal, since it advances on every mutation, so a
   * DSH card can jump ahead of a sibling the user is still looking at,
   * something 码头 never does (spec §3 "排序提升延迟到焦点离开该卡才生效").
   * `createdAt` has no DSH source at all; `ref.ordinal` (the scene's stable
   * placement-insertion order from `deriveOrgView`, ultimately
   * `MatouPlacement.sortKey`) stands in — monotonic per scene, stable across
   * renders, and exactly the "which came first" tie-break `orderSiblings`
   * needs. Net effect: MRU reordering here can still feel more
   * immediate/aggressive than 码头's.
   */
  const allNodes: CarouselNode[] = useMemo(() => {
    const refs = active.scene?.sessions ?? []
    const ordinals = new Map(refs.map(ref => [ref.sessionId, ref.ordinal]))
    return projectCarouselNodes({
      ids: refs.map(ref => ref.sessionId),
      summaryOf: id => sessions.byId[id as never],
      placementsBySession,
      archivedIds: archivedSessionIds,
      ordinalOf: id => ordinals.get(id) ?? 0,
      interactionAtOf: id => interactionAtBySession.get(id),
      manualOrderOf: id => org.org.placements.find(row => row.sessionId === id)?.manualOrder,
    })
  }, [active.scene, sessions, placementsBySession, archivedSessionIds, interactionAtBySession, org.org.placements])
  const nodesById = useMemo(() => new Map(allNodes.map(node => [node.sessionId, node])), [allNodes])
  const currentNode = current === undefined ? undefined : nodesById.get(current)

  // I5, rule 1 (码头 `SessionCanvas.tsx:43-46`, ported verbatim): with NO
  // explicit layer, the layer IS the focused session's own parent — derived
  // every render, never written back. The layer is memory-only by design
  // (spec §3) while the focused session is persisted per tab, so this is
  // precisely the state a reload lands in; without it the root layer renders
  // with no focused card at all (`Cmd+]` returns early on `idx < 0`, and the
  // details column follows a session nowhere on screen). An explicit layer —
  // `null` for the root, an id for a drilled one — always wins, and is NOT
  // the same as "unset": see `level-store.ts`'s three-state contract.
  const parentId = explicitParentId === undefined ? currentNode?.parentId : explicitParentId ?? undefined
  const currentLevelNodes = useMemo(() => childrenOfLevel(allNodes, parentId), [allNodes, parentId])

  // I5, rule 2 (码头 `SessionCanvas.tsx:59`): inside an EXPLICIT layer the
  // layer does not move — the focus does. A user who drilled in stays there;
  // if the focused session is elsewhere, this layer picks one.
  //
  // WHICH one is `level-focus.ts`'s job, and the third live walkthrough
  // (2026-09-07) is why it exists: this used to be `currentLevelNodes[0]`
  // unconditionally, so切走页签再切回来焦点总是落回第一张——而每一层的存档里
  // 明明记着上次聚焦的是谁，只是全仓没人读它。
  const persistedFocus = sceneId === undefined
    ? undefined
    : readLevelGeometry(sceneId, parentId)?.focusedSessionId
  const levelFocusTarget = levelFocusTargetOf({
    explicitParentId,
    currentSessionId: current,
    currentParentId: currentNode?.parentId,
    parentId,
    levelSessionIds: currentLevelNodes.map(node => node.sessionId),
    persistedFocusedSessionId: persistedFocus,
  })
  useEffect(() => {
    if (levelFocusTarget === undefined) return
    workbenchActions.openSession(levelFocusTarget)
  }, [levelFocusTarget, workbenchActions])
  /**
   * 「聚焦即已读」的第二个条件（S3c Task 6）：那个会话得**真的在用户眼前**。
   *
   * 码头的判据是 `active && visible`，化简后就是「是聚焦卡 **且** 它所在页
   * 签就是当前页签」——`HierarchyShell.tsx:1121` 的 `|| isFocused` 让
   * cardVisible 对聚焦卡不起作用，所以这一半与渲染窗口、横向滚动都无关，
   * 只与「这张卡在不在当前显示的这一层」有关。
   *
   * 只比对会话 id 相等会漏判一种真实情形：用户显式下钻到某个会话的子层而
   * 那层是空的（界面上写着「当前画布没有活跃会话」），DSH 的当前会话仍是上
   * 一层那个，它这时请求审批，用户什么都收不到——通知被当作「你已经看见
   * 了」直接标成已读且静音。
   */
  const focusedSessionIsOnScreen = current !== undefined
    && (active.scene === undefined
      // 还没有任何 Matou 现场（组织数据在加载，或者根本没有工作区）时，下面
      // 走的是 fallback 分支：DSH 自己的 conversation 座位照常挂着当前会话，
      // 用户看得见它——这一路不该被判成「不在眼前」。
      || currentLevelNodes.some(node => node.sessionId === current))
  const windowAttentive = useWindowAttention()
  const focusedVisibleSessionId = focusedSessionIsOnScreen && windowAttentive ? current : undefined
  /**
   * spec §7.1 第 5 条的「**正在操作的卡不跳位**」（第三轮活体走查抓到它没实现）。
   *
   * 判定全在 `interactionCommits` 里，这里只做三件事：把本页签每张卡的 live 值与
   * 已提交值凑成一对、把结果写回落位文档、以及**不重复写**——`inFlight` 挡的是
   * 「写入 → org 刷新 → 本副作用重跑 → 又写一次」这条自激回路。
   *
   * 写落位文档而不是留在内存里，是为了让控制面（`control/topology.ts`）读到同一
   * 个排序键；否则聚焦期间宿主与屏幕的序号会分叉，「AI 说的第 3 张」就不是用户
   * 看到的第 3 张了。
   */
  const commitInFlight = useRef(false)
  useEffect(() => {
    if (commitInFlight.current) return
    const commits = interactionCommits({
      focusedSessionId: current,
      sessions: allNodes.map(node => ({
        sessionId: node.sessionId,
        placed: placementsBySession.has(node.sessionId),
        liveInteractionAt: sessions.byId[node.sessionId as never]?.blank === true
          ? 0
          : sessions.byId[node.sessionId as never]?.updatedAt ?? 0,
        committedAt: interactionAtBySession.get(node.sessionId),
      })),
    })
    if (commits.length === 0) return
    commitInFlight.current = true
    void workbenchActions.commitInteractions(commits)
      .catch((error: unknown) => { console.error('matou-layout: commit interaction failed', error) })
      .finally(() => { commitInFlight.current = false })
  }, [allNodes, current, sessions, placementsBySession, interactionAtBySession, workbenchActions])

  const prevNotificationSnapshot = useRef<NotificationSnapshot | undefined>(undefined)
  useEffect(() => {
    const prev = prevNotificationSnapshot.current
    prevNotificationSnapshot.current = notificationSnapshot
    for (const event of deriveNotificationEvents(prev, notificationSnapshot, focusedVisibleSessionId, locate)) {
      pushNotification(event)
    }
  }, [notificationSnapshot, focusedVisibleSessionId, locate, pushNotification])

  const cards: CardModel[] = useMemo(() => currentLevelNodes.map((node) => {
    const summary = sessions.byId[node.sessionId as never]
    const state = sessionDotState({
      running: summary?.running ?? false,
      completed: summary?.completed,
      pending: pending.has(node.sessionId as never),
    })
    const childState = aggregateChildState(
      sessions, node.sessionId, placementsBySession, pendingIds, archivedSessionIds,
    )
    // S5 Task 5: one boolean per card — 码头's own card summary carries the
    // same single signal for both the ring and the "新通知" pill (see
    // `TerminalPane.tsx`'s single `hasNotification`), never a count.
    const unread = sessionHasUnread(notificationRecords, node.sessionId)
    return {
      sessionId: node.sessionId,
      title: summary?.displayTitle ?? t('session.untitled'),
      ...(state === undefined ? {} : { state }),
      hasNotice: unread,
      hasRing: unread,
      childCount: childrenOfLevel(allNodes, node.sessionId).length,
      ...(childState === undefined ? {} : { childState }),
      focused: node.sessionId === current,
      // D2 (S3b Task 11c): a focused card over a blank (never-had-a-turn)
      // session must still show the compact header — see CardShell's module
      // doc. `summary` missing is honestly "not blank" (no signal either way).
      blank: summary?.blank ?? false,
    }
  }), [
    currentLevelNodes, sessions, pending, placementsBySession, pendingIds, archivedSessionIds, allNodes, current, t,
    notificationRecords,
  ])

  const cardMenuFor = useCallback((sessionId: string): CompactCardMenuProps => {
    const parent = nodesById.get(sessionId)?.parentId
    const childTitles = childrenOfLevel(allNodes, sessionId)
      .map(node => sessions.byId[node.sessionId as never]?.displayTitle ?? '')
    const siblingTitles = childrenOfLevel(allNodes, parent)
      .map(node => sessions.byId[node.sessionId as never]?.displayTitle ?? '')
    return {
      actions: workbenchActions,
      renameSession: workbenchActions.renameSession,
      canForkSibling: parent !== undefined,
      selfRunning: sessions.byId[sessionId as never]?.running === true,
      parentRunning: parent !== undefined && sessions.byId[parent as never]?.running === true,
      // D4 (S3b Task 11d): the other half of "未就绪" besides running — see `forkReadyFromBlank`'s doc.
      selfForkReady: forkReadyFromBlank(sessions.byId[sessionId as never]?.blank),
      parentForkReady: parent === undefined || forkReadyFromBlank(sessions.byId[parent as never]?.blank),
      childTitles,
      siblingTitles,
    }
  }, [nodesById, allNodes, sessions, workbenchActions])

  const renderPane = useCallback(
    (sessionKey: string) => renderSlot('main', {}, { entryKey: 'conversation', sessionKey }),
    [renderSlot],
  )

  // Render window -> DSH "staged" set (multi-stage patch): pin every session
  // the carousel's virtualized window actually mounts, unpin whatever leaves
  // it. A ref (not React state) because this is a pure side-channel to DSH's
  // own service, not something AppFrame's own render depends on.
  const stagedRef = useRef<Set<string>>(new Set())
  const actionsRef = useRef(workbenchActions)
  actionsRef.current = workbenchActions
  const onRenderWindowChange = useCallback((ids: readonly string[]) => {
    const next = new Set(ids)
    for (const id of stagedRef.current) if (!next.has(id)) actionsRef.current.unpinSession(id)
    for (const id of next) if (!stagedRef.current.has(id)) actionsRef.current.pinSession(id)
    stagedRef.current = next
  }, [])
  // Leaving every scene (no active task/scene) unmounts the carousel outright
  // without a final onRenderWindowChange([]) — clear the stage explicitly.
  useEffect(() => {
    if (sceneId !== undefined) return
    for (const id of stagedRef.current) actionsRef.current.unpinSession(id)
    stagedRef.current = new Set()
  }, [sceneId])
  useEffect(() => () => {
    for (const id of stagedRef.current) actionsRef.current.unpinSession(id)
  }, [])

  // 「换会话就自动收起右栏」这条副作用**在 0.1.5 起删掉了**。
  //
  // 它是 `details`（session 作用域）时代的：那一栏装的是「当前会话的某条工具
  // 调用详情」，换了会话内容就失效，收起来是对的。0.1.5 把它换成根作用域的
  // `rightbar`，占位者 `ui-sidebar-right` 自己按会话管里面的停靠面，本框架
  // 再去替它开合就是越界。
  //
  // 在本插件里这一条尤其要命：轮播的日常操作就是不停切卡，每切一次就把用户
  // 停靠好的文件面板收起来，等于这一栏没法用。

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (stores.ts).
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  // 0.1.5 起右栏是**根作用域**（`rightbar`），开合只由 `ctx.layout` 的
  // openRightbar/closeRightbar 决定，不再「没有当前会话就强制收起」——
  // 那条门是旧的 `details`（session 作用域）留下的，那时无会话渲染它是非法的。
  // 是否可以打开由可用空间决定，与当前是否关闭无关；窄窗用浮层。
  const cols = computeColumns(viewport, sidebarPreference, panels.details)
  // Availability is independent of whether the panel is currently closed.
  const availableDetails = computeColumns(viewport, sidebarPreference, panels.details || DETAILS_DEFAULT).details
  const previewWidth = availableDetails || Math.min(panels.details || DETAILS_DEFAULT, Math.max(1, viewport - 16))
  const colsRef = useRef(cols)
  colsRef.current = cols

  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild' as never)

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
      data-integrated-chrome={desktopChromeBridge()?.integratedTitlebar || undefined}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <DesktopChrome width={cols.sidebar} />
      <DocumentTitle
        productTitle={productTitle}
        {...documentTitle === undefined ? {} : { title: documentTitle }}
      />
      <div className={css.sidebarCol}>
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: cols.sidebar,
        })}
      </div>
      <CenterColumn>
        {active.scene === undefined
          ? (
            <>
              <div className={wb.strip} role="status"><span className={wb.stripEmpty}>{t('scene.empty')}</span></div>
              {/* No Matou scene resolved yet (org still loading, or genuinely
                  no workspace) — DSH's own session-maybe conversation shell
                  still owns whatever DSH's current session is, unmanaged by
                  the carousel; the 'conversation' slot stays mounted with
                  its stable, unkeyed identity exactly as it always has (see
                  index.ts's 'conversation' slot doc). */}
              <div className={wb.fallbackPane}>{renderSlot('main', {}, { entryKey: 'conversation' })}</div>
            </>
          )
          : (
            <>
              {parentId !== undefined && (
                <Breadcrumb
                  parentTitle={sessions.byId[parentId as never]?.displayTitle ?? t('session.untitled')}
                  count={currentLevelNodes.length}
                  onReturnToParent={() => { workbenchActions.returnToParent(active.scene!.id) }}
                  t={t}
                />
              )}
              {cards.length === 0 && (
                // M1: the old SessionStrip's empty-canvas copy has no other
                // home now — an empty layer (root with no sessions yet, or a
                // drilled layer whose last child just got removed) would
                // otherwise render a bare, contentless carousel region.
                <div className={wb.strip} role="status"><span className={wb.stripEmpty}>{t('session.empty')}</span></div>
              )}
              <Carousel
                cards={cards}
                onReorder={ids => workbenchActions.reorderCards?.(ids) ?? Promise.resolve()}
                sceneId={active.scene.id}
                parentId={parentId}
                // S4 Task 8: `revealSession`'s forced re-center, the only way
                // a click naming the ALREADY-focused session moves the strip.
                {...(revealRequest === undefined ? {} : { revealRequest })}
                onFocus={id => { workbenchActions.openSession(id) }}
                // S5 Task 8 (码头 `TerminalPane.tsx:314`): pressing a card
                // deletes that session's notifications outright. Straight off
                // the face — this is the store's imperative write, not one of
                // `WorkbenchActions`' org/session operations.
                onDismissNotifications={dismissSessionIndicator}
                onReturnToParent={parentId === undefined ? undefined : () => { workbenchActions.returnToParent(active.scene!.id) }}
                renderPane={renderPane}
                cardMenu={cardMenuFor}
                useSessionLifecycle={useSessionLifecycle}
                onRenderWindowChange={onRenderWindowChange}
                t={t}
              />
            </>
          )}
      </CenterColumn>
      <DetailsColumn overlayWidth={panels.details > 0 && cols.details === 0 ? previewWidth : undefined}>
        {/* 0.1.5 起这一栏是根作用域（`rightbar`），不再按会话绑定——
            占位者 `ui-sidebar-right` 自己管每个会话的停靠面。 */}
        {renderSlot('rightbar', { width: previewWidth, viewportWidth: viewport, canShow: true })}
      </DetailsColumn>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
