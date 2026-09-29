/**
 * The sibling-session carousel (mockup `carousel`, 码头 `SessionCarousel`): a
 * horizontally scrolling strip of {@link CardShell} cards, one focused
 * (expanded) among compact neighbors. DOM matches 码头's own shape —
 * `.carousel[role=region][aria-label] > .slot[data-session-id] > .card`,
 * with the virtualized head/tail padded by {@link VirtualSpacer} exactly as
 * 码头 pads its own sliced strip. Behavior comes from
 * {@link useCarouselController}: ResizeObserver-measured
 * column count, focus-centering, hover-expand with baseline rollback, edge
 * browsing, wheel/drag scrolling, per-level geometry persistence, and the
 * `Cmd/Ctrl+]`/`[`/`ArrowLeft`/`ArrowUp` shortcuts. `sceneId`/`parentId`
 * key that persistence; `focusedSessionId` is derived from `cards` (the
 * single source of truth for which card is focused) rather than duplicated
 * as a separate prop.
 * @module dsh-plugin-matou-layout/src/client/carousel/Carousel
 */
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MatouKey } from '../locales.ts'
import type { CardModel, UseSessionLifecycle } from './CardShell.tsx'
import { CardShell } from './CardShell.tsx'
import type { CompactCardMenuProps } from './CompactCardHeader.tsx'
import { closestMatches, useCarouselController } from './useCarouselController.ts'
import type { CarouselCardMeasure, CarouselViewport } from './useCarouselController.ts'
import css from './carousel.module.css'
import { useCardLayout } from './useCardLayout.ts'
import { DEFAULT_CARD_WIDTH } from './card-layout.ts'

/**
 * Elements a pointerdown/focus-capture activation must not fire for — 码头
 * `SessionCard.tsx:19-34`'s own exclusion, ported verbatim: "Header actions
 * must complete on their original DOM node. Activating the card on button
 * focus refreshes the projection between pointer-down and click, which
 * otherwise drops the user's requested action." Deliberately narrower than
 * `useCarouselController`'s own drag-start `INTERACTIVE_SELECTOR` (which
 * also excludes inputs/textareas/links, for a different reason — starting a
 * drag on a text field): focusing an INPUT inside a card is exactly the
 * "clicked into the chat composer" case that SHOULD activate the card.
 */
const CARD_ACTIVATE_EXCLUDE_SELECTOR = 'button,[role="menuitem"],[data-card-resize]'

export interface CarouselProps {
  cards: readonly CardModel[]
  onReorder?: ((ids: readonly string[]) => Promise<void>) | undefined
  /** The scene (workbench tab) this level belongs to; keys geometry persistence. */
  sceneId: string
  /** The level's parent session id; `undefined` selects the scene's root level. */
  parentId: string | undefined
  /**
   * S4 Task 8 (裁定 T-5): this scene's latest explicit navigation request
   * (`carousel/reveal-store.ts`, fed by `AppFrame` from `hooks.reveal`).
   * A bumped `seq` re-centers `sessionId` even when it is already the focused
   * card — the case the plain focus effect cannot see. Omitted (every caller
   * that never reveals, and this component's own pre-S4 specs) leaves the
   * carousel behaving exactly as before.
   */
  revealRequest?: { readonly sessionId: string; readonly seq: number }
  /** Called with a sibling's session id when `Cmd/Ctrl+]`/`[` cycles focus. */
  onFocus: (sessionId: string) => void
  /**
   * S5 Task 8: pressing anywhere on a card (outside
   * {@link CARD_ACTIVATE_EXCLUDE_SELECTOR}) deletes that session's whole
   * notification history — 码头 `hierarchy/TerminalPane.tsx:314`'s
   * `notificationStore.dismissSessionIndicator(session.id)`. Wired by
   * `AppFrame` to the face's own `dismissSessionIndicator`; omitted (every
   * pre-S5 caller, and this component's own specs that only exercise
   * focus/geometry) leaves the pointer path doing exactly what it did before.
   *
   * Fires on the pointer path only — never on focus. See the two handlers
   * below for why they are no longer one callback, and `onCardPointerDown`
   * for why the call itself waits for `pointerup`.
   */
  onDismissNotifications?: (sessionId: string) => void
  /** Called when `ArrowLeft`/`ArrowUp` requests returning to the parent level; `undefined` at the root (no-op). */
  onReturnToParent: (() => void) | undefined
  /** Renders the official `conversation` slot for one card (AppFrame wires the real one in Task 10). */
  renderPane: (sessionKey: string, focused: boolean) => ReactNode
  /** Resolves the compact card's "⋯" menu data (Ruling-9); omitted keeps that button static chrome. */
  cardMenu?: (sessionId: string) => CompactCardMenuProps
  /** Live per-session lifecycle read, forwarded to each {@link CardShell} (I4); omitted falls back to `CardModel.blank`. */
  useSessionLifecycle?: UseSessionLifecycle
  /**
   * Reports the session ids inside the controller's virtualized render
   * window (`useCarouselController`'s `renderWindow.start..start+count`,
   * mapped to `cards`) whenever it changes — i.e. exactly the cards this
   * component mounts (C1: the window slices the DOM, it does not merely
   * annotate it). AppFrame consumes this to keep DSH's "staged" set
   * (`ctx.sessions.pin/unpin`) in sync with what's actually mounted — see
   * the Task 10 report for why a callback (not a direct
   * `useCarouselController` read) is the chosen channel: it keeps the
   * controller's internals private to this component, matching how
   * `onFocus`/`onReturnToParent` already expose behavior without exposing
   * the hook itself.
   */
  onRenderWindowChange?: (sessionIds: readonly string[]) => void
  t: Translate<MatouKey>
}

/**
 * The inert filler standing in for a contiguous run of unmounted cards
 * (码头 `.session-card-virtual-spacer`): it reserves exactly the width those
 * `count` slots plus their gaps would have occupied, so virtualizing the DOM
 * changes neither the scroll track's length nor the scroll position inside
 * it. `aria-hidden` because it represents nothing a reader should hear.
 */
function VirtualSpacer({ count, width }: { count: number; width: number }) {
  return (
    <div
      className={css.virtualSpacer}
      aria-hidden="true"
      style={{ '--virtual-count': String(count), flexBasis: width } as CSSProperties}
    />
  )
}

export function Carousel({
  cards, sceneId, parentId, onReorder, revealRequest, onFocus, onDismissNotifications, onReturnToParent, renderPane, cardMenu,
  useSessionLifecycle, onRenderWindowChange, t,
}: CarouselProps) {
  const viewportRef = useRef<CarouselViewport | null>(null)
  const cardRefs = useRef(new Map<string, CarouselCardMeasure>())
  /**
   * The card a press landed on, held until that press resolves into a click
   * rather than a strip drag — see {@link CarouselProps.onDismissNotifications}
   * for why the dismiss cannot simply fire on `pointerdown` the way 码头's
   * does.
   */
  const pendingDismissRef = useRef<string | null>(null)
  const originalIds = useMemo(() => cards.map(card => card.sessionId), [cards])
  const layout = useCardLayout(originalIds, JSON.stringify([sceneId, parentId]), onFocus, onReorder)
  const nodes = layout.order
  const orderedCards = useMemo(() => nodes.flatMap(id => {
    const card = cards.find(item => item.sessionId === id)
    return card ? [card] : []
  }), [cards, nodes])
  const cardWidths = nodes.map(id => layout.widths[id] ?? DEFAULT_CARD_WIDTH)
  const spacerWidth = (from: number, to: number) => cardWidths.slice(from, to).reduce((sum, width) => sum + width + 12, 0) - 12
  const focusedSessionId = cards.find(card => card.focused)?.sessionId

  const controller = useCarouselController({
    cardWidths, interactionLocked: layout.active !== null,
    sceneId, parentId, nodes, focusedSessionId, onFocus, onReturnToParent, viewportRef, cardRefs,
    // Spread, not `revealRequest,`: `exactOptionalPropertyTypes` makes an
    // explicit `undefined` a different thing from an absent key.
    ...(revealRequest === undefined ? {} : { revealRequest }),
  })

  const { start, count } = controller.renderWindow
  const windowIds = useMemo(() => nodes.slice(start, start + count), [nodes, start, count])
  useEffect(() => { onRenderWindowChange?.(windowIds) }, [onRenderWindowChange, windowIds])
  // C1: the render window IS the mounted set (码头 `renderedNodes =
  // nodes.slice(renderStart, renderEnd)`). Rendering every card while pinning
  // only the window would leave the surplus panes unstaged, and DSH's
  // `keyed ?? adapter.resolve(sessionKey) ?? current` fallback
  // (`ui-renderer/src/client/bindings.tsx`) would then render the CURRENT
  // session's transcript under a foreign card's header. Slicing makes
  // "rendered ⊆ staged" a constructive invariant instead of a hope.
  const renderedCards = useMemo(() => orderedCards.slice(start, start + count), [orderedCards, start, count])
  const omittedBefore = start
  const omittedAfter = cards.length - (start + count)

  return (
    <div
      ref={element => { viewportRef.current = element }}
      className={css.carousel}
      role="region"
      aria-label={t('carousel.list')}
      tabIndex={-1}
      {...layout.handlers}
      data-layout-gesture={layout.active?.kind}
      data-edge-phase={controller.edgePhase}
      style={{ '--session-visible-columns': String(controller.visibleCount) } as CSSProperties}
      onScroll={controller.onScroll}
      onWheel={controller.onWheel}
      onPointerEnter={controller.onPointerEnter}
      onPointerDown={controller.onPointerDown}
      onPointerMove={event => {
        controller.onPointerMove(event)
        // Once the press has become a pan, it was never a click on a card:
        // drop the dismiss it was holding.
        if (controller.isDragging()) pendingDismissRef.current = null
      }}
      onPointerUp={event => {
        const pending = pendingDismissRef.current
        pendingDismissRef.current = null
        // Read BEFORE `controller.onPointerUp`, which clears the gesture:
        // a press released without ever crossing the drag threshold is the
        // click 码头 dismisses on.
        if (pending !== null && !controller.isDragging()) onDismissNotifications?.(pending)
        controller.onPointerUp(event)
      }}
      onPointerCancel={event => {
        // A cancelled press (the browser took the gesture, the pointer was
        // lost) is not a click: drop the dismiss without firing it.
        pendingDismissRef.current = null
        controller.onPointerUp(event)
      }}
      onPointerLeave={controller.onPointerLeave}
      onKeyDown={controller.onKeyDown}
    >
      {layout.error && <div role="alert" className={css.layoutNotice}>{layout.error}</div>}
      {layout.active?.kind === 'sort' && <div role="status" className={css.layoutNotice}>拖动调整顺序，松手保存 · Esc 取消</div>}
      {omittedBefore > 0 && <VirtualSpacer count={omittedBefore} width={spacerWidth(0, start)} />}
      {renderedCards.map((card) => {
        // 码头 `hierarchy/TerminalPane.tsx:312-316`, ported statement for
        // statement:
        //
        //   if (target.closest('button,[role="menuitem"]')) return
        //   notificationStore.dismissSessionIndicator(session.id)
        //   if (!active) onActivate(session.id)
        //
        // The order is the point. `!card.focused` gates ONLY the activation:
        // once the exclusion list has been cleared the dismiss is
        // unconditional, so pressing the card that ALREADY has focus still
        // clears its ring — which is the commonest way a user acts on a
        // notification they can see. Folding `focused` into the dismiss
        // condition (as this handler's pre-S5 shape did, when both capture
        // paths shared one `activate` closure) would make the feature miss
        // its main path.
        const onCardPointerDown = (target: unknown): void => {
          if (closestMatches(target, CARD_ACTIVATE_EXCLUDE_SELECTOR)) return
          // Not dismissed here — ARMED here, and fired by the viewport's
          // `onPointerUp` if the press never turned into a strip drag. 码头
          // dismisses inline on `pointerdown` because its panes are a split
          // tree with no drag gesture to disambiguate; this carousel scrolls
          // by dragging the strip, and that drag necessarily starts as a
          // press on some card. Dismissing inline would delete THAT card's
          // notification history (`dismissSessionIndicator` removes records,
          // it does not mark them read) every time the user scrolls the
          // strip — silently losing the very pointer that says a session
          // needs them.
          pendingDismissRef.current = card.sessionId
          if (!card.focused) onFocus(card.sessionId)
        }
        // The focus path keeps its pre-S5 behavior and gains NO dismiss:
        // 码头 hangs nothing on focus at all (its only handler is
        // `onPointerDown`), and tabbing across a strip would otherwise erase
        // unread state on cards the user never looked at. Clicking/focusing a
        // button or menu item inside the card must still complete on its own
        // element rather than being reinterpreted as "switch focus here"
        // (码头 SessionCard.tsx:19-34, see CARD_ACTIVATE_EXCLUDE_SELECTOR's doc).
        const onCardFocus = (target: unknown): void => {
          if (!card.focused && !closestMatches(target, CARD_ACTIVATE_EXCLUDE_SELECTOR)) onFocus(card.sessionId)
        }
        return (
          <div
            key={card.sessionId}
            ref={element => { controller.registerCard(card.sessionId, element) }}
            className={clsx(
              css.slot,
              card.focused && css.isFocused,
              card.sessionId === controller.hoveredSessionId && css.isExpanded,
            )}
            data-session-id={card.sessionId}
            data-sorting={(layout.active?.kind === 'sort' || layout.active?.kind === 'settle') && layout.active.id === card.sessionId || undefined}
            style={{ flexBasis: layout.widths[card.sessionId] ?? DEFAULT_CARD_WIDTH, minWidth: DEFAULT_CARD_WIDTH, transition: 'none', position: 'relative' }}
            onMouseEnter={() => { controller.onCardEnter(card.sessionId) }}
            onTransitionEnd={event => { controller.onCardTransitionEnd(event) }}
            onPointerDownCapture={event => { onCardPointerDown(event.target) }}
            onFocusCapture={event => { onCardFocus(event.target) }}
          >
            <CardShell
              card={card}
              renderPane={renderPane}
              {...cardMenu === undefined ? {} : { cardMenu }}
              {...useSessionLifecycle === undefined ? {} : { useSessionLifecycle }}
              t={t}
            />
            <div data-card-resize role="separator" aria-orientation="vertical" tabIndex={0}
              aria-label={`调整卡片宽度：${card.title}`} aria-valuemin={DEFAULT_CARD_WIDTH}
              aria-valuenow={layout.widths[card.sessionId] ?? DEFAULT_CARD_WIDTH}
              title="拖动调整宽度；双击卡片头恢复默认宽度"
              className={css.resizeHandle} />
          </div>
        )
      })}
      {omittedAfter > 0 && <VirtualSpacer count={omittedAfter} width={spacerWidth(start + count, cards.length)} />}
    </div>
  )
}
