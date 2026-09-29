/**
 * Pure geometry math for the card carousel: scroll-position targets and
 * column counts, ported verbatim from 码头 `SessionCarousel.tsx:973-1049`. No
 * React, no DOM — every function takes plain numbers (offsets, widths,
 * viewport bounds) and returns a number, kept unit-testable in isolation
 * from the carousel's rendering and its `HTMLElement` plumbing.
 * @module dsh-plugin-matou-layout/src/client/carousel/geometry
 */

/** Minimum gap, in px, kept between a card's edge and the viewport edge when scrolling it into view. */
export const CARD_EDGE_INSET = 10
/** Duration, in ms, of the hover-follow scroll animation. */
export const FOLLOW_MS = 440
/** Per-frame cap, in px, on how far a hover-follow correction may move the viewport. */
export const FOLLOW_STEP_MAX_PX = 28
/** Below this px delta a scroll correction is considered settled and stops re-applying. */
export const SETTLE_TOLERANCE = 0.5
/** Delay, in ms, before a hover-restored viewport baseline is released. */
export const HOVER_RESTORE_MS = 220
/** Duration, in ms, of the card flip/reflow transition. */
export const FLIP_MS = 180

/**
 * The scroll-left that centers one card in the viewport, clamped to the
 * scrollable range.
 * @param cardOffsetLeft - the card's `offsetLeft` within the scroll track.
 * @param cardWidth - the card's `offsetWidth`.
 * @param viewportWidth - the viewport's `clientWidth`.
 * @param maxScrollLeft - the track's maximum scroll-left (`scrollWidth - clientWidth`, floored at 0).
 * @returns a scroll-left in `[0, maxScrollLeft]`.
 */
export function centeredCardScrollLeft(
  cardOffsetLeft: number,
  cardWidth: number,
  viewportWidth: number,
  maxScrollLeft: number,
): number {
  return Math.max(0, Math.min(
    maxScrollLeft,
    cardOffsetLeft - Math.max(0, viewportWidth - cardWidth) / 2,
  ))
}

/**
 * The scroll-left that places one card at a fixed offset from the viewport's
 * left edge, clamped to the scrollable range.
 * @param cardOffsetLeft - the card's `offsetLeft` within the scroll track.
 * @param viewportOffset - the desired distance from the viewport's left edge to the card.
 * @param maxScrollLeft - the track's maximum scroll-left.
 * @returns a scroll-left in `[0, maxScrollLeft]`.
 */
export function anchoredCardScrollLeft(
  cardOffsetLeft: number,
  viewportOffset: number,
  maxScrollLeft: number,
): number {
  return Math.max(0, Math.min(maxScrollLeft, cardOffsetLeft - viewportOffset))
}

/**
 * The minimal scroll-left that brings one card fully into view (respecting
 * `edgeInset` on both sides); returns the current `viewportScrollLeft`
 * unchanged when the card is already fully visible.
 * @param cardOffsetLeft - the card's `offsetLeft` within the scroll track.
 * @param cardWidth - the card's `offsetWidth`.
 * @param viewportScrollLeft - the viewport's current `scrollLeft`.
 * @param viewportWidth - the viewport's `clientWidth`.
 * @param maxScrollLeft - the track's maximum scroll-left.
 * @param edgeInset - minimum gap kept at each edge; defaults to {@link CARD_EDGE_INSET}.
 * @returns a scroll-left in `[0, maxScrollLeft]`.
 */
export function fullyVisibleCardScrollLeft(
  cardOffsetLeft: number,
  cardWidth: number,
  viewportScrollLeft: number,
  viewportWidth: number,
  maxScrollLeft: number,
  edgeInset = CARD_EDGE_INSET,
): number {
  // A wide card cannot satisfy both edge insets. Keep the current view while
  // it intersects the valid interval; never alternate left/right each frame.
  if (cardWidth >= Math.max(0, viewportWidth - edgeInset * 2)) {
    const left = Math.max(0, Math.min(maxScrollLeft, cardOffsetLeft - edgeInset))
    const right = Math.max(left, Math.min(maxScrollLeft, cardOffsetLeft + cardWidth - viewportWidth + edgeInset))
    return Math.max(left, Math.min(right, viewportScrollLeft))
  }
  const visibleLeft = viewportScrollLeft + edgeInset
  const visibleRight = viewportScrollLeft + viewportWidth - edgeInset
  if (cardOffsetLeft < visibleLeft) {
    return Math.max(0, Math.min(maxScrollLeft, cardOffsetLeft - edgeInset))
  }
  const cardRight = cardOffsetLeft + cardWidth
  if (cardRight > visibleRight) {
    return Math.max(0, Math.min(maxScrollLeft, cardRight - viewportWidth + edgeInset))
  }
  return viewportScrollLeft
}

/**
 * How many card columns fit at a given viewport width, on the Mockup's
 * stable 280px-card / 12px-gap grid. Capped at 4 (the Mockup's defined
 * column count) so a level with only one or two sessions keeps inactive
 * cards compact instead of stretching every item to fill the row; a zero
 * width (not yet measured) falls back to the cap.
 * @param _nodeCount - unused; kept for signature parity with 码头's call site.
 * @param width - the viewport's `clientWidth`.
 * @returns a column count in `[1, 4]`.
 */
export function visibleColumnsForWidth(_nodeCount: number, width: number): number {
  const available = width > 0 ? Math.floor((width + 12) / (280 + 12)) : 4
  return Math.min(4, Math.max(1, available))
}
