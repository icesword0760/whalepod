/**
 * Where every DAG node sits on the canvas — a line-for-line port of 码头's
 * `apps/desktop/src/renderer/src/dag/dag-layout.ts`, with its constants kept
 * literally so the relationship overlay reads the way 码头's does.
 *
 * The shape of the algorithm: one column per depth, columns 370px apart
 * (`NODE_WIDTH` 260 + `X_GAP` 110, `dag-layout.ts:31,35,89`), cards stacked
 * `Y_GAP` 26 apart inside a column (`:36,94`), and every column vertically
 * centred against the tallest column in the WHOLE graph
 * (`:82-84` — `maxColumnHeight` is a single figure over all columns, not a
 * per-neighbour comparison). Pure: no React, no DOM, no clock.
 *
 * Three things are easy to get wrong and are therefore spelled out:
 *
 * - **Card height is a function of the TITLE alone** ({@link nodeHeight},
 *   `dag-layout.ts:122-126`). The body preview and the working directory never
 *   change it. 码头 wraps the title at 18 width units per line, counting a
 *   CJK/full-width character as 1 and everything else as .55, and adds 18px per
 *   extra line on top of the 174px baseline. Cards are a fixed frame with a
 *   clamped body, so the only thing that can push the frame taller is a title
 *   that wraps.
 * - **In-column order is pure creation order** ({@link stableNodeOrder},
 *   `:151-154`). This is NOT the carousel's `orderSiblings`, which sorts by
 *   most-recent interaction descending (`carousel/graph.ts:48-53`). 码头 runs
 *   the same two orders side by side for the same reason: the DAG is a map of
 *   how the tree grew, the carousel is a queue of what you touched last.
 * - **Cycles must converge.** {@link layoutGraph} keeps 码头's `visiting`
 *   guard (`:49-52`) even though `placement/set` now rejects cycles on write:
 *   documents written before that validation existed can still contain one,
 *   and a DAG that spins forever is worse than a DAG that draws a strange
 *   column.
 *
 * Provider-agnostic by inheritance: this module only ever reads `sessionId`,
 * `parentSessionId`, `createdSeq` and `title` off a {@link DagNodeView}, none
 * of which carry a provider dimension.
 *
 * One deliberate subtraction from the port: 码头's `visibleLayers` also
 * returns `ghostDepths`, which nothing in `DagCanvas.tsx` consumes and whose
 * only styling hook (`dag.css:74-75`'s `.dag-ghost-layer`) is likewise
 * unreferenced. Dead on arrival, so it is not carried over. 码头's
 * `searchGraph`/`searchScore` also live in that file; here they belong to
 * `dag/search.ts`, whose scoring tiers differ (no worktree branch dimension in
 * DSH).
 * @module dsh-plugin-matou-layout/src/client/dag/layout
 */

import type { DagEdgeView, DagGraphView, DagNodeView } from './graph.ts'

/** One card, placed. Coordinates are world-space; the viewport transform is applied at render time. */
export interface DagLayoutNode {
  readonly sessionId: string
  /** Distance from this node's root, counted through parents that are in the graph. */
  readonly depth: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** The projection this card renders from, passed through untouched. */
  readonly node: DagNodeView
}

/** One link, with the two endpoints already resolved to world coordinates. */
export interface DagLayoutEdge {
  readonly fromSessionId: string
  readonly toSessionId: string
  readonly relationKind: DagEdgeView['relationKind']
  /** Right edge of the parent card, vertically centred (`dag-layout.ts:110`). */
  readonly from: { readonly x: number; readonly y: number }
  /** Left edge of the child card, vertically centred (`dag-layout.ts:111`). */
  readonly to: { readonly x: number; readonly y: number }
}

/** The whole placed graph plus the canvas it needs. */
export interface DagLayout {
  readonly nodes: DagLayoutNode[]
  readonly edges: DagLayoutEdge[]
  readonly nodeById: Map<string, DagLayoutNode>
  /** Column index → the cards in it, already in {@link stableNodeOrder}. */
  readonly nodesByDepth: Map<number, DagLayoutNode[]>
  readonly width: number
  readonly height: number
  /** How many columns the canvas has; at least 1, even for an empty graph. */
  readonly depthCount: number
}

/** `dag-layout.ts:31` */
const NODE_WIDTH = 260
/** `dag-layout.ts:32`. Kept at 码头's figure by decision D-3 — the card frame is fixed, only the title wraps. */
const NODE_BASE_HEIGHT = 174
/** `dag-layout.ts:33` */
const TITLE_LINE_HEIGHT = 18
/** `dag-layout.ts:34` */
const TITLE_UNITS_PER_LINE = 18
/** `dag-layout.ts:35` — column pitch is `NODE_WIDTH + X_GAP` = 370. */
const X_GAP = 110
/** `dag-layout.ts:36` */
const Y_GAP = 26
/** The margin the canvas leaves around the placed graph, split evenly (`dag-layout.ts:84,89,117-118`). */
const CANVAS_MARGIN = 50

/**
 * Place every node and edge of one scene's graph.
 *
 * Depth comes from walking each node's parent chain iteratively with a
 * memo (`dag-layout.ts:41-68`) — iterative rather than recursive so a long
 * lineage cannot overflow the stack, memoised so the whole pass stays linear.
 * Two escapes from that walk, both load-bearing:
 *
 * - A chain that revisits an id it is already walking is a cycle: the base
 *   depth resets to 0 and the path is numbered from there, so both nodes end
 *   up somewhere finite instead of looping (`:49-52`).
 * - A chain that runs into a parent this graph does not contain ends with a
 *   base depth of −1, which makes the node itself depth 0 — an "orphan" is
 *   drawn as a root rather than hidden (`:57`). `buildDagGraph` already drops
 *   such parent links, but historic data and any future caller may not.
 * @param graph - the scene projection from `dag/graph.ts`.
 * @returns the placed nodes and edges plus the canvas size they need.
 */
export function layoutGraph(graph: DagGraphView): DagLayout {
  const byId = new Map<string, DagNodeView>(graph.nodes.map((node) => [node.sessionId, node]))
  const depthMemo = new Map<string, number>()
  const depthFor = (node: DagNodeView): number => {
    const known = depthMemo.get(node.sessionId)
    if (known !== undefined) return known
    const path: DagNodeView[] = []
    const visiting = new Set<string>()
    let cursor: DagNodeView | undefined = node
    let baseDepth = 0
    while (cursor) {
      const memo = depthMemo.get(cursor.sessionId)
      if (memo !== undefined) {
        baseDepth = memo
        break
      }
      if (visiting.has(cursor.sessionId)) {
        baseDepth = 0
        break
      }
      visiting.add(cursor.sessionId)
      path.push(cursor)
      cursor = cursor.parentSessionId === undefined ? undefined : byId.get(cursor.parentSessionId)
    }
    if (!cursor) baseDepth = -1
    for (let index = path.length - 1; index >= 0; index -= 1) {
      baseDepth += 1
      depthMemo.set(path[index]!.sessionId, baseDepth)
    }
    return depthMemo.get(node.sessionId) ?? 0
  }

  const groups = new Map<number, DagNodeView[]>()
  for (const node of graph.nodes) {
    const depth = depthFor(node)
    const peers = groups.get(depth) ?? []
    peers.push(node)
    groups.set(depth, peers)
  }
  for (const peers of groups.values()) peers.sort(stableNodeOrder)

  const columns = [...groups.entries()].sort(([left], [right]) => left - right).map(([depth, peers]) => {
    const heights = peers.map(({ title }) => nodeHeight(title))
    const height = heights.reduce((sum, value) => sum + value, 0) + Math.max(0, peers.length - 1) * Y_GAP
    return { depth, peers, heights, height }
  })
  const maxColumnHeight = Math.max(NODE_BASE_HEIGHT, ...columns.map(({ height }) => height))

  const nodes = columns.flatMap(({ depth, peers, heights, height }) => {
    let y = CANVAS_MARGIN + (maxColumnHeight - height) / 2
    return peers.map((node, index): DagLayoutNode => {
      const cardHeight = heights[index]!
      const positioned = {
        sessionId: node.sessionId,
        depth,
        x: CANVAS_MARGIN + depth * (NODE_WIDTH + X_GAP),
        y,
        width: NODE_WIDTH,
        height: cardHeight,
        node,
      }
      y += cardHeight + Y_GAP
      return positioned
    })
  })

  const nodeById = new Map<string, DagLayoutNode>(nodes.map((node) => [node.sessionId, node]))
  const nodesByDepth = new Map<number, DagLayoutNode[]>()
  for (const node of nodes) {
    const peers = nodesByDepth.get(node.depth) ?? []
    peers.push(node)
    nodesByDepth.set(node.depth, peers)
  }

  const edges = graph.edges.flatMap((edge): DagLayoutEdge[] => {
    const parent = nodeById.get(edge.parentSessionId)
    const child = nodeById.get(edge.childSessionId)
    if (!parent || !child) return []
    return [{
      fromSessionId: parent.sessionId,
      toSessionId: child.sessionId,
      relationKind: edge.relationKind,
      from: { x: parent.x + parent.width, y: parent.y + parent.height / 2 },
      to: { x: child.x, y: child.y + child.height / 2 },
    }]
  })

  const depthCount = Math.max(1, ...nodes.map(({ depth }) => depth + 1))
  return {
    nodes,
    edges,
    nodeById,
    nodesByDepth,
    depthCount,
    width: 2 * CANVAS_MARGIN + depthCount * NODE_WIDTH + Math.max(0, depthCount - 1) * X_GAP,
    height: 2 * CANVAS_MARGIN + maxColumnHeight,
  }
}

/**
 * How tall one card is — decided entirely by how many lines its TITLE wraps to
 * (`dag-layout.ts:122-126`). The body preview, the working directory and the
 * child count are all clamped inside a fixed frame and never affect this.
 *
 * The line count is a width estimate, not a measurement: iterate by code point
 * (so an astral character counts once, not twice), charge a CJK or full-width
 * character one unit and everything else .55 of one, and allow 18 units per
 * line.
 * @param title - the node's display title.
 * @returns the card height in px, at least {@link NODE_BASE_HEIGHT}.
 */
function nodeHeight(title: string): number {
  const units = [...title].reduce((sum, character) => sum + (isWideCharacter(character) ? 1 : .55), 0)
  const lines = Math.max(1, Math.ceil(units / TITLE_UNITS_PER_LINE))
  return NODE_BASE_HEIGHT + (lines - 1) * TITLE_LINE_HEIGHT
}

/**
 * Whether a character occupies a full column cell. The ranges are 码头's
 * verbatim (`dag-layout.ts:129`): CJK radicals through unified ideographs,
 * compatibility ideographs, full-width forms, and full-width currency signs.
 * @param character - one code point's worth of text.
 * @returns true when it should be charged one full width unit.
 */
function isWideCharacter(character: string): boolean {
  return /[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u.test(character)
}

/**
 * The columns drawn at full detail around a focus: the focus's own depth plus
 * `radius` either side, clipped to the columns that exist
 * (`dag-layout.ts:132-140`). A focus session that is not in the graph falls
 * back to depth 0, which is what the overlay shows before anything is focused.
 *
 * Everything outside this band is 码头's aggregate-card territory, resolved by
 * `dag/render-model.ts`. Note that the overlay does not call this directly for
 * the general case — `dag/viewport.ts`'s `visibleDepthsFor` switches to the
 * viewport's own centre column once the user has panned more than one column
 * away, or panning off to the side would leave the canvas blank.
 * @param layout - the placed graph.
 * @param focusSessionId - the session the overlay is centred on.
 * @param radius - how many columns either side stay at full detail.
 * @returns the ascending list of full-detail column indices.
 */
export function visibleLayers(
  layout: DagLayout,
  focusSessionId: string,
  radius = 1,
): { readonly fullDepths: number[] } {
  const focusDepth = layout.nodeById.get(focusSessionId)?.depth ?? 0
  const all = Array.from({ length: layout.depthCount }, (_, depth) => depth)
  return { fullDepths: all.filter((depth) => Math.abs(depth - focusDepth) <= radius) }
}

/**
 * In-column ordering: creation order, then session id
 * (`dag-layout.ts:151-154`). Total and deterministic, so the same graph always
 * draws the same picture.
 *
 * **Not the carousel's order.** `carousel/graph.ts:48-53`'s `orderSiblings`
 * sorts siblings by most-recent interaction descending; reusing it here would
 * make the DAG reshuffle itself every time the user typed. 码头 keeps the two
 * apart for the same reason. Also used by `dag/search.ts` to break ties
 * between equally-scoring hits.
 * @param left - one node.
 * @param right - the other node.
 * @returns a negative number when `left` sorts first, positive when `right` does.
 */
export function stableNodeOrder(left: DagNodeView, right: DagNodeView): number {
  return (left.createdSeq ?? Number.MAX_SAFE_INTEGER) - (right.createdSeq ?? Number.MAX_SAFE_INTEGER) ||
    left.sessionId.localeCompare(right.sessionId)
}
