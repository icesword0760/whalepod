/**
 * The single projection from "DSH sessions + the plugin's placement rows" to
 * the {@link CarouselNode}s every layer/ordering/badge computation runs on
 * (Ruling-20, final-review I2/M2/M8).
 *
 * There used to be three of these, and they disagreed. `AppFrame` built nodes
 * from the active scene's refs (archived rows already dropped upstream by
 * `known-sessions.ts`), while `header-seats.tsx`'s `directChildrenOf` and
 * `actions.ts`'s `nodesOf` both walked the whole session list filtering only
 * subagents. The same card therefore reported 「子会话 1」on DSH's official
 * header and no badge at all on its own compact header; clicking that stale
 * badge drilled into an archived session that exists in no layer (leaving the
 * carousel showing 「当前画布没有活跃会话」while the details column followed
 * it); and the fork dialog's same-layer name check accepted a name through one
 * entry point that the other rejected. One projection, one answer.
 *
 * Two rules live here rather than at the call sites, because they are what
 * "the same answer" means:
 *
 * - **Excluded parents do not hide their children.** A node whose resolved
 *   parent is not itself in the projection (archived, a subagent, or simply
 *   outside the scene being projected) is reported as a ROOT node instead of
 *   pointing at a session no layer contains. Without this a child of an
 *   archived parent belongs to no layer at all — reachable through no card, no
 *   badge, and no reload, since the drill level is deliberately unpersisted.
 *   `actions.ts` keeps that from arising going forward (it re-parents on
 *   removal); this is the read-side repair for rows that already have it.
 * - **A blank session has never interacted.** `lastInteractionAt` is `0` for a
 *   session that has never had a turn, not its `updatedAt`. DSH's `updatedAt`
 *   is `max(createdAt, lastPromptAt)`, so a freshly created card would
 *   otherwise carry the LARGEST timestamp in its layer and `orderSiblings`'s
 *   「最近交互 DESC」would put it leftmost — the opposite of 码头, whose first
 *   sort key is a user-interaction sequence that starts at 0 and therefore
 *   lands a new card at the RIGHT end (spec §3/§7.1 step 5).
 * @module dsh-plugin-matou-layout/src/client/carousel/nodes
 */

import { effectiveParentOf } from './graph.ts'
import type { CarouselNode } from './graph.ts'

/** The `SessionSummary` fields this projection reads — narrowed so fixtures need not build a whole summary. */
export interface NodeSessionFacts {
  /** DSH's own parent link (a placement parent outranks it — see {@link effectiveParentOf}). */
  readonly parentId?: string | undefined
  readonly origin?: 'subagent' | undefined
  /** DSH's `max(header.createdAt, lastPromptAt)`; only consulted for a non-blank session (see the module doc). */
  readonly updatedAt?: number | undefined
  /** DSH's "has never had a turn" bit. */
  readonly blank?: boolean | undefined
}

export interface CarouselNodesInput {
  /** Candidate session ids, in whatever order the caller has them; scoping (e.g. to one scene) is the caller's job. */
  readonly ids: readonly string[]
  readonly summaryOf: (sessionId: string) => NodeSessionFacts | undefined
  /** `MatouPlacement.parentSessionId` keyed by session id ({@link placementsBySessionOf}). */
  readonly placementsBySession: ReadonlyMap<string, string | null | undefined>
  /** Sessions DSH has archived; excluded outright. Defaults to none. */
  readonly archivedIds?: Iterable<string>
  /**
   * Keep subagent sessions in the projection. Defaults to `false` — the
   * carousel excludes them (spec §4), the S4 DAG shows them. One projection
   * with a switch rather than two implementations: the "parent outside the
   * set is promoted to a root" repair below would otherwise have to be
   * written twice and would drift (S3b's I2 was exactly that failure — the
   * official header and the compact header disagreed about archived
   * children because each resolved them separately).
   */
  readonly includeSubagents?: boolean
  /** Stable creation order per session (the scene's placement ordinal); defaults to `0` for every node. */
  readonly manualOrderOf?: (sessionId: string) => number | undefined
  readonly ordinalOf?: (sessionId: string) => number
  /**
   * The COMMITTED sort key from `MatouPlacement.interactionAt`, when the
   * placement has one. Absent (or `undefined` for a given session) falls back
   * to the live value, which is what every pre-`interactionAt` document has.
   *
   * **Both callers must pass the same thing.** The carousel and
   * `control/topology.ts` project through this one function precisely so that
   * 「AI 说的第 3 张」 and 「用户看到的第 3 张」 are the same card; a caller that
   * omits this while the other supplies it puts the two orderings out of step
   * exactly while a card is focused.
   */
  readonly interactionAtOf?: (sessionId: string) => number | undefined
}

/**
 * Fold placement rows into the `sessionId -> parentSessionId` map
 * {@link effectiveParentOf} wants (Task 1's edge DSH itself cannot express —
 * see `MatouPlacement.parentSessionId`'s doc). Loosely typed over just the two
 * fields used, so a bare `{sessionId, parentSessionId}` fixture works without
 * the full `MatouPlacement` shape.
 * @param placements - `OrgMirrorState['org']['placements']` (or an equivalent fixture).
 * @returns a lookup map, one entry per placement row.
 */
export function placementsBySessionOf(
  placements: readonly {
    sessionId: string
    parentSessionId?: string | undefined
    explicitRoot?: true | undefined
  }[],
): ReadonlyMap<string, string | null | undefined> {
  // 盘上是两个追加式字段（见 `MatouPlacement.explicitRoot` 的文档），内存里
  // 折成一个三态值：`null` = 显式根层，`undefined` = 没表过态。
  return new Map(placements.map(placement => [
    placement.sessionId,
    placement.explicitRoot === true ? null : placement.parentSessionId,
  ]))
}

/**
 * Project the carousel's node set. See the module doc for the two rules that
 * make this "one answer" rather than three.
 * @param input - candidate ids, their facts, the placement parents, and the exclusions.
 * @returns one node per surviving id, in `input.ids` order (ordering for display is `orderSiblings`'s job).
 */
export function projectCarouselNodes(input: CarouselNodesInput): CarouselNode[] {
  const archived = new Set(input.archivedIds ?? [])
  const ordinalOf = input.ordinalOf ?? (() => 0)
  const included: { readonly sessionId: string; readonly facts: NodeSessionFacts }[] = []
  for (const sessionId of input.ids) {
    const facts = input.summaryOf(sessionId)
    if (facts === undefined || archived.has(sessionId)) continue
    if (facts.origin === 'subagent' && input.includeSubagents !== true) continue
    included.push({ sessionId, facts })
  }
  const includedIds = new Set(included.map(entry => entry.sessionId))
  return included.map(({ sessionId, facts }) => {
    const resolved = effectiveParentOf(
      sessionId, input.placementsBySession, candidate => input.summaryOf(candidate)?.parentId,
    )
    const parentId = resolved !== undefined && includedIds.has(resolved) ? resolved : undefined
    return {
      sessionId,
      ...(parentId === undefined ? {} : { parentId }),
      // `origin` rides along ONLY when it is actually set — i.e. only for the
      // subagent rows `includeSubagents` let through. It is load-bearing
      // there: `childrenOfLevel` (and `directChildrenOf`/`descendantsOf`
      // above it, the latter feeding cascade archive) keeps subagents out of
      // the carousel's layers by testing `node.origin !== 'subagent'`, and
      // that guard is blind if the projection drops the field. An earlier
      // version of this comment claimed `origin` "is deliberately never
      // emitted" because no subagent could survive the filter — true before
      // the switch existed (S3c 审查 I2), and exactly the kind of stale
      // invariant that sends the next author into the trap.
      ...(facts.origin === undefined ? {} : { origin: facts.origin }),
      // 已提交的排序键优先；缺席才退回 DSH 的 live 值。「聚焦期间不提交」正是
      // 靠这一层实现 spec §7.1 第 5 条的「正在操作的卡不跳位」——判定与写入见
      // `interaction-commit.ts`，落盘字段见 `org/model.ts` 的 `interactionAt`。
      lastInteractionAt: input.interactionAtOf?.(sessionId)
        ?? (facts.blank === true ? 0 : facts.updatedAt ?? 0),
      createdAt: ordinalOf(sessionId),
      ...(input.manualOrderOf?.(sessionId) === undefined ? {} : { manualOrder: input.manualOrderOf!(sessionId)! }),
    }
  })
}
