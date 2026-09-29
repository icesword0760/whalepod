/**
 * Ranked node search for the DAG overlay — 码头's `dag-layout.ts:142-165`,
 * ported with one tier removed and one tier re-aimed.
 *
 * **The removed tier.** 码头 scores a `worktree.branch` hit at 45
 * (`dag-layout.ts:161`). DSH has no worktree and no git dimension anywhere on
 * a session, so {@link DagNodeView} deliberately has no field to score — see
 * `dag/graph.ts`'s module doc. The tier is gone rather than stubbed: a 45 that
 * can never fire is a promise the UI cannot keep (S4 plan T-3).
 *
 * **The re-aimed tier.** 码头's 20 asks whether the terminal's last four lines
 * of output contain the query (`dag-layout.ts:163`'s `latestLines`). DSH
 * sessions are not PTYs; D-3 made the card's body text the last turn's
 * `turnOutline` preview, so that is what 20 matches here. This is not a detail:
 * **the search's match surface must be exactly the text the card shows.** Score
 * anything wider — every turn instead of the last one, the raw projection, a
 * title the card truncates — and the user gets a hit whose card visibly does
 * not contain what they typed.
 *
 * Everything else is 码头's, unchanged: the tiers 100/80/60/30, the
 * `trim().toLocaleLowerCase()` normalization (`:143`), the empty-query早退
 * (`:144`), and the 「分数降序，同分按稳定序」 sort (`:147`).
 *
 * Pure: no React, no DOM, no i18n, no clock.
 * @module dsh-plugin-matou-layout/src/client/dag/search
 */

import type { DagNodeView } from './graph.ts'

/** Title equals the whole query. `dag-layout.ts:158`. */
const TITLE_EXACT = 100
/** Title starts with the query. `dag-layout.ts:159`. */
const TITLE_PREFIX = 80
/** Title contains the query somewhere else. `dag-layout.ts:160`. */
const TITLE_CONTAINS = 60
/** Working directory contains the query. `dag-layout.ts:162`. */
const CWD_CONTAINS = 30
/** The card's body preview contains the query — 码头's 20 was the terminal tail (`dag-layout.ts:163`); D-3 re-aimed it. */
const PREVIEW_CONTAINS = 20

/**
 * Score one node against an ALREADY-NORMALIZED query.
 *
 * The query must arrive trimmed and lower-cased ({@link searchGraph} does it
 * once for the whole list, exactly as `dag-layout.ts:143` does); only the node
 * side is lower-cased here. Behaviour with an empty query is unspecified —
 * `searchGraph` never lets one through.
 *
 * Tiers are checked in descending order and the first hit wins, so a node
 * matching in several places scores its best field, never a sum.
 * @param node - the node's display facts, the same ones its card renders.
 * @param query - the normalized query.
 * @returns 100 / 80 / 60 / 30 / 20, or 0 for no match.
 */
export function searchScore(node: DagNodeView, query: string): number {
  const title = node.title.toLocaleLowerCase()
  if (title === query) return TITLE_EXACT
  if (title.startsWith(query)) return TITLE_PREFIX
  if (title.includes(query)) return TITLE_CONTAINS
  if (node.cwd.toLocaleLowerCase().includes(query)) return CWD_CONTAINS
  if (node.preview.toLocaleLowerCase().includes(query)) return PREVIEW_CONTAINS
  return 0
}

/**
 * In-column order, used only to break score ties so the hit list never
 * reshuffles between two runs of the same query.
 *
 * Same comparator as 码头's private `stableNodeOrder`
 * (`dag-layout.ts:151-154`): creation sequence first, `sessionId` underneath
 * as the total order. Subagents carry `Number.MAX_SAFE_INTEGER` for
 * `createdSeq` (they have no placement row), which lands them after every
 * placed sibling — 码头 gets the same effect from its `?? Number.MAX_SAFE_INTEGER`.
 *
 * Kept private here, as it is in 码头, so search does not depend on the layout
 * module; Task 2's `layout.ts` exports the same comparator for the layout pass.
 */
function stableNodeOrder(left: DagNodeView, right: DagNodeView): number {
  return left.createdSeq - right.createdSeq || left.sessionId.localeCompare(right.sessionId)
}

/**
 * Rank a graph's nodes against a raw user query.
 *
 * An empty or whitespace-only query returns `[]` rather than the whole graph:
 * the overlay shows 「无匹配」 only for a query that actually missed, and an
 * empty search box means 「没在搜」, not 「全都命中」.
 * @param nodes - the graph's nodes; not mutated (the sort runs on a fresh array).
 * @param query - what the user typed, normalized here.
 * @returns the matching nodes, best score first, ties in stable in-column order.
 */
export function searchGraph(nodes: readonly DagNodeView[], query: string): DagNodeView[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return []
  return nodes
    .map(node => ({ node, score: searchScore(node, normalized) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || stableNodeOrder(left.node, right.node))
    .map(({ node }) => node)
}
