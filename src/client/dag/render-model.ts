/**
 * What one frame of the DAG overlay actually draws — a port of 码头's
 * `apps/desktop/src/renderer/src/dag/dag-render-model.ts`, which turns the
 * complete layout into a bounded render model: near columns stay real session
 * cards, everything farther collapses into one truthful aggregate card per
 * branch, and edges survive only while both of their endpoints are on screen.
 *
 * This is the module that keeps the overlay cheap without a virtualization
 * library (none may be added — tsdown inlines every dependency into
 * `lib/client.js`). The whole budget is two numbers, 码头's verbatim
 * (`dag-render-model.ts:46-47`), and one of them is easy to misread:
 *
 * - **400 caps real cards and aggregate cards TOGETHER**, not each
 *   (`:82-85`). When any far layer exists, one slot is reserved for the
 *   aggregate before the real cards are sliced, so `maxItems` genuinely is the
 *   number of DOM items the canvas mounts.
 * - **800 caps edges**, applied after the both-ends-visible filter (`:90-92`).
 *
 * Three deliberate DSH divergences from 码头, all decided in the S4 plan and
 * repeated here so nobody "restores parity" by accident:
 *
 * 1. **The third column is 「已完成」, not 「出错」.** 码头 counts
 *    running / needs-input / error (`:219-227`); DSH's `SessionSummary`
 *    carries no failure bit at all — `workbench/status.ts` already filed that
 *    absence, and its three-state dot (`done` / `ongoing` / `warning`) is the
 *    honest vocabulary here. {@link DagAggregateCounts} therefore reads
 *    `running` / `waiting` / `done`, mapped straight off `DagNodeView.state`.
 *    `StateDotState` also has an `'error'` member for other DSH surfaces;
 *    `sessionDotState` never returns it, and it is deliberately counted in NO
 *    column rather than folded into `waiting`.
 * 2. **`sessionCount` is the only conserved quantity.** An idle session has no
 *    dot state, so it raises `sessionCount` without entering any column —
 *    exactly as in 码头, where idle/interrupted/exited do the same. The
 *    invariant is `running + waiting + done ≤ sessionCount`; anyone writing
 *    the equality will be wrong the first time a quiet session is folded in.
 * 3. **码头's `archivedAt` override is not ported** (`:221`). DSH archives are
 *    dropped upstream by `workbench/known-sessions.ts` and `archivedSessionIds`,
 *    so `dag/graph.ts` never emits an archived node and there is nothing to
 *    override.
 *
 * Pure: no React, no DOM, no clock. The viewport figures (`fullDepths`,
 * `worldBounds`, `centerWorldY`) are computed by `dag/viewport.ts` and passed
 * in, so this module never measures anything itself.
 * @module dsh-plugin-matou-layout/src/client/dag/render-model
 */

import type { DagLayout, DagLayoutEdge, DagLayoutNode } from './layout.ts'
import type { DagNodeView } from './graph.ts'

/** The world-space rectangle currently on screen, already padded (`dag/viewport.ts`'s `worldBoundsOf`). */
export interface DagWorldBounds {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/**
 * How the sessions behind one aggregate card are doing. DSH's three honest
 * states, NOT 码头's running/needs-input/error — see the module doc, point 1.
 * These three need not add up to `sessionCount`: idle sessions are counted
 * nowhere.
 */
export interface DagAggregateCounts {
  /** `state === 'ongoing'`. */
  readonly running: number
  /** `state === 'warning'` — the session is waiting for the user. */
  readonly waiting: number
  /** `state === 'done'`. */
  readonly done: number
}

/** One folded card standing in for a whole far branch (or, past budget, for several of them). */
export interface DagAggregateItem {
  /** Stable React key; also what `capAggregates` breaks distance ties on. */
  readonly key: string
  /** `'branch'` — one far branch. `'layer-overflow'` — several branches merged because the budget ran out. */
  readonly kind: 'branch' | 'layer-overflow'
  /** Which side of the visible band this sits on. */
  readonly direction: 'before' | 'after'
  /** The session the branch hangs from: the branch head for `after`, the tree root for `before`. */
  readonly branchRootId: string
  /** The member whose position this card borrows, and the session a click on it should navigate to. */
  readonly targetSessionId: string
  /** Every session folded into this card. */
  readonly sessionIds: readonly string[]
  /** `sessionIds.length`, precomputed — the conserved quantity (module doc, point 2). */
  readonly sessionCount: number
  readonly counts: DagAggregateCounts
  /** Geometry copied verbatim from the {@link DagAggregateItem.targetSessionId} card, so the fold looks like a stack. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly minimumDepth: number
  readonly maximumDepth: number
}

/** Everything one frame draws. */
export interface DagRenderModel {
  readonly realNodes: readonly DagLayoutNode[]
  readonly aggregates: readonly DagAggregateItem[]
  readonly edges: readonly DagLayoutEdge[]
}

export interface DagRenderModelInput {
  readonly layout: DagLayout
  /** The columns drawn at full detail, from `dag/viewport.ts`'s `visibleDepthsFor`. */
  readonly fullDepths: ReadonlySet<number>
  readonly worldBounds: DagWorldBounds
  /** World-space y of the viewport's centre; decides which card an aggregate borrows its position from. */
  readonly centerWorldY: number
  /** The session the overlay is centred on. Its card is never culled, and always sorts first. */
  readonly previewSessionId: string
  /** Real cards and aggregate cards COMBINED (`dag-render-model.ts:82-85`). Defaults to 400. */
  readonly maxItems?: number
  /** Defaults to 800. */
  readonly maxEdges?: number
}

/** Mutable accumulator for {@link countStatuses}; the published shape is readonly. */
interface MutableCounts {
  running: number
  waiting: number
  done: number
}

/** One far branch, before it is priced against the budget. */
interface AggregateGroup {
  readonly direction: DagAggregateItem['direction']
  readonly branchRootId: string
  readonly members: DagLayoutNode[]
}

/** `dag-render-model.ts:46` — the ceiling on real cards PLUS aggregate cards. */
const DEFAULT_MAX_ITEMS = 400
/** `dag-render-model.ts:47` */
const DEFAULT_MAX_EDGES = 800

/**
 * Cut the whole layout down to one frame.
 *
 * The order of operations is load-bearing and matches 码头's
 * (`dag-render-model.ts:63-94`):
 *
 * 1. Far nodes are grouped first, because whether any group exists decides
 *    whether a slot is reserved out of `maxItems` before the real cards are
 *    sliced. Without the reservation an over-budget graph would drop its
 *    aggregates entirely and silently lose sessions off the edge of the map.
 * 2. Real candidates are the cards in the visible columns that intersect the
 *    padded world viewport, plus the preview card unconditionally, ordered by
 *    distance from the viewport's vertical centre so the budget is spent on
 *    what the user is looking at.
 * 3. Edges are filtered against the union of real ids and aggregate TARGET
 *    ids — the aggregate stands in for its target, so the link into a folded
 *    branch stays drawn instead of the branch appearing detached.
 * @param input - the layout plus the viewport figures `dag/viewport.ts` computed.
 * @returns the cards, folded cards and edges this frame should mount.
 */
export function buildDagRenderModel(input: DagRenderModelInput): DagRenderModel {
  const {
    layout, fullDepths, worldBounds, centerWorldY, previewSessionId,
    maxItems = DEFAULT_MAX_ITEMS, maxEdges = DEFAULT_MAX_EDGES,
  } = input
  if (fullDepths.size === 0 || maxItems <= 0) return { realNodes: [], aggregates: [], edges: [] }

  const minimumFullDepth = Math.min(...fullDepths)
  const maximumFullDepth = Math.max(...fullDepths)
  const groups = aggregateFarNodes(layout, minimumFullDepth, maximumFullDepth)
  const realCandidates = [...fullDepths].sort((left, right) => left - right)
    .flatMap((depth) => layout.nodesByDepth.get(depth) ?? [])
    .filter((node) => node.sessionId === previewSessionId || intersects(node, worldBounds))
    .sort((left, right) => {
      if (left.sessionId === previewSessionId) return -1
      if (right.sessionId === previewSessionId) return 1
      return Math.abs(centerY(left) - centerWorldY) - Math.abs(centerY(right) - centerWorldY) ||
        left.depth - right.depth || left.y - right.y || left.sessionId.localeCompare(right.sessionId)
    })

  const realBudget = groups.length > 0 ? Math.max(0, maxItems - 1) : maxItems
  const realNodes = realCandidates.slice(0, realBudget)
  const aggregateBudget = Math.max(0, maxItems - realNodes.length)
  const aggregates = capAggregates(groups, aggregateBudget, centerWorldY)
  const visibleIds = new Set([
    ...realNodes.map(({ sessionId }) => sessionId),
    ...aggregates.map(({ targetSessionId }) => targetSessionId),
  ])
  const edges = layout.edges
    .filter((edge) => visibleIds.has(edge.fromSessionId) && visibleIds.has(edge.toSessionId))
    .slice(0, maxEdges)

  return { realNodes, aggregates, edges }
}

/**
 * Group every node outside the visible band into branches
 * (`dag-render-model.ts:97-125`). The two sides group differently on purpose:
 *
 * - **After** (deeper than the band): by the branch HEAD, the ancestor sitting
 *   in the first hidden column. So "everything below this child" folds into
 *   one card per child, which is the shape the user reasons about.
 * - **Before** (shallower): by the tree ROOT, because from inside a deep layer
 *   the interesting fact about the hidden ancestry is which lineage it is.
 *
 * Both maps are filled in `layout.nodes` order, which is ascending depth
 * (`dag/layout.ts` flattens columns low-to-high), so a parent's entry always
 * exists before its child reads it.
 * @param layout - the placed graph.
 * @param minimumFullDepth - first visible column.
 * @param maximumFullDepth - last visible column.
 * @returns the groups, ordered by direction then branch root so the result is deterministic.
 */
function aggregateFarNodes(layout: DagLayout, minimumFullDepth: number, maximumFullDepth: number): AggregateGroup[] {
  const rootBySessionId = new Map<string, string>()
  const descendantBranchBySessionId = new Map<string, string>()
  const groups = new Map<string, AggregateGroup>()

  for (const positioned of layout.nodes) {
    const parentSessionId = positioned.node.parentSessionId
    rootBySessionId.set(
      positioned.sessionId,
      parentSessionId === undefined ? positioned.sessionId : rootBySessionId.get(parentSessionId) ?? parentSessionId,
    )

    if (positioned.depth > maximumFullDepth) {
      const inherited = parentSessionId === undefined ? undefined : descendantBranchBySessionId.get(parentSessionId)
      const branchRootId = positioned.depth === maximumFullDepth + 1
        ? positioned.sessionId
        : inherited ?? positioned.sessionId
      descendantBranchBySessionId.set(positioned.sessionId, branchRootId)
      addToGroup(groups, 'after', branchRootId, positioned)
    } else if (positioned.depth < minimumFullDepth) {
      addToGroup(groups, 'before', rootBySessionId.get(positioned.sessionId) ?? positioned.sessionId, positioned)
    }
  }

  return [...groups.values()].sort((left, right) =>
    left.direction.localeCompare(right.direction) || left.branchRootId.localeCompare(right.branchRootId))
}

/**
 * Append one node to its group, creating the group on first sight.
 * @param groups - the accumulator, keyed `direction:branchRootId`.
 * @param direction - which side of the visible band the node is on.
 * @param branchRootId - the group's branch root.
 * @param member - the node to fold in.
 */
function addToGroup(
  groups: Map<string, AggregateGroup>,
  direction: DagAggregateItem['direction'],
  branchRootId: string,
  member: DagLayoutNode,
): void {
  const key = `${direction}:${branchRootId}`
  const existing = groups.get(key)
  if (existing) existing.members.push(member)
  else groups.set(key, { direction, branchRootId, members: [member] })
}

/**
 * Price the groups against what is left of the item budget
 * (`dag-render-model.ts:139-153`). Nearest to the viewport centre wins the
 * individual cards; whatever does not fit is merged into ONE
 * `layer-overflow` card rather than dropped, so no session ever silently
 * disappears from the count.
 * @param groups - every far branch.
 * @param budget - how many cards may be produced.
 * @param centerWorldY - world-space y of the viewport centre.
 * @returns the aggregate cards, nearest first.
 */
function capAggregates(groups: readonly AggregateGroup[], budget: number, centerWorldY: number): DagAggregateItem[] {
  if (budget <= 0 || groups.length === 0) return []
  const sorted = groups.map((group) => toAggregate(group, centerWorldY))
    .sort((left, right) =>
      Math.abs(centerY(left) - centerWorldY) - Math.abs(centerY(right) - centerWorldY) ||
      left.key.localeCompare(right.key))
  if (sorted.length <= budget) return sorted
  if (budget === 1) return [mergeAggregates(sorted, centerWorldY)]
  return [...sorted.slice(0, budget - 1), mergeAggregates(sorted.slice(budget - 1), centerWorldY)]
}

/**
 * Turn one group into a card (`dag-render-model.ts:155-175`).
 * @param group - the far branch.
 * @param centerWorldY - world-space y of the viewport centre, for {@link chooseTarget}.
 * @returns the card, wearing its target member's geometry.
 */
function toAggregate(group: AggregateGroup, centerWorldY: number): DagAggregateItem {
  const target = chooseTarget(group, centerWorldY)
  const depths = group.members.map(({ depth }) => depth)
  const sessionIds = group.members.map(({ sessionId }) => sessionId)
  return {
    key: `aggregate:${group.direction}:${group.branchRootId}`,
    kind: 'branch',
    direction: group.direction,
    branchRootId: group.branchRootId,
    targetSessionId: target.sessionId,
    sessionIds,
    sessionCount: sessionIds.length,
    counts: countStatuses(group.members.map(({ node }) => node)),
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    minimumDepth: Math.min(...depths),
    maximumDepth: Math.max(...depths),
  }
}

/**
 * Fold several cards into one (`dag-render-model.ts:177-207`). The merged card
 * keeps the shared direction when the inputs agree and otherwise borrows the
 * nearest one's, sits where the nearest input sat, and — the point of the
 * whole exercise — carries the SUM of their session counts and columns, so the
 * conservation invariant holds no matter how tight the budget got.
 * @param items - the cards being merged, already nearest-first.
 * @param centerWorldY - world-space y of the viewport centre.
 * @returns one `layer-overflow` card covering all of them.
 */
function mergeAggregates(items: readonly DagAggregateItem[], centerWorldY: number): DagAggregateItem {
  const target = items.reduce((nearest, item) =>
    Math.abs(centerY(item) - centerWorldY) < Math.abs(centerY(nearest) - centerWorldY) ? item : nearest)
  const first = items[0]!
  const direction = items.every((item) => item.direction === first.direction) ? first.direction : target.direction
  const minimumDepth = Math.min(...items.map(({ minimumDepth: depth }) => depth))
  const maximumDepth = Math.max(...items.map(({ maximumDepth: depth }) => depth))
  const sessionIds = items.flatMap(({ sessionIds: ids }) => [...ids])
  return {
    key: `aggregate:${direction}:layer-overflow:${minimumDepth}-${maximumDepth}`,
    kind: 'layer-overflow',
    direction,
    branchRootId: `layer:${minimumDepth}-${maximumDepth}`,
    targetSessionId: target.targetSessionId,
    sessionIds,
    sessionCount: sessionIds.length,
    counts: items.reduce<MutableCounts>((counts, item) => ({
      running: counts.running + item.counts.running,
      waiting: counts.waiting + item.counts.waiting,
      done: counts.done + item.counts.done,
    }), emptyCounts()),
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    minimumDepth,
    maximumDepth,
  }
}

/**
 * Which member's seat the card takes (`dag-render-model.ts:209-217`): of the
 * members in the group's BOUNDARY column — the shallowest for an `after`
 * group, the deepest for a `before` one, i.e. the one closest to the visible
 * band — the one nearest the viewport's vertical centre. That is what makes a
 * folded branch look like it is hanging off the edge of what is drawn rather
 * than floating in an arbitrary column.
 * @param group - the far branch; never empty.
 * @param centerWorldY - world-space y of the viewport centre.
 * @returns the member whose geometry the card borrows.
 */
function chooseTarget(group: AggregateGroup, centerWorldY: number): DagLayoutNode {
  const depths = group.members.map(({ depth }) => depth)
  const boundaryDepth = group.direction === 'after' ? Math.min(...depths) : Math.max(...depths)
  return group.members.filter(({ depth }) => depth === boundaryDepth)
    .reduce((nearest, member) =>
      Math.abs(centerY(member) - centerWorldY) < Math.abs(centerY(nearest) - centerWorldY) ? member : nearest)
}

/**
 * Tally the dot states behind one aggregate. DSH's three-state vocabulary, not
 * 码头's — see the module doc, points 1 and 3. An idle node (no `state`) and
 * the unreachable `'error'` state both fall through into no column, which is
 * why the three figures only ever bound `sessionCount` from below.
 * @param nodes - the folded sessions' projections.
 * @returns the per-column tallies.
 */
function countStatuses(nodes: readonly DagNodeView[]): DagAggregateCounts {
  return nodes.reduce<MutableCounts>((counts, node) => {
    if (node.state === 'ongoing') counts.running += 1
    else if (node.state === 'warning') counts.waiting += 1
    else if (node.state === 'done') counts.done += 1
    return counts
  }, emptyCounts())
}

/**
 * A fresh zeroed tally.
 * @returns `{ running: 0, waiting: 0, done: 0 }`.
 */
function emptyCounts(): MutableCounts {
  return { running: 0, waiting: 0, done: 0 }
}

/**
 * Whether a card overlaps the padded world viewport (`dag-render-model.ts:233-236`).
 * Touching counts: the comparisons are inclusive, so a card whose bottom edge
 * lands exactly on the viewport's top edge is still drawn.
 * @param node - the placed card.
 * @param bounds - the padded world viewport.
 * @returns true when any part of the card is inside.
 */
function intersects(node: DagLayoutNode, bounds: DagWorldBounds): boolean {
  return node.x + node.width >= bounds.left && node.x <= bounds.right &&
    node.y + node.height >= bounds.top && node.y <= bounds.bottom
}

/**
 * The vertical centre of anything with a top and a height.
 * @param item - a card or an aggregate.
 * @returns its world-space centre y.
 */
function centerY(item: { readonly y: number; readonly height: number }): number {
  return item.y + item.height / 2
}
