/**
 * Pure layer derivation and sibling ordering for the card carousel: given
 * one level's parent, which sessions sit in it and in what order. No React,
 * no DOM — every function here is a plain data transform, kept unit-testable
 * in isolation from the carousel's rendering.
 *
 * `effectiveParentOf` mirrors the layout ordering rule stated in the S3b
 * design spec: an explicit `MatouPlacement` parent always wins over the DSH
 * session's own `parentId`. `orderSiblings` ports 码头
 * `session-graph-repository.ts`'s three-key ORDER BY (最近交互 DESC, 创建序
 * ASC, id ASC) from seq columns to the DSH-side timestamp fields.
 * @module dsh-plugin-matou-layout/src/client/carousel/graph
 */

/** One session as the carousel level machinery sees it. */
export interface CarouselNode {
  readonly sessionId: string
  /** The session's effective parent, already resolved by the caller via {@link effectiveParentOf}. */
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly lastInteractionAt: number
  readonly createdAt: number
  readonly manualOrder?: number
}

/**
 * Resolve one session's effective parent across the placement's THREE states
 * (see `MatouPlacement.parentSessionId`'s doc): an explicit placement parent
 * wins; an explicit `null` means "this session is at the root layer" and
 * blocks the fallback outright; anything else — the session was never placed,
 * or was placed without saying anything about its parent — falls back to the
 * parent DSH itself reports.
 *
 * The `null` case is what keeps a peer fork of a ROOT session correct: DSH
 * records the new session's `parentId` as the session it copied state from,
 * so without the block it would render as that session's child instead of its
 * sibling.
 * @param sessionId - session to resolve.
 * @param placementsBySession - `MatouPlacement.parentSessionId` keyed by session id.
 * @param summaryParentOf - looks up the DSH session summary's own parent id.
 * @returns the effective parent id, or undefined for a root session.
 */
export function effectiveParentOf(
  sessionId: string,
  placementsBySession: ReadonlyMap<string, string | null | undefined>,
  summaryParentOf: (sessionId: string) => string | undefined,
): string | undefined {
  const placed = placementsBySession.get(sessionId)
  if (placed === null) return undefined
  return placed ?? summaryParentOf(sessionId) ?? undefined
}

/**
 * Order siblings the way the carousel presents them: most recently
 * interacted first, ties broken by creation order, then by id for a total
 * order. Stable and non-mutating.
 * @param nodes - sibling nodes to order.
 * @returns a new array, sorted.
 */
export function orderSiblings(nodes: readonly CarouselNode[]): CarouselNode[] {
  return [...nodes].sort((a, b) =>
    ((a.manualOrder ?? Number.MAX_SAFE_INTEGER) - (b.manualOrder ?? Number.MAX_SAFE_INTEGER))
    || b.lastInteractionAt - a.lastInteractionAt
    || a.createdAt - b.createdAt
    || a.sessionId.localeCompare(b.sessionId))
}

/**
 * The ordered children of one level: nodes whose effective parent is
 * `parentId`, excluding subagent sessions (they surface in the S4 DAG, not
 * the carousel).
 * @param nodes - every candidate node, with `parentId` already resolved via {@link effectiveParentOf}.
 * @param parentId - the level's parent id; undefined selects root-level nodes.
 * @returns the level's children, ordered by {@link orderSiblings}.
 */
export function childrenOfLevel(nodes: readonly CarouselNode[], parentId: string | undefined): CarouselNode[] {
  return orderSiblings(nodes.filter(node => node.parentId === parentId && node.origin !== 'subagent'))
}
