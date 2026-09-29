/**
 * Behavior orchestration for the card carousel: wires the pure geometry
 * (Task 3), edge-browse (Task 4), render-window (Task 5), and geometry
 * persistence (Task 6) modules to refs/effects/events, ported from 码头
 * `SessionCarousel.tsx`, plus the FLIP reorder animation
 * (`SessionCarousel.tsx:232-257`) and the `Cmd/Ctrl+]`/`[` pane-cycle
 * (码头 `useTerminalShortcuts.ts` + `HierarchyShell.tsx`'s `focusPane`), plus
 * 码头's reveal-request forced re-center (`SessionCarousel.tsx:349-387`,
 * added by S4 Task 8 — see {@link UseCarouselControllerOptions.revealRequest}).
 * Scope is still deliberately narrower than 码头's full component: no
 * parent-pull spring/gesture (`ParentPullController`) and no narrow-viewport
 * compact summary — both out of S3b Task 9's scope. See the module doc in
 * `Carousel.tsx` for the DOM this wires into.
 *
 * Every DOM-shaped value the controller touches is narrowed to the minimal
 * structural interface it actually reads/writes ({@link CarouselViewport},
 * {@link CarouselCardMeasure}, and the `*Like` event interfaces below). A
 * real `HTMLElement`/React synthetic event satisfies these structurally, so
 * production wiring needs no casts — and a test can inject a plain object
 * standing in for layout jsdom cannot produce (`offsetLeft`/`offsetWidth`/
 * `scrollWidth` are permanently 0 there). This is the "measurement
 * stand-in" this module's tests rely on instead of patching jsdom.
 * @module dsh-plugin-matou-layout/src/client/carousel/useCarouselController
 */
import { useLayoutEffect, useRef, useState } from 'react'
import {
  anchoredCardScrollLeft, CARD_EDGE_INSET, centeredCardScrollLeft, FLIP_MS, FOLLOW_MS, FOLLOW_STEP_MAX_PX,
  fullyVisibleCardScrollLeft, HOVER_RESTORE_MS, SETTLE_TOLERANCE, visibleColumnsForWidth,
} from './geometry.ts'
import {
  advanceEdge, EDGE_BROWSE_INTERVAL_MS, EDGE_INTENT_DWELL_MS, edgeDirectionAt, nearestHiddenCard,
} from './edge-browse.ts'
import type { EdgeDirection, EdgePhase, EdgeState } from './edge-browse.ts'
import { cardIndexAt } from './card-layout.ts'
import { computeRenderWindow, estimatedCardOffset, updateVisibleWindow } from './window.ts'
import { readLevelGeometry, writeLevelGeometry } from './geometry-store.ts'
import type { LevelGeometry } from './geometry-store.ts'

/** Quiet time, in ms, after the last scroll event before the render window is re-derived from `scrollLeft`. */
const SCROLL_SETTLE_MS = 150
/** Debounce, in ms, before a scroll-position change is persisted via {@link writeLevelGeometry}. */
const GEOMETRY_WRITE_DEBOUNCE_MS = 180
/** Pointer movement, in px from the pointerdown origin, before a drag is treated as a horizontal pan. */
const DRAG_THRESHOLD_PX = 3
/** Selector for elements a carousel-level pointerdown/keydown must not hijack (native controls own their own gestures). */
const INTERACTIVE_SELECTOR = 'button,input,textarea,select,a,nav,[role="navigation"],[role="menuitem"]'
const EDITABLE_SELECTOR = 'input,textarea,select,[contenteditable="true"]'

/** A mutable box the controller reads/writes through — structurally identical to React's `MutableRefObject<T>`. */
export interface CarouselRef<T> { current: T }

/**
 * What the controller reads/writes on the scrolling viewport element. Any
 * `HTMLElement` satisfies this structurally (assign it via a ref callback,
 * not the `ref` prop directly — see {@link CarouselController}'s doc);
 * tests inject a plain object instead of a real DOM node.
 */
export interface CarouselViewport {
  scrollLeft: number
  readonly clientWidth: number
  readonly scrollWidth: number
  getBoundingClientRect(): { readonly left: number; readonly right: number }
}

/**
 * What the controller reads on one card's slot element (its position within
 * the scroll track), plus the two Web Animations API methods the FLIP
 * reorder effect uses. `animate`/`getAnimations` are optional and
 * feature-detected at every call site — jsdom implements neither (real
 * browsers do), and a test's plain measurement stand-in need not either.
 */
export interface CarouselCardMeasure {
  readonly offsetLeft: number
  readonly offsetWidth: number
  /** Cancels this card's in-flight animations, if any (called before re-measuring so a mid-flight FLIP doesn't skew the reading). */
  getAnimations?(): readonly { cancel(): void }[]
  /** Starts the FLIP reflow animation on this card. */
  animate?(keyframes: Keyframe[], options: { duration: number; easing: string }): unknown
}

interface CarouselWheelLike {
  readonly deltaX: number
  readonly deltaY: number
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  preventDefault(): void
}

interface CarouselPointerLike {
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
  readonly button: number
  readonly target: unknown
  readonly currentTarget: unknown
}

interface CarouselTransitionLike {
  readonly propertyName: string
  readonly target: unknown
  readonly currentTarget: unknown
}

interface CarouselKeyLike {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly target: unknown
  preventDefault(): void
}

export interface UseCarouselControllerOptions {
  /** The scene (workbench tab) this level belongs to; keys geometry persistence. */
  sceneId: string
  cardWidths?: readonly number[]
  interactionLocked?: boolean
  /** The level's parent session id; `undefined` selects the scene's root level. */
  parentId: string | undefined
  /** Session ids in this level, in display order. */
  nodes: readonly string[]
  focusedSessionId: string | undefined
  /**
   * The latest EXPLICIT navigation request for this scene
   * (`carousel/reveal-store.ts`, written by `workbench/actions.ts`'s
   * `revealSession`). Its `seq` — not its `sessionId` — is the signal: see
   * the reveal effect below for why the id alone cannot work.
   */
  revealRequest?: { readonly sessionId: string; readonly seq: number }
  /** Called with a sibling's session id when `Cmd/Ctrl+]`/`[` cycles focus. */
  onFocus: (sessionId: string) => void
  /** Called when `ArrowLeft`/`ArrowUp` requests returning to the parent level; `undefined` at the root (no-op). */
  onReturnToParent: (() => void) | undefined
  viewportRef: CarouselRef<CarouselViewport | null>
  cardRefs: CarouselRef<Map<string, CarouselCardMeasure>>
  /**
   * Injectable clock for the follow-loop deadlines; defaults to `performance.now`.
   * Tests pass `Date.now` so `vi.useFakeTimers()` advances it in lockstep with the
   * stubbed `requestAnimationFrame`/`setTimeout` callbacks it schedules against.
   */
  now?: () => number
  /**
   * Overrides platform detection for the `Cmd/Ctrl+]`/`[` shortcut's modifier
   * key; defaults to sniffing `navigator.platform`/`userAgent`. jsdom reports
   * the *host OS* there (e.g. `darwin`, not `Mac`), so tests should pass this
   * explicitly rather than relying on the sniff resolving the way the test
   * author expects.
   */
  isMac?: boolean
}

export interface CarouselController {
  visibleCount: number
  renderWindow: { start: number; count: number }
  edgePhase: EdgePhase
  /** The non-focused card currently previewed (hovered, or reached by edge-browse cruise), if any. */
  hoveredSessionId: string | undefined
  /** Registers (or, on `null`, unregisters) one card's measured slot element — attach via a ref callback. */
  registerCard: (sessionId: string, element: CarouselCardMeasure | null) => void
  onScroll: () => void
  /** A card's width transition ended — the discrete moment the render window is re-derived from `scrollLeft`. */
  onCardTransitionEnd: (event: CarouselTransitionLike) => void
  onWheel: (event: CarouselWheelLike) => void
  onPointerEnter: (event: CarouselPointerLike) => void
  onPointerDown: (event: CarouselPointerLike) => void
  onPointerMove: (event: CarouselPointerLike) => void
  onPointerUp: (event: CarouselPointerLike) => void
  /**
   * Whether the press in flight has already crossed {@link DRAG_THRESHOLD_PX}
   * into a strip drag. Not a render input (it is a ref read, deliberately not
   * state — nothing about the view depends on it): it exists so a caller can
   * tell "the user clicked this card" from "the user grabbed the strip here
   * and pulled", two gestures that begin with the identical `pointerdown`.
   * `Carousel.tsx`'s notification dismiss is the one thing that has to care.
   */
  isDragging: () => boolean
  onPointerLeave: () => void
  onCardEnter: (sessionId: string) => void
  /**
   * Identical to {@link onPointerLeave} (码头 has no per-card `mouseleave` —
   * only the whole-viewport `onPointerLeave` calls `hover(null)`, see
   * `SessionCard.tsx`). `Carousel.tsx` wires `onPointerLeave` on the
   * viewport and does not reach this one in production; it exists so a
   * test exercising the hook directly can call "leave the strip" without
   * also having to name `onPointerLeave` — call either, they do the same thing.
   */
  onCardLeave: () => void
  /**
   * Handles `Cmd/Ctrl+]`/`[` (cycle focus) and `ArrowLeft`/`ArrowUp` (return
   * to parent). Wire this to the carousel *component's* `onKeyDown` (bubble
   * phase) — deliberately **not** a `document.addEventListener(..., true)`
   * global capture the way 码头's `useTerminalShortcuts.ts` does it. 码头 is
   * an Electron-only app, free to own the whole window's keydown stream; DSH
   * is a Web host plugin sharing the page with other shortcuts, so capturing
   * globally risks fighting the host's own bindings. Component-level bubbling
   * still reaches every real keypress this needs: a session's chat input
   * lives inside a card, i.e. inside the carousel subtree, so a keydown
   * typed there bubbles up through this handler regardless.
   */
  onKeyDown: (event: CarouselKeyLike) => void
}

/**
 * Duck-typed `Element.closest()` check over an event's `target`/`currentTarget`
 * (typed `unknown` at call sites — see the module doc's "measurement
 * stand-in" note). Exported so `Carousel.tsx`'s own pointerdown/focus-capture
 * activation guard (码头 `SessionCard.tsx`'s button/menuitem exclusion) reuses
 * the exact same check this module already relies on, rather than a second
 * copy.
 */
export function closestMatches(target: unknown, selector: string): boolean {
  if (target === null || typeof target !== 'object') return false
  const el = target as { closest?: (sel: string) => unknown }
  return typeof el.closest === 'function' && el.closest(selector) !== null
}

function capturePointer(target: unknown, pointerId: number, capture: boolean): void {
  if (target === null || typeof target !== 'object') return
  const el = target as { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void }
  if (capture) el.setPointerCapture?.(pointerId)
  else el.releasePointerCapture?.(pointerId)
}

/** `prefers-reduced-motion: reduce`, tolerant of jsdom's default lack of `matchMedia`. */
function reducedMotionPreferred(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Whether the host is macOS — Cmd vs Ctrl for the `]`/`[` shortcut, ported from 码头 `useTerminalShortcuts.ts`. */
const IS_MAC_DEFAULT = typeof navigator !== 'undefined'
  && (/Mac/.test(navigator.platform ?? '') || /Mac/.test(navigator.userAgent ?? ''))

const IDLE_EDGE_STATE: EdgeState = { phase: 'idle', direction: 'none', since: 0 }

interface DragGesture {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly initialScrollLeft: number
  active: boolean
}

/**
 * Wires 码头's carousel geometry/edge-browse/render-window/persistence math
 * to refs, `requestAnimationFrame` loops, and pointer/wheel/keyboard events.
 * See the module doc for the injectable-measurement design that keeps this
 * testable without a real jsdom layout.
 */
export function useCarouselController(options: UseCarouselControllerOptions): CarouselController {
  const { sceneId, parentId, nodes, focusedSessionId, onFocus, onReturnToParent, viewportRef, cardRefs } = options
  const optionsRef = useRef(options); optionsRef.current = options
  const nowFn = options.now ?? (() => performance.now())
  const isMac = options.isMac ?? IS_MAC_DEFAULT

  // "Latest value" refs: read by rAF/setTimeout callbacks and event handlers
  // that must not close over a stale render (mirrors AppFrame.tsx's
  // `callbacks.current = {...}` idiom — assigned during render, not an effect).
  const sceneIdRef = useRef(sceneId)
  sceneIdRef.current = sceneId
  const parentIdRef = useRef(parentId)
  parentIdRef.current = parentId
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const focusedSessionIdRef = useRef(focusedSessionId)
  focusedSessionIdRef.current = focusedSessionId
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const onReturnToParentRef = useRef(onReturnToParent)
  onReturnToParentRef.current = onReturnToParent

  const [visibleCount, setVisibleCount] = useState(() => visibleColumnsForWidth(nodes.length, 0))
  const visibleCountRef = useRef(visibleCount)
  visibleCountRef.current = visibleCount

  const initialFocusedIndex = Math.max(0, nodes.findIndex(id => id === focusedSessionId))
  const [firstVisible, setFirstVisible] = useState(() => Math.max(0, initialFocusedIndex - 1))

  const [hoveredSessionId, setHoveredSessionId] = useState<string | undefined>(undefined)
  const [edgePhase, setEdgePhase] = useState<EdgePhase>('idle')

  /**
   * The reveal `seq` this hook has already acted on. Seeded with the request
   * present at MOUNT so a fresh mount does not re-center: first paint belongs
   * to the persisted-geometry restore below (spec §7.1 step 6 "切走再切回位置
   * 不变"), and a request left in the store from an earlier click is not a new
   * instruction. Every LATER seq is honored.
   */
  const appliedRevealSeqRef = useRef(options.revealRequest?.seq)

  const previousFocusedRef = useRef(focusedSessionId)
  // Read (never written here) so `renderWindow` reflects "focus just moved"
  // for *this* render, before the focus-follow effect below updates it.
  const focusChangedForRender = previousFocusedRef.current !== focusedSessionId

  const geometryWriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The debounced write's captured key + value; see {@link scheduleGeometryWrite}. */
  const pendingGeometryRef = useRef<
    { sceneId: string; parentId: string | undefined; geometry: LevelGeometry } | undefined
  >(undefined)
  const skipNextFocusFollowRef = useRef(false)

  /**
   * 正在被动画追踪的那张卡。只要它有值，渲染窗口就钉在它身上、不跟随滚动漂移——
   * 没有这道闸门，「滚动 → 换一批挂载的卡 → 目标卡 DOM 重建 → 目标位置又变」会让
   * 追踪永不收敛（2026-09-14 桌面端走查：17 张卡开机即 120% CPU、内存 6 GB、白屏，
   * JS 侧毫无报错，因为循环全花在重新挂载与重排上）。
   */
  const followSessionRef = useRef<string | undefined>(undefined)
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverBaselineRef = useRef<number | undefined>(undefined)
  const hoverRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverFollowFrameRef = useRef<number | undefined>(undefined)
  const hoverFollowSessionRef = useRef<string | undefined>(undefined)
  const focusFollowFrameRef = useRef<number | undefined>(undefined)
  const focusFollowSessionRef = useRef<string | undefined>(undefined)

  const edgeStateRef = useRef<EdgeState>(IDLE_EDGE_STATE)
  const edgeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const edgeBlockedRef = useRef(false)
  const lastPointerXRef = useRef<number | undefined>(undefined)
  const dragRef = useRef<DragGesture | undefined>(undefined)

  /** Each card's `offsetLeft` as of the last FLIP measurement, keyed by session id — the "First" in FLIP. */
  const previousOffsetsRef = useRef<Map<string, number>>(new Map())

  function currentGeometry(anchorId: string | undefined = focusedSessionIdRef.current): LevelGeometry {
    const viewport = viewportRef.current
    const card = anchorId === undefined ? undefined : cardRefs.current.get(anchorId)
    return {
      scrollLeft: viewport?.scrollLeft ?? 0,
      ...(anchorId === undefined ? {} : { focusedSessionId: anchorId }),
      ...(anchorId !== undefined && viewport && card
        ? { anchorSessionId: anchorId, anchorViewportOffset: card.offsetLeft - viewport.scrollLeft }
        : {}),
    }
  }

  /**
   * Queue this level's geometry for persistence, coalescing a burst of scroll
   * updates into one write. The level's KEY and its measured geometry are
   * captured NOW, not read back when the timer fires (final review I6): the
   * user can switch tabs or drill into another layer inside the 180ms window,
   * and a write that resolved its key at flush time would land the old
   * level's scroll position under the new level's key — or, on unmount,
   * vanish with the cancelled timer. Each call replaces the pending record,
   * so the last position of a burst is still the one that survives.
   */
  function scheduleGeometryWrite(): void {
    pendingGeometryRef.current = {
      sceneId: sceneIdRef.current, parentId: parentIdRef.current, geometry: currentGeometry(),
    }
    if (geometryWriteTimerRef.current !== undefined) clearTimeout(geometryWriteTimerRef.current)
    geometryWriteTimerRef.current = setTimeout(flushGeometryWrite, GEOMETRY_WRITE_DEBOUNCE_MS)
  }

  /** Write any pending geometry immediately, under the key it was captured with. Idempotent. */
  function flushGeometryWrite(): void {
    if (geometryWriteTimerRef.current !== undefined) clearTimeout(geometryWriteTimerRef.current)
    geometryWriteTimerRef.current = undefined
    const pending = pendingGeometryRef.current
    pendingGeometryRef.current = undefined
    if (pending === undefined) return
    writeLevelGeometry(pending.sceneId, pending.parentId, pending.geometry)
  }

  function setScrollLeft(value: number): void {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollLeft = value
    scheduleGeometryWrite()
  }

  function updateVisibleWindowState(): void {
    const viewport = viewportRef.current
    if (!viewport) return
    const widths = optionsRef.current.cardWidths
    const next = widths ? cardIndexAt(widths, viewport.scrollLeft) : updateVisibleWindow(viewport.scrollLeft, viewport.clientWidth, visibleCountRef.current, nodesRef.current.length)
    setFirstVisible(prev => (prev === next ? prev : next))
  }

  /** Cancels an in-flight follow loop (focus-center or hover-expand) without moving the viewport. */
  function cancelFollow(frameRef: CarouselRef<number | undefined>, sessionRef: CarouselRef<string | undefined>): void {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    frameRef.current = undefined
    if (followSessionRef.current === sessionRef.current) followSessionRef.current = undefined
    sessionRef.current = undefined
  }

  /**
   * Runs a rAF loop that nudges `viewport.scrollLeft` toward `computeTarget`'s
   * result, capped at `FOLLOW_STEP_MAX_PX`/frame, for at least `FOLLOW_MS` or
   * until the delta settles under `SETTLE_TOLERANCE` — shared by focus-center
   * (`centeredCardScrollLeft`) and hover-expand (`fullyVisibleCardScrollLeft`).
   */
  function startFollow(
    frameRef: CarouselRef<number | undefined>,
    sessionRef: CarouselRef<string | undefined>,
    sessionId: string,
    computeTarget: (card: CarouselCardMeasure, viewport: CarouselViewport, maxScrollLeft: number) => number,
  ): void {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    sessionRef.current = sessionId
    followSessionRef.current = sessionId
    const deadline = nowFn() + FOLLOW_MS
    const step = () => {
      frameRef.current = undefined
      if (sessionRef.current !== sessionId) return
      const viewport = viewportRef.current
      const card = cardRefs.current.get(sessionId)
      if (!viewport || !card) { sessionRef.current = undefined; return }
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      const target = computeTarget(card, viewport, maxScrollLeft)
      const delta = target - viewport.scrollLeft
      if (Math.abs(delta) > SETTLE_TOLERANCE) {
        setScrollLeft(viewport.scrollLeft + Math.sign(delta) * Math.min(Math.abs(delta), FOLLOW_STEP_MAX_PX))
        // 这里**不**重算渲染窗口：窗口已经被 `followSessionRef` 钉在目标卡上（见
        // `renderWindow` 处的注释）。放开的话，每帧都会换一批挂载的卡片，目标卡的
        // DOM 随之重建、`offsetLeft` 每帧不同，`delta` 永远收敛不了，这段动画就成了
        // 「每帧重新挂载九张会话面板」的死循环。
      }
      if (nowFn() < deadline || Math.abs(delta) > SETTLE_TOLERANCE) {
        frameRef.current = requestAnimationFrame(step)
        return
      }
      sessionRef.current = undefined
      followSessionRef.current = undefined
      // 动画落定，这才把最终位置换算成首个可见卡。
      updateVisibleWindowState()
      scheduleGeometryWrite()
    }
    frameRef.current = requestAnimationFrame(step)
  }

  function startFocusFollow(sessionId: string): void {
    startFollow(focusFollowFrameRef, focusFollowSessionRef, sessionId, (card, viewport, maxScrollLeft) =>
      centeredCardScrollLeft(card.offsetLeft, card.offsetWidth, viewport.clientWidth, maxScrollLeft))
  }

  function startHoverFollow(sessionId: string): void {
    startFollow(hoverFollowFrameRef, hoverFollowSessionRef, sessionId, (card, viewport, maxScrollLeft) =>
      fullyVisibleCardScrollLeft(
        card.offsetLeft, card.offsetWidth, viewport.scrollLeft, viewport.clientWidth, maxScrollLeft, CARD_EDGE_INSET,
      ))
  }

  function clearHoverRestoreTimer(): void {
    if (hoverRestoreTimerRef.current !== undefined) clearTimeout(hoverRestoreTimerRef.current)
    hoverRestoreTimerRef.current = undefined
  }

  /** Applies the remembered pre-hover scroll position; on `finalize`, also clears it (the memory is spent). */
  function restoreHoverBaseline(finalize: boolean): void {
    const baseline = hoverBaselineRef.current
    if (viewportRef.current === null || baseline === undefined) return
    setScrollLeft(baseline)
    updateVisibleWindowState()
    if (finalize) {
      clearHoverRestoreTimer()
      hoverBaselineRef.current = undefined
    }
  }

  /** A deliberate user gesture (activate/wheel/drag/edge-browse) supersedes any pending hover preview. */
  function discardHoverBaseline(): void {
    clearHoverRestoreTimer()
    hoverBaselineRef.current = undefined
    cancelFollow(hoverFollowFrameRef, hoverFollowSessionRef)
  }

  /**
   * Preview `sessionId` (expand it and scroll it fully into view).
   * @param sessionId - the card to preview.
   * @param recordBaseline - whether to remember the pre-hover scroll position
   *   so leaving the strip rolls back to it. False for edge-browsing, which
   *   spec §3 classifies as a baseline-DISCARDING gesture: the advanced
   *   position is the user's deliberate choice, not a transient preview to be
   *   undone. 码头 expresses the same thing by bypassing its `hover()` entry
   *   entirely at that call site (`SessionCarousel.tsx:513-522`).
   */
  function enterHover(sessionId: string, recordBaseline = true): void {
    clearHoverRestoreTimer()
    if (sessionId !== focusedSessionIdRef.current) {
      cancelFollow(focusFollowFrameRef, focusFollowSessionRef)
      if (recordBaseline && hoverBaselineRef.current === undefined) {
        hoverBaselineRef.current = viewportRef.current?.scrollLeft ?? 0
      }
    } else {
      hoverBaselineRef.current = undefined
    }
    setHoveredSessionId(sessionId)
    if (!edgeBlockedRef.current) startHoverFollow(sessionId)
  }

  function leaveHover(): void {
    cancelFollow(hoverFollowFrameRef, hoverFollowSessionRef)
    setHoveredSessionId(undefined)
    restoreHoverBaseline(false)
    clearHoverRestoreTimer()
    hoverRestoreTimerRef.current = setTimeout(() => {
      hoverRestoreTimerRef.current = undefined
      restoreHoverBaseline(true)
    }, HOVER_RESTORE_MS)
  }

  // --- Edge browse -----------------------------------------------------

  function stopEdge(): void {
    if (edgeTimerRef.current !== undefined) clearTimeout(edgeTimerRef.current)
    edgeTimerRef.current = undefined
    edgeStateRef.current = IDLE_EDGE_STATE
    setEdgePhase('idle')
  }

  /**
   * The MOUNTED cards' measured rects in track order, alongside the session
   * ids they belong to. Only mounted cards participate: since C1 the DOM is
   * sliced to the render window, so an out-of-window card has no element and
   * therefore no measurable position — substituting a `{0, 0}` placeholder
   * (as this did before) would make every virtualized-away card look like a
   * card sitting at the very left edge, and `nearestHiddenCard` would
   * "advance" edge-browse onto a card that isn't there. 码头 solves it the
   * same way (`SessionCarousel.tsx:479-482`'s
   * `nodes.flatMap(node => card ? [{node, card}] : [])`), which is why the
   * ids ride along: the returned index addresses `ids`, not `nodes`.
   */
  function mountedCardRects(): { rects: { offsetLeft: number; offsetWidth: number }[]; ids: string[] } {
    const rects: { offsetLeft: number; offsetWidth: number }[] = []
    const ids: string[] = []
    for (const id of nodesRef.current) {
      const card = cardRefs.current.get(id)
      if (card === undefined) continue
      rects.push({ offsetLeft: card.offsetLeft, offsetWidth: card.offsetWidth })
      ids.push(id)
    }
    return { rects, ids }
  }

  function advanceOneHiddenCard(direction: 'left' | 'right'): void {
    const viewport = viewportRef.current
    if (!viewport) { stopEdge(); return }
    const { rects, ids } = mountedCardRects()
    const index = nearestHiddenCard(rects, direction, viewport.scrollLeft, viewport.clientWidth, Math.max(0, viewport.scrollWidth - viewport.clientWidth))
    const targetId = index >= 0 ? ids[index] : undefined
    if (targetId === undefined) { stopEdge(); return }
    // Reaching the edge is explicit browsing, not a transient hover — drop
    // any pending baseline restore, and enter the preview WITHOUT recording a
    // fresh one, so leaving later keeps the advanced position instead of
    // rolling back the step just taken (final review I3).
    discardHoverBaseline()
    enterHover(targetId, false)
  }

  function applyEdgeReading(dir: EdgeDirection): void {
    if (edgeTimerRef.current !== undefined) { clearTimeout(edgeTimerRef.current); edgeTimerRef.current = undefined }
    const now = nowFn()
    const previousPhase = edgeStateRef.current.phase
    const next = advanceEdge(edgeStateRef.current, dir, now, edgeBlockedRef.current)
    edgeStateRef.current = next
    if (next.phase !== previousPhase) setEdgePhase(next.phase)
    if (next.phase === 'confirming') {
      const remaining = Math.max(0, EDGE_INTENT_DWELL_MS - (now - next.since))
      edgeTimerRef.current = setTimeout(() => { edgeTimerRef.current = undefined; applyEdgeReading(dir) }, remaining)
    } else if (next.phase === 'cruising') {
      advanceOneHiddenCard(next.direction === 'none' ? 'right' : next.direction)
      if (edgeStateRef.current.phase === 'cruising') {
        edgeTimerRef.current = setTimeout(() => { edgeTimerRef.current = undefined; applyEdgeReading(dir) }, EDGE_BROWSE_INTERVAL_MS)
      }
    }
  }

  function trackPointer(event: CarouselPointerLike): EdgeDirection {
    const viewport = viewportRef.current
    if (!viewport) return 'none'
    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    lastPointerXRef.current = pointerX
    const dir = edgeDirectionAt(pointerX, viewport.clientWidth)
    // Leaving the edge zone always releases a wheel/drag-imposed block —
    // mirrors 码头 `updateEdgeBrowseIntent`'s `direction===0` branch, where
    // `stopEdgeBrowse(movingAway)` runs with `movingAway` false absent the
    // distance-based early-cancel heuristic edge-browse.ts's own doc already
    // records as a deliberate simplification (`EDGE_DIRECTION_CANCEL_DISTANCE`
    // is exported but unused there). Without this reset, one wheel/drag
    // gesture would permanently disable edge-browse *and* hover-follow
    // (`enterHover` gates on this same ref) until the pointer fully exits
    // and re-enters the viewport — fixed after Task 9 review (I1).
    if (dir === 'none') edgeBlockedRef.current = false
    applyEdgeReading(dir)
    return dir
  }

  // --- Public handlers ---------------------------------------------------

  function registerCard(sessionId: string, element: CarouselCardMeasure | null): void {
    if (element) cardRefs.current.set(sessionId, element)
    else cardRefs.current.delete(sessionId)
  }

  /**
   * 只记几何，**绝不**在这里重算渲染窗口——这正是码头
   * `SessionCarousel.tsx:897` 的 `onScroll={() => markScrolling()}`：那一行只标记
   * 「正在滚动」，窗口更新全部发生在它自己写完 `scrollLeft` 之后、以及卡片宽度
   * 过渡结束时（`:922-935`）。
   *
   * 把窗口更新接到 DOM 的 scroll 事件上会闭合一条自激回路：渲染窗口一变，挂载的
   * 卡片就换一批，虚拟占位与真实卡片的宽度对不上，浏览器随即调整 `scrollLeft`
   * 并再发一个 scroll 事件，于是又算出一个新窗口。同层卡片数超过
   * `visibleCount × 3` 时才进得去这条回路——不超窗时切片恒等于全集、永不变化。
   */
  function onScroll(): void {
    scheduleGeometryWrite()
    // 滚动**停下来之后**才重算一次窗口。码头不做这件事（它把滚轮和拖拽都自己接管
    // 了），但我们的带子是原生 `overflow-x: auto`，用户可以直接拖滚动条；不补这一
    // 下，拖到最左边看到的会是虚拟占位——一片空白。放在 settle 上而不是每个 scroll
    // 事件上，是因为后者会闭合上面 onScroll 文档里写的那条自激回路。
    if (scrollSettleTimerRef.current !== undefined) clearTimeout(scrollSettleTimerRef.current)
    scrollSettleTimerRef.current = setTimeout(() => {
      scrollSettleTimerRef.current = undefined
      // 追踪动画在飞时窗口被钉住，这时别插手。
      if (followSessionRef.current !== undefined) return
      updateVisibleWindowState()
    }, SCROLL_SETTLE_MS)
  }

  /**
   * 卡片宽度过渡结束：聚焦卡展开/收起改变了带子的实际宽度，这时才重新把
   * `scrollLeft` 换算成首个可见卡（码头 `SessionCarousel.tsx:922-935`）。过渡结束
   * 是离散事件，不会像 scroll 那样被我们自己的重排反复触发。
   */
  function onCardTransitionEnd(event: CarouselTransitionLike): void {
    if (event.target !== event.currentTarget) return
    if (event.propertyName !== 'flex-basis' && event.propertyName !== 'flex-grow') return
    if (hoverBaselineRef.current !== undefined
      && hoverFollowSessionRef.current === undefined && hoveredSessionId === undefined) {
      restoreHoverBaseline(true)
      return
    }
    updateVisibleWindowState()
    scheduleGeometryWrite()
  }

  function onWheel(event: CarouselWheelLike): void {
    if (event.ctrlKey || event.metaKey) return
    const viewport = viewportRef.current
    if (!viewport) return
    const horizontal = event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    if (!horizontal) return
    const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY
    if (delta === 0) return
    event.preventDefault()
    edgeBlockedRef.current = true
    stopEdge()
    discardHoverBaseline()
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    setScrollLeft(Math.max(0, Math.min(maxScrollLeft, viewport.scrollLeft + delta)))
    updateVisibleWindowState()
  }

  function onPointerEnter(event: CarouselPointerLike): void {
    if (optionsRef.current.interactionLocked) return
    edgeBlockedRef.current = false
    trackPointer(event)
  }

  function onPointerDown(event: CarouselPointerLike): void {
    if (event.button !== 0 || closestMatches(event.target, INTERACTIVE_SELECTOR)) return
    const viewport = viewportRef.current
    if (!viewport) return
    dragRef.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initialScrollLeft: viewport.scrollLeft, active: false,
    }
    // Capture only after a real pan: early capture retargets descendant clicks.
  }

  function onPointerMove(event: CarouselPointerLike): void {
    trackPointer(event)
    const gesture = dragRef.current
    const viewport = viewportRef.current
    if (!gesture || !viewport || gesture.pointerId !== event.pointerId) return
    const totalX = event.clientX - gesture.startX
    const totalY = event.clientY - gesture.startY
    if (!gesture.active) {
      if (Math.abs(totalX) < DRAG_THRESHOLD_PX && Math.abs(totalY) < DRAG_THRESHOLD_PX) return
      if (Math.abs(totalY) > Math.abs(totalX)) return
      gesture.active = true
      capturePointer(event.currentTarget, event.pointerId, true)
      edgeBlockedRef.current = true
      stopEdge()
      discardHoverBaseline()
    }
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    setScrollLeft(Math.max(0, Math.min(maxScrollLeft, gesture.initialScrollLeft - totalX)))
    updateVisibleWindowState()
  }

  function onPointerUp(event: CarouselPointerLike): void {
    if (dragRef.current?.pointerId !== event.pointerId) return
    const captured = dragRef.current.active
    dragRef.current = undefined
    if (captured) capturePointer(event.currentTarget, event.pointerId, false)
  }

  function isDragging(): boolean {
    return dragRef.current?.active === true
  }

  function onPointerLeave(): void {
    lastPointerXRef.current = undefined
    stopEdge()
    leaveHover()
  }

  function onCardEnter(sessionId: string): void { if (!optionsRef.current.interactionLocked) enterHover(sessionId) }
  function onCardLeave(): void { onPointerLeave() }

  // See CarouselController.onKeyDown's doc: bound as a component-level
  // bubble-phase handler on purpose, not a document-wide capture like 码头's
  // useTerminalShortcuts.ts (Electron-only there; a Web host plugin here, so
  // global capture risks colliding with DSH's own shortcuts — bubbling from
  // the carousel subtree, where every card's chat input already lives, is
  // enough to reach every real keypress this needs).
  function onKeyDown(event: CarouselKeyLike): void {
    // A single platform-specific modifier, Shift/Alt excluded — ported from
    // 码头 useTerminalShortcuts.ts's `modKey = isMac ? metaKey : ctrlKey` /
    // `modKey && !shiftKey && !altKey && key === ']'`. Excluding Shift matters:
    // 码头 reserves Cmd/Ctrl+Shift+]/[ for tab-switching, so accepting it here
    // too would silently steal that shortcut once this carousel ships next to it.
    const modKey = isMac ? event.metaKey : event.ctrlKey
    if (modKey && !event.shiftKey && !event.altKey && (event.key === ']' || event.key === '[')) {
      const list = nodesRef.current
      // 码头 HierarchyShell.tsx focusPane: a single (or no) sibling has nothing to cycle to.
      if (list.length <= 1) return
      const current = focusedSessionIdRef.current
      const idx = current === undefined ? -1 : list.indexOf(current)
      if (idx < 0) return
      const step = event.key === ']' ? 1 : -1
      const nextId = list[(idx + step + list.length) % list.length]
      if (nextId === undefined) return
      event.preventDefault()
      onFocusRef.current(nextId)
      return
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowUp') && !closestMatches(event.target, EDITABLE_SELECTOR)) {
      const handler = onReturnToParentRef.current
      if (handler === undefined) return
      event.preventDefault()
      handler()
    }
  }

  // --- Effects -------------------------------------------------------

  // Measure the viewport's own box: visibleColumnsForWidth drives the
  // responsive column count. jsdom has no ResizeObserver (nor real layout),
  // so the initial synchronous measure (clientWidth 0 -> 4 columns) is what
  // DOM-level tests without a stub observe.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => {
      setVisibleCount(prev => {
        const next = visibleColumnsForWidth(nodesRef.current.length, viewport.clientWidth)
        return next === prev ? prev : next
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (viewport instanceof Element) observer.observe(viewport)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // FLIP reflow: when the sibling order changes (e.g. `orderSiblings`
  // re-sorting after a session's last-interaction time moves), animate each
  // card that actually moved from its old screen position to its new one,
  // ported from 码头 SessionCarousel.tsx:232-257. Keyed on the *order* of
  // session ids (not the `nodes` array reference, which changes far more
  // often than the order does) so an unrelated re-render doesn't replay it.
  const sessionOrderKey = JSON.stringify(nodes)
  useLayoutEffect(() => {
    const next = new Map<string, number>()
    for (const id of nodesRef.current) {
      const card = cardRefs.current.get(id)
      if (!card) continue
      // A mid-flight FLIP from the previous reorder would skew this
      // measurement — cancel it first (feature-detected: jsdom implements
      // neither method).
      if (typeof card.getAnimations === 'function') {
        for (const animation of card.getAnimations()) animation.cancel()
      }
      const offset = card.offsetLeft
      next.set(id, offset)
      const previous = previousOffsetsRef.current.get(id)
      if (previous === undefined) continue
      const deltaX = previous - offset
      if (Math.abs(deltaX) > 0.5 && !reducedMotionPreferred() && typeof card.animate === 'function') {
        card.animate(
          [{ transform: `translateX(${deltaX}px)` }, { transform: 'translateX(0)' }],
          { duration: FLIP_MS, easing: 'cubic-bezier(.2,.8,.2,1)' },
        )
      }
    }
    previousOffsetsRef.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOrderKey])

  // Restore this level's persisted geometry once per (sceneId, parentId).
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const geom = readLevelGeometry(sceneId, parentId)
    if (!geom) return
    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    let target = Math.max(0, geom.scrollLeft)
    if (geom.anchorSessionId !== undefined && geom.anchorViewportOffset !== undefined) {
      const anchorCard = cardRefs.current.get(geom.anchorSessionId)
      const anchorOffset = anchorCard
        ? anchorCard.offsetLeft
        : (() => {
          const idx = nodesRef.current.indexOf(geom.anchorSessionId!)
          return idx >= 0 ? (optionsRef.current.cardWidths?.slice(0, idx).reduce((sum, width) => sum + width + 12, 10) ?? estimatedCardOffset(idx, viewport.clientWidth, visibleCountRef.current)) : undefined
        })()
      if (anchorOffset !== undefined) target = anchoredCardScrollLeft(anchorOffset, geom.anchorViewportOffset, maxScrollLeft)
    }
    viewport.scrollLeft = target
    updateVisibleWindowState()
    if (target > 0) skipNextFocusFollowRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, parentId])

  // Leaving a level commits whatever it had queued, before the next level's
  // restore moves the viewport out from under it (I6). The pending record
  // carries its own key and value, so this is safe wherever it runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => { flushGeometryWrite() }, [sceneId, parentId])

  // Center the focused card whenever it changes (not on mount — 码头 only
  // animates a *change*; the restore effect above owns first-paint position).
  useLayoutEffect(() => {
    const changed = previousFocusedRef.current !== focusedSessionId
    previousFocusedRef.current = focusedSessionId
    if (focusedSessionId === undefined) return
    if (changed) {
      // Activation is a durable choice: any pointer-only preview and its
      // baseline stop governing the carousel (mirrors 码头 259-275).
      cancelFollow(hoverFollowFrameRef, hoverFollowSessionRef)
      setHoveredSessionId(undefined)
      clearHoverRestoreTimer()
      hoverBaselineRef.current = undefined
    }
    if (!changed) return
    if (skipNextFocusFollowRef.current) { skipNextFocusFollowRef.current = false; return }
    startFocusFollow(focusedSessionId)
    return () => cancelFollow(focusFollowFrameRef, focusFollowSessionRef)
  }, [focusedSessionId])

  const revealSeq = options.revealRequest?.seq
  const revealTargetPresent = options.revealRequest !== undefined && nodes.includes(options.revealRequest.sessionId)
  const revealSessionId = options.revealRequest?.sessionId

  /**
   * S4 Task 8 (裁定 T-5) — an EXPLICIT navigation request re-centers its
   * target unconditionally, ported from 码头
   * `session-canvas/SessionCarousel.tsx:349-387`.
   *
   * Why this cannot be folded into the focus effect above: both callers
   * routinely name the session that is ALREADY focused (the DAG overlay's
   * node click, spec §7.3 step 6; the notification center's row for the
   * current session, which shipped in S5 doing visibly nothing). That effect
   * keys on `focusedSessionId` and returns early when it did not change, so
   * there is no focus transition to observe — 码头's own comment says it
   * outright: "DAG and notification navigation may select the already-focused
   * Session. In that case React has no focus-ID change to observe, so force
   * the carousel position from this explicit navigation request."
   *
   * Deliberately UNCONDITIONAL in two further ways, both mirroring 码头:
   *
   * - It CLEARS `skipNextFocusFollowRef` instead of honoring it.
   *   `revealSession` changes the drill layer in the same commit, which runs
   *   the geometry-restore effect above and arms that flag; obeying it would
   *   let a remembered scroll position swallow the navigation the user just
   *   asked for ("It must override persisted geometry even when the target
   *   Session ID did not change", `SessionCarousel.tsx:384-385`). Clearing
   *   rather than merely skipping matters because the focus effect only
   *   consumes the flag on a focus CHANGE — a reveal of the already-focused
   *   session would otherwise leave it armed to swallow the NEXT real
   *   focus move.
   * - It discards any hover preview and its baseline first, exactly as the
   *   focus effect does: an explicit navigation is a durable choice, and
   *   leaving a stale baseline behind would roll the strip back to wherever
   *   the pointer happened to be when the user left it.
   *
   * `revealTargetPresent` is a dependency (not just a guard) so a request
   * that arrives one commit before its target joins this level still lands
   * when the card appears — 码头 keys on the same pair. `appliedRevealSeqRef`
   * then keeps that retry from re-centering a request already honored.
   */
  useLayoutEffect(() => {
    if (revealSeq === undefined || revealSessionId === undefined || !revealTargetPresent) return
    if (revealSeq === appliedRevealSeqRef.current) return
    appliedRevealSeqRef.current = revealSeq
    cancelFollow(hoverFollowFrameRef, hoverFollowSessionRef)
    setHoveredSessionId(undefined)
    clearHoverRestoreTimer()
    hoverBaselineRef.current = undefined
    skipNextFocusFollowRef.current = false
    startFocusFollow(revealSessionId)
    return () => cancelFollow(focusFollowFrameRef, focusFollowSessionRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq, revealTargetPresent])

  // Cancel every outstanding timer/frame on unmount — except the geometry
  // write, which is COMMITTED rather than dropped (I6; 码头 flushes the same
  // way in `SessionCanvas.tsx:68-72`), so the position the user left behind
  // survives a tab switch or a page teardown.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => {
    cancelFollow(focusFollowFrameRef, focusFollowSessionRef)
    cancelFollow(hoverFollowFrameRef, hoverFollowSessionRef)
    if (hoverRestoreTimerRef.current !== undefined) clearTimeout(hoverRestoreTimerRef.current)
    if (edgeTimerRef.current !== undefined) clearTimeout(edgeTimerRef.current)
    if (scrollSettleTimerRef.current !== undefined) clearTimeout(scrollSettleTimerRef.current)
    flushGeometryWrite()
  }, [])

  useLayoutEffect(() => {
    if (!options.interactionLocked) return
    cancelFollow(focusFollowFrameRef, focusFollowSessionRef)
    cancelFollow(hoverFollowFrameRef, hoverFollowSessionRef)
    stopEdge()
    clearHoverRestoreTimer()
    hoverBaselineRef.current = undefined
  }, [options.interactionLocked])

  const total = nodes.length
  const focusedIndex = focusedSessionId === undefined ? -1 : nodes.indexOf(focusedSessionId)
  // 追踪动画在飞时，窗口以目标卡为中心并保持不动（见 `followSessionRef`）。
  const followIndex = followSessionRef.current === undefined ? -1 : nodes.indexOf(followSessionRef.current)
  const renderWindow = followIndex >= 0
    ? computeRenderWindow(firstVisible, visibleCount, total, followIndex, true)
    : computeRenderWindow(firstVisible, visibleCount, total, focusedIndex, focusChangedForRender)

  return {
    visibleCount,
    onCardTransitionEnd,
    renderWindow,
    edgePhase,
    hoveredSessionId,
    registerCard,
    onScroll,
    onWheel,
    onPointerEnter,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    isDragging,
    onPointerLeave,
    onCardEnter,
    onCardLeave,
    onKeyDown,
  }
}
