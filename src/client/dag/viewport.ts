/**
 * The DAG canvas's pan/zoom arithmetic, lifted out of 码头's `DagCanvas.tsx`
 * where it lives inline in the component body (`:23`, `:31-45`, `:99-100`,
 * `:106-111`, `:291-304`, `:337-340`).
 *
 * Everything here is a pure function of a {@link DagTransform} plus the
 * viewport's pixel size. **This module never touches the DOM**: 码头 reads
 * `viewportRef.current?.clientWidth` at each of those call sites, which is
 * exactly what made the arithmetic untestable there. The element measurement
 * (and 码头's `?? 1000` / `|| 1000` fallbacks for a not-yet-mounted ref) is the
 * canvas component's job; the numbers below are this module's.
 *
 * Coordinate spaces, since three of them meet in this file:
 *
 * - **World space** — where `dag/layout.ts` places cards. Column `d` starts at
 *   `x = 50 + 370 * d`.
 * - **Screen space** — pixels inside the canvas viewport. `screen = world *
 *   scale + offset`, so `world = (screen − offset) / scale`.
 * - **Depth** — the column index a world x falls in, which is what the render
 *   model culls by.
 *
 * The one thing in here that is easy to get wrong and expensive to get wrong is
 * {@link visibleDepthsFor}. 码头's "focus ±1 column" band is **not** static: once
 * the user has panned more than one column away from the focused card, the band
 * follows the *viewport's* centre column instead (`DagCanvas.tsx:34-36`). Drop
 * that switch and the ±1 band stays pinned to a card that has scrolled off, so
 * dragging the canvas sideways lands the user on a blank screen — every column
 * they can actually see has been culled as "far".
 *
 * Provider-agnostic by construction: nothing here reads a session field at all.
 * @module dsh-plugin-matou-layout/src/client/dag/viewport
 */

import type { DagLayout } from './layout.ts'
import { visibleLayers } from './layout.ts'

/** The canvas pan/zoom state: world-space content is drawn at `world * scale + (x, y)`. */
export interface DagTransform {
  /** Horizontal screen-space offset of world origin, in px. */
  readonly x: number
  /** Vertical screen-space offset of world origin, in px. */
  readonly y: number
  /** Zoom factor, always within `[MIN_SCALE, MAX_SCALE]` once it has been through {@link clampDagScale}. */
  readonly scale: number
}

/** The world-space rectangle {@link worldBoundsOf} reports. */
export interface DagWorldBounds {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** Just enough of a `DagLayoutNode` to centre on it; the real one from `dag/layout.ts` is assignable. */
export interface DagNodeBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where the canvas starts, and where 「恢复 100%」 returns to
 * (`DagCanvas.tsx:23`, `:106-111`).
 *
 * Reset goes back to this whole transform rather than merely setting
 * `scale = 1`, which is 码头's explicit comment at `:107-109`: resetting the
 * zoom around wherever the user happened to have panned to is not a reset, and
 * the 40px top inset is what keeps the first row of cards clear of the floating
 * toolbar.
 */
export const INITIAL_TRANSFORM: DagTransform = { x: 70, y: 40, scale: 1 }

/** `DagCanvas.tsx:292` */
const MIN_SCALE = .4
/** `DagCanvas.tsx:292` */
const MAX_SCALE = 2
/** Column pitch in world space: `NODE_WIDTH` 260 + `X_GAP` 110 (`dag-layout.ts:31,35`, spelled out at `DagCanvas.tsx:32`). */
const COLUMN_PITCH = 370
/** Where column 0 starts in world space (`dag-layout.ts:89`, spelled out at `DagCanvas.tsx:32`). */
const FIRST_COLUMN_X = 50
/** How far past the left and right viewport edges still counts as "worth drawing" (`DagCanvas.tsx:41-42`). */
const WORLD_MARGIN_X = 360
/** How far past the top and bottom viewport edges still counts as "worth drawing" (`DagCanvas.tsx:43-44`). */
const WORLD_MARGIN_Y = 260
/** How many columns the viewport may drift from the focused card before the visible band follows the viewport (`DagCanvas.tsx:34`). */
const VIEWPORT_DRIFT_COLUMNS = 1

/**
 * Hold a zoom factor inside 码头's range (`DagCanvas.tsx:291-293`).
 *
 * Also the guard on the persistence path: `dag/viewport-store.ts` runs every
 * value it reads back out of `localStorage` through this, so a hand-edited
 * entry cannot hand the canvas a scale of 50 and a permanently white screen.
 * @param scale - any candidate zoom factor.
 * @returns the same value clamped to `[0.4, 2]`.
 */
export function clampDagScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

/**
 * Zoom to `scale` while keeping whatever is under `point` under `point`
 * (`DagCanvas.tsx:295-304`).
 *
 * This is what makes `Ctrl/Cmd + 滚轮` (and trackpad pinch, which reaches the
 * browser the same way) feel like the canvas rather than the window is moving:
 * the world coordinate beneath the pointer is computed at the OLD scale and
 * re-projected at the NEW one, so the offset absorbs the difference. Zooming
 * that only changes `scale` looks correct at the centre of the screen and
 * throws the card under the cursor off it everywhere else.
 *
 * The clamp happens first, so a wheel gesture that overshoots the range still
 * pivots around the pointer instead of drifting.
 * @param transform - the current pan/zoom.
 * @param scale - the desired zoom factor, clamped by {@link clampDagScale}.
 * @param point - the screen-space fixed point, in viewport pixels.
 * @returns the transform that zooms about `point`.
 */
export function zoomAt(transform: DagTransform, scale: number, point: { readonly x: number; readonly y: number }): DagTransform {
  const nextScale = clampDagScale(scale)
  const worldX = (point.x - transform.x) / transform.scale
  const worldY = (point.y - transform.y) / transform.scale
  return { x: point.x - worldX * nextScale, y: point.y - worldY * nextScale, scale: nextScale }
}

/**
 * Pan so one card's centre sits at the viewport's centre, leaving the zoom
 * alone (`DagCanvas.tsx:97-101`).
 *
 * The card's centre is scaled but the viewport's half-size is not: the former
 * is a world coordinate, the latter is already in screen pixels.
 * @param transform - the current pan/zoom; its `scale` is carried through unchanged.
 * @param node - the card to centre, in world coordinates.
 * @param viewportWidth - the canvas viewport's width in px.
 * @param viewportHeight - the canvas viewport's height in px.
 * @returns the transform that centres the card.
 */
export function centerOnNode(
  transform: DagTransform,
  node: DagNodeBox,
  viewportWidth: number,
  viewportHeight: number,
): DagTransform {
  return {
    x: viewportWidth / 2 - (node.x + node.width / 2) * transform.scale,
    y: viewportHeight / 2 - (node.y + node.height / 2) * transform.scale,
    scale: transform.scale,
  }
}

/**
 * The world-space rectangle worth drawing: the viewport, grown by 360px
 * horizontally and 260px vertically (`DagCanvas.tsx:40-45`).
 *
 * `dag/render-model.ts` keeps the real cards that intersect this and folds the
 * rest into aggregates, so the margin is the overdraw that stops a card from
 * popping in at the edge mid-drag — a little over one column each way, a little
 * over one card each way.
 *
 * **The margins are world-space, added after the division by `scale`.** Adding
 * them before is indistinguishable at 100% zoom and wrong everywhere else: at
 * 40% it would shrink the overdraw to a third of a column exactly when zooming
 * out has made the visible world three times wider.
 * @param transform - the current pan/zoom.
 * @param viewportWidth - the canvas viewport's width in px.
 * @param viewportHeight - the canvas viewport's height in px.
 * @returns the padded world rectangle currently on screen.
 */
export function worldBoundsOf(transform: DagTransform, viewportWidth: number, viewportHeight: number): DagWorldBounds {
  return {
    left: -transform.x / transform.scale - WORLD_MARGIN_X,
    right: (viewportWidth - transform.x) / transform.scale + WORLD_MARGIN_X,
    top: -transform.y / transform.scale - WORLD_MARGIN_Y,
    bottom: (viewportHeight - transform.y) / transform.scale + WORLD_MARGIN_Y,
  }
}

/**
 * 视口纵向中心在世界坐标里的位置（码头 `DagCanvas.tsx:46`）。
 *
 * 与 {@link centerDepthOf} 同构：先把视口中心换算回世界坐标，所以平移量要
 * 减掉、缩放要除掉。渲染模型拿它做两件事——真实卡片按「离视口纵向中心多远」
 * 排序（预算紧张时决定谁被裁），聚合卡借离中心最近那个成员的几何摆放。
 *
 * **为什么放这里而不是留在画布里就地算**（S4 审查 D-1）：它原先内联在
 * `DagCanvas.tsx` 里，于是成了本文件六个算式中唯一没有单测的一条——把它改成
 * `viewportHeight / 2`（丢掉平移与缩放两项），画布那 40 条用例一条都不响，
 * 因为 jsdom 里视口高恒为回退值、测试也没纵向拖远过。症状是纵向拖远后聚合卡
 * 借错成员的位置、预算紧张时真实卡排序偏掉——纯视觉，不报错。
 * @param transform - the current pan/zoom.
 * @param viewportHeight - the canvas viewport's height in px.
 * @returns the world-space y of the viewport's vertical centre.
 */
export function centerWorldYOf(transform: DagTransform, viewportHeight: number): number {
  return (viewportHeight / 2 - transform.y) / transform.scale
}

/**
 * Which column the viewport is centred on (`DagCanvas.tsx:31-32`).
 *
 * The viewport's horizontal centre is converted to world space, offset by where
 * column 0 starts, divided by the column pitch and rounded — so the answer is
 * the nearest column, not the column the centre happens to be inside. Clamped
 * into the columns that exist, which is what makes panning far past either end
 * settle on the first or last column rather than on a column index nothing can
 * be drawn for.
 * @param transform - the current pan/zoom.
 * @param viewportWidth - the canvas viewport's width in px.
 * @param depthCount - how many columns the layout has, at least 1.
 * @returns a column index in `[0, depthCount − 1]`.
 */
export function centerDepthOf(transform: DagTransform, viewportWidth: number, depthCount: number): number {
  const centerWorldX = (viewportWidth / 2 - transform.x) / transform.scale
  const nearest = Math.round((centerWorldX - FIRST_COLUMN_X) / COLUMN_PITCH)
  return Math.max(0, Math.min(depthCount - 1, nearest))
}

/**
 * A column and its two neighbours, clipped to the columns that exist
 * (`DagCanvas.tsx:337-340`). Ascending, and never empty for a layout with at
 * least one column.
 * @param centerDepth - the column at the centre of the band.
 * @param depthCount - how many columns the layout has.
 * @returns the ascending column indices in the band.
 */
export function depthsAround(centerDepth: number, depthCount: number): number[] {
  return [centerDepth - 1, centerDepth, centerDepth + 1].filter((depth) => depth >= 0 && depth < depthCount)
}

/**
 * The columns drawn at full detail right now (`DagCanvas.tsx:30-37`).
 *
 * Two sources, and picking between them is the whole point of this function:
 *
 * - While the viewport is still within one column of the previewed card, the
 *   band is `visibleLayers`' focus ±1 — the card the user is looking at keeps
 *   its parents and children in view even if they sit slightly off screen.
 * - Once the viewport has drifted **more than one column** away, the band
 *   switches to {@link depthsAround} the viewport's own centre column.
 *
 * The second branch is not an optimisation, it is a correctness fix: the render
 * model culls everything outside this band into aggregate cards, so a band that
 * stayed pinned to the focused card would cull every column the user has just
 * dragged into view. Dragging two columns sideways would clear the screen.
 *
 * A `previewSessionId` that is not in the layout falls back to depth 0, which is
 * `visibleLayers`' own behaviour (`dag-layout.ts:134`) and is what the overlay
 * shows for a scene whose focused session has no card.
 * @param layout - the placed graph from `dag/layout.ts`.
 * @param previewSessionId - the card the overlay is currently previewing.
 * @param transform - the current pan/zoom.
 * @param viewportWidth - the canvas viewport's width in px.
 * @returns the ascending list of full-detail column indices.
 */
export function visibleDepthsFor(
  layout: DagLayout,
  previewSessionId: string,
  transform: DagTransform,
  viewportWidth: number,
): number[] {
  const centerDepth = centerDepthOf(transform, viewportWidth, layout.depthCount)
  const previewDepth = layout.nodeById.get(previewSessionId)?.depth ?? 0
  return Math.abs(centerDepth - previewDepth) > VIEWPORT_DRIFT_COLUMNS
    ? depthsAround(centerDepth, layout.depthCount)
    : visibleLayers(layout, previewSessionId).fullDepths
}
