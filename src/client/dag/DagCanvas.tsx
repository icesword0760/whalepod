/**
 * The DAG canvas — the component that puts `dag/layout.ts`,
 * `dag/render-model.ts` and `dag/viewport.ts` on screen. Ported from 码头's
 * `apps/desktop/src/renderer/src/dag/DagCanvas.tsx`, minus everything that was
 * only ever arithmetic (that moved to `dag/viewport.ts`) or only ever markup
 * (that moved to `DagNodeCard.tsx` / `DagAggregateCard.tsx`), so what is left
 * here is exactly the part that must touch the DOM: measuring the viewport,
 * reading gestures, and coalescing transform commits onto animation frames.
 *
 * The component owns ONE piece of state the overlay does not: `previewSessionId`
 * (码头 `:29`), the card the canvas is centred on. It starts at
 * `focusedSessionId` and moves on a card click, an aggregate click, or a search
 * preview — but it is NOT the carousel's focus, and moving it never navigates.
 * Navigation is `onSelect`, which the overlay (Task 12) turns into the
 * close-reveal-dismiss sequence.
 *
 * ## Four deliberate divergences from 码头
 *
 * 1. **No global keyboard shortcuts** (D-4). 码头 binds Cmd/Ctrl + `=` / `-` /
 *    `0` / `F` on `window` (`:119-134`); this canvas binds nothing at all. The
 *    − / % / ＋ / ⌖ buttons are the whole zoom entry point, and the search box
 *    is reached by the overlay focusing it on open. `Ctrl/Cmd + 滚轮` stays,
 *    because a trackpad pinch reaches the browser exactly that way — a pointer
 *    gesture, not a key binding.
 * 2. **The wheel listener is native and non-passive.** React 18 registers
 *    `wheel` as a PASSIVE listener on the root container
 *    (`react-dom`'s `addTrappedEventListener`: `touchstart` / `touchmove` /
 *    `wheel` are forced passive), which silently turns 码头's
 *    `event.preventDefault()` (`:137`) into a no-op — so a pinch-zoom over the
 *    canvas would zoom the whole page as well as the graph. The handler is
 *    therefore attached to the viewport element with `{ passive: false }`.
 *    Behaviour is 码头's; only the attachment point differs.
 * 3. **One viewport-size fallback, used everywhere.** 码头 measures with
 *    `|| 1000` / `|| 700` in the render body (`:38-39`) but with `?? 0` inside
 *    `center()` (`:306-308`), so before the first layout its zoom buttons pivot
 *    on the top-left corner instead of the middle. {@link viewportSizeOf} is
 *    the single answer both paths use.
 * 4. **`initialTransform` is re-applied by VALUE, not by identity.** 码头's
 *    effect (`:83-88`) fires on every new object; the overlay reads the stored
 *    viewport out of `localStorage`, and a caller that recreates that object per
 *    render would snap the canvas back mid-drag and make panning impossible.
 *    The effect here compares the fields, so a genuinely different stored
 *    viewport (a scene switch) still applies and a re-created equal one does
 *    not.
 *
 * Not ported at all: 码头's mode badge, worktree/git rows and
 * `-webkit-app-region` window-drag handles — see `DagNodeCard.tsx` and
 * `dag.module.css` for why each is absent.
 *
 * ## Who owns persistence
 *
 * This component only REPORTS: every committed transform goes to
 * `onTransformChange`. The 200ms debounce, the `localStorage` write and the
 * unmount flush belong to the overlay (Task 12), because the canvas has no idea
 * which scene it is drawing.
 * @module dsh-plugin-matou-layout/src/client/dag/DagCanvas
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import { DagAggregateCard } from './DagAggregateCard.tsx'
import { DagNodeCard } from './DagNodeCard.tsx'
import type { DagGraphView } from './graph.ts'
import type { DagLayoutEdge, DagLayoutNode } from './layout.ts'
import { layoutGraph } from './layout.ts'
import { buildDagRenderModel } from './render-model.ts'
import type { DagTransform } from './viewport.ts'
import { centerWorldYOf, INITIAL_TRANSFORM, centerOnNode, visibleDepthsFor, worldBoundsOf, zoomAt } from './viewport.ts'
import css from './dag.module.css'

/** What the canvas hands the search box so it can drive the viewport (码头 `DagCanvas.tsx:177`). */
export interface DagCanvasSearchHandlers {
  /** Pan onto a card WITHOUT navigating — the arrow keys walk the result list with this. */
  readonly onPreview: (sessionId: string) => void
  /** Commit a choice: same effect as clicking that card. */
  readonly onChoose: (sessionId: string) => void
}

export interface DagCanvasProps {
  graph: DagGraphView
  /** The carousel's focused session; seeds `previewSessionId` and drives the first-mount centring. */
  focusedSessionId: string
  /** Navigation. Fired by a card click and by the search box's Enter — never by a pan, zoom or preview. */
  onSelect: (sessionId: string) => void
  /** A restored viewport. When present the first-mount auto-centring is skipped entirely. */
  initialTransform?: DagTransform | undefined
  /** Called on EVERY commit; debouncing and persisting are the overlay's job. */
  onTransformChange?: ((transform: DagTransform) => void) | undefined
  /** Renders the toolbar's search box. Injected rather than imported so the canvas stays testable on its own. */
  renderSearch?: ((handlers: DagCanvasSearchHandlers) => ReactNode) | undefined
  t: Translate<MatouKey>
}

/** An in-flight canvas drag: the pointer that started it, where it started, and the pan it started from. */
interface DagDrag {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly originX: number
  readonly originY: number
}

/** 码头 `DagCanvas.tsx:38` — what an unmeasured (or jsdom) viewport counts as. */
const FALLBACK_VIEWPORT_WIDTH = 1000
/** 码头 `DagCanvas.tsx:39` */
const FALLBACK_VIEWPORT_HEIGHT = 700
/** 码头 `DagCanvas.tsx:104`; must match `dag.module.css`'s `.canvas.isAnimating .world` transition. */
const GLIDE_MS = 240
/** 码头 `DagCanvas.tsx:123,125,179,181` — one click of − or ＋. */
const ZOOM_STEP = .1
/** 码头 `DagCanvas.tsx:142` — wheel delta to zoom factor, through `Math.exp`. */
const WHEEL_ZOOM_RATE = .002
/**
 * Where a pointer-down does NOT start a canvas drag (码头 `DagCanvas.tsx:149`).
 * 码头 tests its card class names; the cards carry `data-dag-node` /
 * `data-dag-aggregate` for exactly this, which survives a CSS-module rename.
 */
const NO_DRAG_SELECTOR = 'button,input,[data-dag-node],[data-dag-aggregate]'

/**
 * The viewport's pixel size, with 码头's fallback for an element that has not
 * been laid out yet (or is in jsdom, where `clientWidth` is always 0). `||`
 * rather than `??` on purpose: a measured 0 is not a usable viewport either.
 * @param element - the canvas viewport, or null before the ref is attached.
 * @returns the size to do viewport arithmetic against.
 */
function viewportSizeOf(element: HTMLElement | null): { readonly width: number; readonly height: number } {
  return {
    width: element?.clientWidth || FALLBACK_VIEWPORT_WIDTH,
    height: element?.clientHeight || FALLBACK_VIEWPORT_HEIGHT,
  }
}

/**
 * Whether the user asked for less motion. Guarded with `typeof` because jsdom
 * defines no `matchMedia` at all, and an unguarded read would throw before the
 * first card ever rendered.
 * @returns true when `prefers-reduced-motion: reduce` matches.
 */
function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Two decimal places, for the `data-scale` / `data-pan` diagnostics
 * (码头 `DagCanvas.tsx:329`). Those attributes are read by the page walk, by
 * `dag.module.css`'s `[data-scale^="0.4"]` detail gate and by this component's
 * spec, so the rounding is part of the contract, not a display detail.
 * @param value - any transform component.
 * @returns the value rounded to 2dp.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * One parent→child link as a cubic Bézier (码头 `DagCanvas.tsx:203-209`). Both
 * control points sit on the midpoint of the two x's, which is what gives every
 * edge the same S-curve no matter how far apart its ends are vertically — the
 * shape reads as "this came from that" rather than as a wire.
 * @param edge - the placed edge, endpoints already in world coordinates.
 * @returns the SVG path data.
 */
function edgePath(edge: DagLayoutEdge): string {
  const mid = (edge.from.x + edge.to.x) / 2
  return `M ${edge.from.x} ${edge.from.y} C ${mid} ${edge.from.y}, ${mid} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`
}

/**
 * The faint stub tying one root card back to a common left margin
 * (码头 `DagCanvas.tsx:200-201`), so a graph with several roots still reads as
 * one tree instead of several loose columns.
 * @param root - a depth-0 card.
 * @param canvasHeight - `layout.height`; the stub's fixed end sits at its middle.
 * @returns the SVG path data.
 */
function rootGuidePath(root: DagLayoutNode, canvasHeight: number): string {
  const anchorY = canvasHeight / 2
  const cardY = root.y + root.height / 2
  return `M 12 ${anchorY} C 28 ${anchorY}, 32 ${cardY}, ${root.x} ${cardY}`
}

/**
 * Whether two transforms are the same viewport (see divergence 4 in the module
 * doc).
 * @param left - one transform, possibly absent.
 * @param right - the other transform.
 * @returns true when all three components match.
 */
function sameTransform(left: DagTransform | undefined, right: DagTransform): boolean {
  return left !== undefined && left.x === right.x && left.y === right.y && left.scale === right.scale
}

/**
 * Render the canvas.
 * @param props - the graph, the focused session, the navigation and transform callbacks, the search slot and `t`.
 * @returns the canvas element: toolbar plus either the world layer or the empty state.
 */
export function DagCanvas(props: DagCanvasProps) {
  const { graph, focusedSessionId, onSelect, initialTransform, onTransformChange, renderSearch, t } = props
  const layout = useMemo(() => layoutGraph(graph), [graph])
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DagDrag | null>(null)
  const [transform, setTransform] = useState<DagTransform>(initialTransform ?? INITIAL_TRANSFORM)
  const [previewSessionId, setPreviewSessionId] = useState(focusedSessionId)
  // `transformRef` is the freshest transform INCLUDING one still waiting on its
  // animation frame; `transform` is the one React has rendered. Gesture handlers
  // must read the ref or a fast drag would compound stale offsets (码头 `:24`).
  const transformRef = useRef(transform)
  const pendingTransform = useRef<DagTransform | null>(null)
  const transformFrame = useRef<number | null>(null)
  const glideTimer = useRef<number | null>(null)
  const appliedInitial = useRef(initialTransform)
  const onTransformChangeRef = useRef(onTransformChange)
  onTransformChangeRef.current = onTransformChange

  const { width: viewportWidth, height: viewportHeight } = viewportSizeOf(viewportRef.current)
  const fullDepths = new Set(visibleDepthsFor(layout, previewSessionId, transform, viewportWidth))
  const worldBounds = worldBoundsOf(transform, viewportWidth, viewportHeight)
  // The viewport's vertical centre in world space (码头 `:46`) — `dag/viewport.ts`
  // has no helper for it because nothing else needs it.
  const centerWorldY = centerWorldYOf(transform, viewportHeight)
  const renderModel = buildDagRenderModel({ layout, fullDepths, worldBounds, centerWorldY, previewSessionId })
  const isEmpty = graph.nodes.length === 0

  /**
   * Publish a transform: ref, React state, and the persistence report, in that
   * order (码头 `:51-55`).
   * @param next - the transform to adopt.
   */
  const commitTransform = (next: DagTransform): void => {
    transformRef.current = next
    setTransform(next)
    onTransformChangeRef.current?.(next)
  }

  /**
   * Adopt a transform NOW, dropping any frame still queued (码头 `:56-63`).
   * Used by the discrete gestures — buttons, focus glides — where landing on
   * the next frame instead would let a stale coalesced pan overwrite the jump.
   * @param next - the transform to adopt.
   */
  const update = (next: DagTransform): void => {
    if (transformFrame.current !== null) {
      cancelAnimationFrame(transformFrame.current)
      transformFrame.current = null
      pendingTransform.current = null
    }
    commitTransform(next)
  }

  /**
   * Adopt a transform on the next animation frame, keeping only the latest
   * (码头 `:64-74`). Wheel and drag events arrive far faster than frames; one
   * re-render per frame is the difference between a canvas that tracks the
   * pointer and one that lags behind it.
   * @param next - the transform to adopt once the frame runs.
   */
  const scheduleUpdate = (next: DagTransform): void => {
    transformRef.current = next
    pendingTransform.current = next
    if (transformFrame.current !== null) return
    transformFrame.current = requestAnimationFrame(() => {
      transformFrame.current = null
      const pending = pendingTransform.current
      pendingTransform.current = null
      if (pending) commitTransform(pending)
    })
  }

  /**
   * Commit whatever the next frame was going to commit, right now
   * (码头 `:75-82`). Called on pointer-up so a drag that ends between frames
   * still lands where the user let go.
   */
  const flushScheduledUpdate = (): void => {
    const pending = pendingTransform.current
    if (!pending) return
    if (transformFrame.current !== null) cancelAnimationFrame(transformFrame.current)
    transformFrame.current = null
    pendingTransform.current = null
    commitTransform(pending)
  }

  /**
   * Centre one card and make it the preview (码头 `:92-105`).
   *
   * The glide class is added imperatively rather than through React state
   * because it must be on the element BEFORE the transform changes for the CSS
   * transition to catch it, and because every other transform change — drags,
   * wheel pans — must stay untransitioned to track the pointer. Unlike 码头 the
   * removal timer is kept in a ref, so two glides in quick succession cannot
   * have the first one's timer strip the second one's class.
   *
   * `glideClass` is read into a local because `*.module.css` is typed
   * `Record<string, string>` (`src/css-modules.d.ts`) and the project runs
   * `noUncheckedIndexedAccess`: a stylesheet that somehow lost the class must
   * skip the glide, not hand `classList.add` an empty string and throw.
   * @param sessionId - the card to centre; a session with no card is a no-op.
   * @param animate - whether to glide; false for the first-mount jump.
   */
  const focusNode = (sessionId: string, animate = true): void => {
    const node = layout.nodeById.get(sessionId)
    const viewport = viewportRef.current
    if (!node || !viewport) return
    setPreviewSessionId(sessionId)
    const size = viewportSizeOf(viewport)
    const glideClass = css.isAnimating
    if (animate && glideClass !== undefined && !reducedMotion()) {
      if (glideTimer.current !== null) window.clearTimeout(glideTimer.current)
      viewport.classList.add(glideClass)
      glideTimer.current = window.setTimeout(() => {
        glideTimer.current = null
        viewport.classList.remove(glideClass)
      }, GLIDE_MS)
    }
    update(centerOnNode(transformRef.current, node, size.width, size.height))
  }

  /**
   * The 「恢复 100%」 button (码头 `:106-111`). Reset means the whole starting
   * transform, not just `scale = 1`: re-zooming around wherever the user
   * happened to have panned is not a reset, and the 40px top inset is what keeps
   * the first row of cards out from under this very toolbar.
   */
  const restoreViewport = (): void => {
    update(INITIAL_TRANSFORM)
  }

  /**
   * One click of − or ＋ (码头 `:179,181`), pivoting on the viewport's centre so
   * the card the user is looking at stays where it is.
   * @param delta - the signed step to add to the current scale.
   */
  const zoomBy = (delta: number): void => {
    const current = transformRef.current
    const size = viewportSizeOf(viewportRef.current)
    update(zoomAt(current, current.scale + delta, { x: size.width / 2, y: size.height / 2 }))
  }

  /**
   * Wheel: zoom about the pointer while a modifier is held (which is also how a
   * trackpad pinch arrives), pan otherwise (码头 `:136-147`).
   * @param viewport - the canvas element, for its client rect.
   * @param event - the native wheel event.
   */
  const wheel = (viewport: HTMLElement, event: WheelEvent): void => {
    event.preventDefault()
    const current = transformRef.current
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      scheduleUpdate(zoomAt(current, current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), point))
      return
    }
    scheduleUpdate({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY })
  }
  const wheelRef = useRef(wheel)
  wheelRef.current = wheel

  /**
   * Start a canvas drag, unless this pointer-down belongs to something else
   * (码头 `:148-153`).
   * @param event - the React pointer event.
   */
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if ((event.target as Element).closest(NO_DRAG_SELECTOR)) return
    const current = transformRef.current
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: current.x,
      originY: current.y,
    }
    // Optional-called: jsdom implements no pointer capture at all.
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  /**
   * Pan by the pointer's total displacement since the drag started — a delta
   * from the ORIGIN, not from the previous move, so a dropped frame cannot make
   * the canvas drift away from the cursor (码头 `:154-162`).
   * @param event - the React pointer event.
   */
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    scheduleUpdate({
      ...transformRef.current,
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y,
    })
  }

  /**
   * End the drag and land the last coalesced frame (码头 `:163-168`).
   * @param event - the React pointer event.
   */
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.id !== event.pointerId) return
    dragRef.current = null
    flushScheduledUpdate()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  useEffect(() => {
    if (initialTransform === undefined || sameTransform(appliedInitial.current, initialTransform)) return
    appliedInitial.current = initialTransform
    transformRef.current = initialTransform
    setTransform(initialTransform)
  }, [initialTransform])

  useEffect(() => () => {
    if (transformFrame.current !== null) cancelAnimationFrame(transformFrame.current)
    if (glideTimer.current !== null) window.clearTimeout(glideTimer.current)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // Non-passive, unlike React's own `onWheel` — see divergence 2 in the module doc.
    const handle = (event: WheelEvent): void => { wheelRef.current(viewport, event) }
    viewport.addEventListener('wheel', handle, { passive: false })
    return () => { viewport.removeEventListener('wheel', handle) }
  }, [])

  useEffect(() => {
    if (initialTransform !== undefined) return
    const frame = requestAnimationFrame(() => { focusNode(focusedSessionId, false) })
    return () => { cancelAnimationFrame(frame) }
    // First centring only. A live summary refresh re-renders this component
    // constantly and must NOT move the viewport the user has set (码头 `:116`),
    // so `focusNode` is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSessionId, initialTransform])

  const searchHandlers: DagCanvasSearchHandlers = {
    onPreview: (sessionId) => { focusNode(sessionId) },
    onChoose: (sessionId) => { onSelect(sessionId) },
  }

  return (
    <div
      ref={viewportRef}
      className={css.canvas}
      /* `group` 而不是码头那个 `application`（S4 审查 I-3）：`application`
         的契约是「本区域自己接管全部键盘交互，读屏请退出浏览模式」，而本画布
         按 D-4 一个快捷键都不绑，等于让读屏用户交出方向键逐条读卡片的能力却
         换不回任何东西。卡片本身是真 button、Tab 仍可达；浮层壳已经是
         `dialog` + `aria-modal`，语义完整。码头是 Electron 独立窗口，这一处
         属于「照抄了不该抄的那部分」。 */
      role="group"
      aria-label={t('dag.label')}
      data-scale={round(transform.scale)}
      data-pan={`${round(transform.x)},${round(transform.y)}`}
      data-rendered-node-count={renderModel.realNodes.length}
      data-rendered-aggregate-count={renderModel.aggregates.length}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
    >
      <header className={css.toolbar}>
        {renderSearch?.(searchHandlers)}
        <div className={css.toolbarEnd}>
          <div className={css.zoom} role="group" aria-label={t('dag.zoom.label')}>
            <button type="button" aria-label={t('dag.zoom.out')} onClick={() => { zoomBy(-ZOOM_STEP) }}>−</button>
            <button type="button" aria-label={t('dag.zoom.reset')} onClick={restoreViewport}>
              {Math.round(transform.scale * 100)}%
            </button>
            <button type="button" aria-label={t('dag.zoom.in')} onClick={() => { zoomBy(ZOOM_STEP) }}>＋</button>
            <button type="button" aria-label={t('dag.zoom.focus')} onClick={() => { focusNode(previewSessionId) }}>⌖</button>
          </div>
          <div className={css.legend} role="group" aria-label={t('dag.legend.label')}>
            <span>{t('dag.legend.fork')}</span>
            <span className={css.derived}>{t('dag.legend.derived')}</span>
          </div>
        </div>
      </header>
      {isEmpty ? <p className={css.empty} role="status">{t('dag.empty')}</p> : (
        <div
          className={css.world}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate3d(${transform.x}px,${transform.y}px,0) scale(${transform.scale})`,
          }}
        >
          {/* Edges carry no information the cards and the legend do not; naming
              every curve would only make the graph unnavigable by screen reader. */}
          <svg className={css.edges} width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker
                id="dag-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={css.arrowHead} />
              </marker>
            </defs>
            {(layout.nodesByDepth.get(0) ?? [])
              .filter(({ y, height }) => y + height >= worldBounds.top && y <= worldBounds.bottom)
              .map((root) => (
                <path key={`root:${root.sessionId}`} className={css.rootGuide} d={rootGuidePath(root, layout.height)} />
              ))}
            {renderModel.edges.map((edge) => (
              <path
                key={`${edge.fromSessionId}:${edge.toSessionId}`}
                className={clsx(css.edge, edge.relationKind === 'forked-from' ? css.edgeForked : css.edgeDerived)}
                data-relation-kind={edge.relationKind}
                d={edgePath(edge)}
              />
            ))}
          </svg>
          {renderModel.realNodes.map((positioned) => (
            <DagNodeCard
              key={positioned.sessionId}
              node={positioned.node}
              focused={positioned.sessionId === previewSessionId}
              style={{ left: positioned.x, top: positioned.y, width: positioned.width, height: positioned.height }}
              onClick={() => {
                setPreviewSessionId(positioned.sessionId)
                onSelect(positioned.sessionId)
              }}
              t={t}
            />
          ))}
          {/* A fold is not a session: clicking it only pans onto the branch it
              stands for (码头 `:224`), leaving the overlay open. */}
          {renderModel.aggregates.map((aggregate) => (
            <DagAggregateCard
              key={aggregate.key}
              aggregate={aggregate}
              style={{ left: aggregate.x, top: aggregate.y, width: aggregate.width, height: aggregate.height }}
              onClick={() => { focusNode(aggregate.targetSessionId) }}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}
