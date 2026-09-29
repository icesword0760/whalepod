/**
 * Pure render-window and visible-window math for the card carousel, ported
 * from 码头 `SessionCarousel.tsx:88-108, 389-397`. No React, no DOM — each
 * function takes plain numbers (a measured or estimated viewport width, a
 * column count, a total) instead of reading `HTMLElement.clientWidth` /
 * `scrollLeft` or `nodes.length` off live state, keeping it unit-testable in
 * isolation from the carousel's virtualized rendering.
 * @module dsh-plugin-matou-layout/src/client/carousel/window
 */

/**
 * A card's estimated `offsetLeft` before it has actually been laid out
 * (e.g. to seed a scroll target ahead of the first paint): the same
 * equal-division unit the real layout converges to, `clientWidth / visibleCount`,
 * or a fixed 292px guess while the viewport hasn't been measured yet
 * (`clientWidth <= 0`).
 * @param index - the card's position in the level.
 * @param clientWidth - the viewport's measured `clientWidth`, or `0`/negative before measurement.
 * @param visibleCount - the level's current column count.
 * @returns an estimated `offsetLeft` in px.
 */
export function estimatedCardOffset(index: number, clientWidth: number, visibleCount: number): number {
  const unit = clientWidth > 0 ? clientWidth / visibleCount : 292
  return 10 + index * unit
}

/**
 * The index of the first visible card, derived from the viewport's current
 * `scrollLeft` — the inverse of the equal-division layout `updateVisibleWindow`
 * assumes. Forced to `0` whenever every card already fits (`total <= visibleCount`).
 * @param scrollLeft - the viewport's current `scrollLeft`.
 * @param clientWidth - the viewport's measured `clientWidth`, or `0`/negative before measurement.
 * @param visibleCount - the level's current column count.
 * @param total - how many cards the level has.
 * @returns the first visible card's index, clamped to `[0, total - visibleCount]`.
 */
export function updateVisibleWindow(
  scrollLeft: number,
  clientWidth: number,
  visibleCount: number,
  total: number,
): number {
  if (total <= visibleCount) return 0
  const unit = clientWidth > 0 ? clientWidth / visibleCount : 1
  return Math.max(0, Math.min(total - visibleCount, Math.round(scrollLeft / unit)))
}

/**
 * The virtualized render window: which contiguous slice of cards actually
 * mounts. Sized to `max(1, visibleCount * 3)` — a screen's worth either side
 * of what's visible — and positioned around the focused card when focus just
 * changed (an explicit navigation should render its target immediately, not
 * wait for scroll), or around the current first-visible card otherwise;
 * clamped so the window never runs past the level's bounds.
 * @param firstVisible - the level's current first-visible index (from {@link updateVisibleWindow}).
 * @param visibleCount - the level's current column count.
 * @param total - how many cards the level has.
 * @param focusedIndex - the currently focused card's index, or `-1` when the focused session
 *   isn't among the level's current cards (e.g. archived, or mid cross-level navigation).
 * @param focusChanged - true on the render where focus just moved to a new card.
 * @returns `start`/`count` describing the slice of cards to render.
 */
export function computeRenderWindow(
  firstVisible: number,
  visibleCount: number,
  total: number,
  focusedIndex: number,
  focusChanged: boolean,
): { start: number; count: number } {
  const windowCount = Math.max(1, visibleCount * 3)
  // Center on the focused card only when focus actually changed AND that
  // card is present in this level (focusedIndex >= 0) — mirrors 码头
  // SessionCarousel.tsx:102-104, where `renderStart` falls back to the
  // firstVisible-based `defaultRenderStart` whenever `focusedIndex < 0`.
  const base = focusChanged && focusedIndex >= 0 ? focusedIndex - visibleCount : firstVisible - visibleCount
  const maxStart = Math.max(0, total - windowCount)
  const start = Math.max(0, Math.min(maxStart, base))
  const count = Math.min(total, windowCount)
  return { start, count }
}
