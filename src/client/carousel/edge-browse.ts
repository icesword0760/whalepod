/**
 * Pure edge-browse state machine for the card carousel: hovering the
 * pointer against a viewport edge auto-advances through hidden cards,
 * ported from 码头 `SessionCarousel.tsx:463-566`
 * (`updateEdgeBrowseIntent`/`edgeBrowseStep`/`nearestHiddenCard`). No React,
 * no DOM — the reducer takes a timestamp and a caller-supplied card-rect
 * record instead of reading `getBoundingClientRect()`/`offsetLeft` off live
 * elements, keeping it unit-testable in isolation from pointer events and
 * `setTimeout` scheduling (both of which stay the caller's job).
 * @module dsh-plugin-matou-layout/src/client/carousel/edge-browse
 */

import { fullyVisibleCardScrollLeft, SETTLE_TOLERANCE } from './geometry.ts'

/** Where the edge-browse machine is in its dwell → cruise lifecycle. */
export type EdgePhase = 'idle' | 'confirming' | 'cruising'

/** Which viewport edge the pointer currently sits against, if any. */
export type EdgeDirection = 'left' | 'right' | 'none'

/** The machine's state: its phase, active direction, and when that phase began. */
export interface EdgeState {
  readonly phase: EdgePhase
  readonly direction: EdgeDirection
  /** Timestamp (same clock as `now`) at which the current `phase` began. */
  readonly since: number
}

/** Width, in px, of the hot zone at each viewport edge that arms edge-browse. */
export const EDGE_INTENT_WIDTH = 84
/** How long the pointer must dwell in the edge zone before browsing starts. */
export const EDGE_INTENT_DWELL_MS = 180
/** Interval, in ms, between successive auto-advances once cruising. */
export const EDGE_BROWSE_INTERVAL_MS = 900
/** Pointer movement, in px, opposite the active direction that cancels edge-browse. */
export const EDGE_DIRECTION_CANCEL_DISTANCE = 2

/** One card's horizontal extent within the scroll track, as the caller reports it. */
export interface CardRect {
  readonly offsetLeft: number
  readonly offsetWidth: number
}

/**
 * Which edge, if any, a pointer x-position (relative to the viewport's own
 * left edge) sits within — the {@link EDGE_INTENT_WIDTH}px hot zone at each
 * side.
 * @param pointerX - pointer x relative to the viewport's left edge (`0` at the left, `viewportWidth` at the right).
 * @param viewportWidth - the viewport's `clientWidth`.
 * @returns `'left'`, `'right'`, or `'none'` when outside both zones.
 */
export function edgeDirectionAt(pointerX: number, viewportWidth: number): EdgeDirection {
  if (pointerX >= 0 && pointerX <= EDGE_INTENT_WIDTH) return 'left'
  if (pointerX >= viewportWidth - EDGE_INTENT_WIDTH && pointerX <= viewportWidth) return 'right'
  return 'none'
}

/**
 * Advance the edge-browse machine by one observation: a direction reading
 * (from {@link edgeDirectionAt}), the current timestamp, and whether an
 * in-flight user gesture blocks browsing this tick. Leaving the edge zone,
 * a blocked tick, or a direction reversal all cancel back to idle; dwelling
 * `EDGE_INTENT_DWELL_MS` in `confirming` promotes to `cruising`.
 * @param state - the machine's previous state.
 * @param dir - this tick's edge reading.
 * @param now - the current timestamp (same clock as `state.since`).
 * @param blocked - true while a pointer/wheel gesture is in progress, overriding `dir`.
 * @returns the next state.
 */
export function advanceEdge(state: EdgeState, dir: EdgeDirection, now: number, blocked: boolean): EdgeState {
  if (blocked || dir === 'none') {
    return { phase: 'idle', direction: 'none', since: now }
  }
  if (state.direction !== 'none' && state.direction !== dir) {
    // A direction reversal cancels the in-flight confirm/cruise outright,
    // mirroring 码头's stopEdgeBrowse() call on a flipped edge intent. 码头
    // can re-arm confirming for the new direction within the same event
    // (it has nearestHiddenCard's result on hand inline); this reducer's
    // signature carries no such lookup, so re-arming waits for the caller's
    // next advanceEdge call with the new direction — one tick later than
    // 码头. Known, deliberate simplification, not a bug.
    return { phase: 'idle', direction: 'none', since: now }
  }
  if (state.phase === 'idle') {
    return { phase: 'confirming', direction: dir, since: now }
  }
  if (state.phase === 'confirming') {
    return now - state.since >= EDGE_INTENT_DWELL_MS
      ? { phase: 'cruising', direction: dir, since: now }
      : state
  }
  return state
}

/**
 * The index of the next hidden card in `direction`, nearest to the visible
 * range — the card edge-browse would advance to next.
 * @param cards - every card's `{offsetLeft, offsetWidth}` in the scroll track, in track order.
 * @param direction - which side to look for a hidden card on.
 * @param viewportScrollLeft - the viewport's current `scrollLeft`.
 * @param viewportWidth - the viewport's `clientWidth`.
 * @returns the nearest hidden card's index, or `-1` when every card is already visible.
 */
export function nearestHiddenCard(
  cards: readonly CardRect[],
  direction: 'left' | 'right',
  viewportScrollLeft: number,
  viewportWidth: number,
  maxScrollLeft = Number.POSITIVE_INFINITY,
): number {
  const candidates = cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => {
      // Use the same destination as hover-follow: an oversized card covering
      // the viewport is already settled, even though its far edge is hidden.
      // Selecting it again would stall edge browsing before the next card.
      const target = fullyVisibleCardScrollLeft(
        card.offsetLeft, card.offsetWidth, viewportScrollLeft, viewportWidth, maxScrollLeft,
      )
      return direction === 'left'
        ? target < viewportScrollLeft - SETTLE_TOLERANCE
        : target > viewportScrollLeft + SETTLE_TOLERANCE
    })
  candidates.sort((a, b) => direction === 'left'
    ? b.card.offsetLeft - a.card.offsetLeft
    : a.card.offsetLeft - b.card.offsetLeft)
  return candidates[0]?.index ?? -1
}
