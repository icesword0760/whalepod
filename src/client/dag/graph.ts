/**
 * The session relationship graph the S4 DAG overlay draws — this slice's one
 * ORIGINAL adaptation rather than a port.
 *
 * 码头 has a ready-made `SessionGraphView` (`hierarchy/hierarchy-types.ts:63-76`),
 * built Runtime-side and pushed to the renderer; `dag-layout.ts:38` just
 * consumes it. DSH has no equivalent, and the obvious substitute is WRONG:
 * `MatouSceneView.sessions` can never contain a subagent, because
 * `workbench/known-sessions.ts:24` drops `origin === 'subagent'` upstream of
 * the entire org derivation — so `deriveOrgView`'s scenes are already
 * subagent-free before anyone asks. Spec §4's source table nevertheless wants
 * subagents 「进 DAG 不进轮播」, so they are recovered here from DSH's full
 * `sessions.ids` list by walking lineage (multi-level, cycle-guarded).
 *
 * Three things this module owns, all of which 码头 got for free:
 *
 * - **Which sessions are nodes** — the scene's placed sessions ∪ their
 *   subagent descendants, minus archived rows and rows the session list has
 *   no summary for.
 * - **Which kind each edge is** — {@link relationKindOf} is deliberately a
 *   TOTAL function. An explicit `MatouPlacement.relationKind` wins when it is
 *   there, and the pre-`relationKind` derivation rule answers when it is not,
 *   so historic documents and rows written by write paths that predate the
 *   field still draw correct edges.
 * - **What the card's body text is** — {@link lastTurnPreview}, D-3's answer
 *   to 码头's 「终端最后 4 行」 (`dag-layout.ts:163`), which DSH has no
 *   equivalent of. The匹配面 of the DAG search (Task 5) must stay identical to
 *   this, or a hit would highlight a card whose visible text lacks the query.
 *
 * Provider-agnostic by construction: 码头's node view also carries
 * `currentMode` (`hierarchy-types.ts:36`, a four-way Claude/Codex/team/shell
 * enum), `worktree`, `git` and `sharedWorkingDirectory` (`:48-50`). DSH has no
 * such dimensions and this projection deliberately has no field for them.
 *
 * Pure: no React, no DOM, no `Date.now()`, no i18n — the caller passes the
 * already-translated `untitledLabel`.
 * @module dsh-plugin-matou-layout/src/client/dag/graph
 */

import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { MatouRelationKind } from '../../org/model.ts'
import { sessionHasUnread } from '../notifications/selectors.ts'
import type { AgentNotification } from '../notifications/store.ts'
import { sessionDotState } from '../workbench/status.ts'

/** Every display fact one DAG node needs, resolved once so no view re-derives any of it. */
export interface DagNodeView {
  readonly sessionId: string
  /** The node's parent WITHIN this graph; absent for a root (see the "excluded parent" rule in {@link buildDagGraph}). */
  readonly parentSessionId?: string
  /**
   * In-column ordering key: the scene's placement ordinal. Subagents have no
   * placement row and take `Number.MAX_SAFE_INTEGER`, the same fallback 码头
   * uses for a missing `siblingCreatedSeq` (`dag-layout.ts:152`), with
   * `sessionId` supplying the total order underneath.
   */
  readonly createdSeq: number
  readonly title: string
  /** DSH's `SessionSummary.cwd`; `''` when the row has none. */
  readonly cwd: string
  /** Three-state dot; idle is `undefined` — 「有事才亮」, see `workbench/status.ts`. */
  readonly state?: StateDotState
  /**
   * Direct children DRAWN IN THIS GRAPH, subagents included. Deliberately a
   * different count from the card header's 「子会话 N」 badge, which excludes
   * subagents (`carousel/header-seats.tsx`'s `directChildrenOf`): that badge
   * answers 「能下钻到哪一层」, this one answers 「这张图上它下面挂了几个」.
   */
  readonly childCount: number
  /** DSH's `SessionSummary.updatedAt`; `0` means no recorded activity. */
  readonly lastActivityAt: number
  /** Card body text — see {@link lastTurnPreview}. `''` when nothing is projected. */
  readonly preview: string
  /** S5's unread bit for this session (`notifications/selectors.ts`'s `sessionHasUnread`). */
  readonly hasNotice: boolean
  /** A subagent session: it exists in this graph but in NO carousel layer, so clicking it needs the T-2 fallback. */
  readonly subagent: boolean
}

/** One parent→child link, already classified. */
export interface DagEdgeView {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly relationKind: MatouRelationKind
}

/** The whole projection for one scene. */
export interface DagGraphView {
  readonly sceneId: string
  readonly nodes: readonly DagNodeView[]
  readonly edges: readonly DagEdgeView[]
}

/**
 * The `SessionSummary` fields this projection reads (DSH's client-side row,
 * `api/session-controller/src/client/sessions/service.ts:39-62`), narrowed so
 * a fixture need not build a whole summary. Everything but `running` is
 * optional on the real type — a cold session may carry none of it.
 */
export interface DagSessionFacts {
  /** DSH's own parent link (`header.parentSession`); a placement parent outranks it. */
  readonly parentId?: string | undefined
  readonly origin?: 'subagent' | undefined
  readonly displayTitle?: string | undefined
  readonly cwd?: string | undefined
  readonly running: boolean
  readonly completed?: boolean | undefined
  readonly updatedAt?: number | undefined
  /**
   * DSH's `SessionSummary.projectionValues`. Typed `unknown` on purpose — see
   * {@link lastTurnPreview} for why this plugin does not link the projection
   * package to get the real key map.
   */
  readonly projectionValues?: unknown
}

/** The `MatouPlacement` fields this projection reads (`src/org/model.ts:39-78`). */
export interface DagPlacementFacts {
  readonly parentSessionId?: string | undefined
  /** 「显式说了就在根层」 — blocks the fallback to DSH's own `parentId`, exactly like `carousel/graph.ts:48`. */
  readonly explicitRoot?: true | undefined
  readonly relationKind?: MatouRelationKind | undefined
}

export interface DagGraphInput {
  readonly sceneId: string
  /** The scene's placed sessions, `MatouSceneView.sessions` — subagent-free by construction. */
  readonly sceneSessionRefs: readonly { readonly sessionId: string; readonly ordinal: number }[]
  /** DSH's whole session list (`sessions.ids`), the only place subagent rows exist. */
  readonly allSessionIds: readonly string[]
  readonly summaryOf: (sessionId: string) => DagSessionFacts | undefined
  readonly placementOf: (sessionId: string) => DagPlacementFacts | undefined
  /** Sessions DSH has archived; excluded outright, and they break lineage chains that run through them. */
  readonly archivedIds?: Iterable<string>
  /** Sessions awaiting user input (the workbench's pending set); feeds the 「等待输入」 dot. */
  readonly pendingSessionIds?: ReadonlySet<string>
  readonly notifications?: readonly AgentNotification[]
  /** Already-translated placeholder for a session with no `displayTitle`; this module stays i18n-free. */
  readonly untitledLabel: string
}

/**
 * The card's body text: the last turn's assistant response, falling back to
 * that same turn's prompt.
 *
 * D-3's substitute for 码头's 「终端最后 4 行输出」 (`dag-layout.ts:163`'s
 * `latestLines`), which has no DSH equivalent — DSH sessions are not PTYs.
 * DSH's own `turnOutline` projection is the honest analogue: bounded previews
 * (prompt ≤ 50, response ≤ 120 code units, both whitespace-collapsed to a
 * SINGLE line by `session-turn-outline/src/projection.ts:29-31, 36-50` — the
 * 「最多三行」 is the card CSS's `-webkit-line-clamp`, not newlines in the
 * data), provider-agnostic, and supplied for cold sessions too via the host's
 * projection cache.
 *
 * **The one forced cast in this module, and why.** `SessionProjectionMap` is
 * an open interface each DSH package widens by declaration merging
 * (`session-turn-outline/src/types.ts:41-51`). This plugin deliberately does
 * NOT link `@deepseek-ai/dsh-session-turn-outline` — that would add a
 * devDependency for a three-field read-only type and drag
 * `@deepseek-ai/dsh-session-projection`'s module resolution into this repo's
 * tsconfig — so the key is invisible to our compile surface. It is read once,
 * through one cast, and narrowed by hand-written runtime guards below.
 *
 * The guards are load-bearing, not defensive padding: a host bundle without
 * the turn-outline plugin has no such key at all, and both host supply paths
 * (`api/session-controller/src/control.ts:79-97` for loaded sessions,
 * `.../list.ts:327-350` for cold ones) may legitimately produce nothing.
 * @param projectionValues - `SessionSummary.projectionValues`, or anything at all.
 * @returns the preview text, or `''` when there is none.
 */
export function lastTurnPreview(projectionValues: unknown): string {
  const outline = (projectionValues as Record<string, unknown> | undefined | null)?.turnOutline
  if (!Array.isArray(outline)) return ''
  const last: unknown = outline.at(-1)
  if (typeof last !== 'object' || last === null) return ''
  const { prompt, response } = last as { readonly prompt?: unknown; readonly response?: unknown }
  if (typeof response === 'string' && response !== '') return response
  return typeof prompt === 'string' ? prompt : ''
}

/**
 * Classify one parent edge. TOTAL by contract: it answers for every input,
 * including rows written before `MatouPlacement.relationKind` existed and
 * rows whose write path never sets it. Never require the explicit field.
 *
 * Order of decision:
 * 1. An explicit `placement.relationKind` wins outright — it is what the write
 *    path actually observed at fork time, which no read-side rule can recover.
 * 2. A subagent is `derived-from` its host (spec §4): its state is its own,
 *    it is only structurally attached.
 * 3. No placement parent means the edge comes solely from DSH's own
 *    `header.parentSession`, and that link IS a real fork of state.
 * 4. A placement parent equal to DSH's parent is that same real fork.
 * 5. Anything else is a structural attachment to a session the child did not
 *    copy state from — 「⑂ Fork 会话」 landing beside its source, or a session
 *    created inside a drilled-down layer.
 * @param placement - the session's placement row, if it has one.
 * @param summary - the session's DSH summary, if the list has one.
 * @returns the edge kind to draw.
 */
export function relationKindOf(
  placement: DagPlacementFacts | undefined,
  summary: DagSessionFacts | undefined,
): MatouRelationKind {
  if (placement?.relationKind !== undefined) return placement.relationKind
  if (summary?.origin === 'subagent') return 'derived-from'
  if (placement?.parentSessionId === undefined) return 'forked-from'
  return placement.parentSessionId === summary?.parentId ? 'forked-from' : 'derived-from'
}

/**
 * Project one scene into the graph the DAG overlay draws.
 *
 * Node set:
 * - **Seeds** — the scene's placed sessions, minus archived rows and ids the
 *   session list has no summary for. Subagent-free already (see the module doc).
 * - **Recovered subagents** — every un-archived `origin === 'subagent'` row in
 *   `allSessionIds` whose `parentId` chain climbs through subagent links only
 *   and lands on a seed. Multi-level (a subagent's subagent's subagent) and
 *   cycle-guarded: a `visited` set abandons a chain that revisits an id rather
 *   than looping forever, which matters because `placement/set` performs no
 *   cycle validation at all and DSH lineage is only as sane as the host. A
 *   chain is also abandoned at any link with no summary or an archived one —
 *   neither can appear in this graph, so nothing beyond it is connected to the
 *   scene. Requiring the intermediate links to be subagents keeps ANOTHER
 *   scene's subagent out of this graph when the two scenes' sessions share a
 *   fork ancestor.
 *
 * Parent resolution mirrors `carousel/graph.ts:42-50` exactly (explicit root
 * blocks the fallback; a placement parent outranks DSH's own), plus the
 * repair `carousel/nodes.ts:119` already established: **a parent outside the
 * node set does not hide its child** — the child is reported as a root instead
 * of pointing at a session this graph does not draw.
 * @param input - the scene, the session facts, the placement rows, and the exclusions.
 * @returns nodes in seed order followed by recovered subagents in session-list order, plus one edge per drawn parent link.
 */
export function buildDagGraph(input: DagGraphInput): DagGraphView {
  const archived = new Set(input.archivedIds ?? [])
  const pending = input.pendingSessionIds ?? new Set<string>()
  const notifications = input.notifications ?? []

  const createdSeqOf = new Map<string, number>()
  const memberIds: string[] = []
  for (const ref of input.sceneSessionRefs) {
    if (createdSeqOf.has(ref.sessionId) || archived.has(ref.sessionId)) continue
    if (input.summaryOf(ref.sessionId) === undefined) continue
    createdSeqOf.set(ref.sessionId, ref.ordinal)
    memberIds.push(ref.sessionId)
  }
  const seedIds = new Set(memberIds)

  for (const sessionId of input.allSessionIds) {
    if (seedIds.has(sessionId) || archived.has(sessionId)) continue
    if (input.summaryOf(sessionId)?.origin !== 'subagent') continue
    if (!climbsToSeed(sessionId, seedIds, archived, input.summaryOf)) continue
    createdSeqOf.set(sessionId, Number.MAX_SAFE_INTEGER)
    memberIds.push(sessionId)
  }
  const members = new Set(memberIds)

  const parentOf = new Map<string, string>()
  const childCounts = new Map<string, number>()
  for (const sessionId of memberIds) {
    const placement = input.placementOf(sessionId)
    if (placement?.explicitRoot === true) continue
    const resolved = placement?.parentSessionId ?? input.summaryOf(sessionId)?.parentId
    if (resolved === undefined || !members.has(resolved) || resolved === sessionId) continue
    parentOf.set(sessionId, resolved)
    childCounts.set(resolved, (childCounts.get(resolved) ?? 0) + 1)
  }

  const nodes: DagNodeView[] = []
  const edges: DagEdgeView[] = []
  for (const sessionId of memberIds) {
    const summary = input.summaryOf(sessionId)
    const parentSessionId = parentOf.get(sessionId)
    const state = sessionDotState({
      running: summary?.running === true,
      completed: summary?.completed,
      pending: pending.has(sessionId),
    })
    nodes.push({
      sessionId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      createdSeq: createdSeqOf.get(sessionId) ?? Number.MAX_SAFE_INTEGER,
      title: summary?.displayTitle ?? input.untitledLabel,
      cwd: summary?.cwd ?? '',
      ...(state === undefined ? {} : { state }),
      childCount: childCounts.get(sessionId) ?? 0,
      lastActivityAt: summary?.updatedAt ?? 0,
      preview: lastTurnPreview(summary?.projectionValues),
      hasNotice: sessionHasUnread(notifications, sessionId),
      subagent: summary?.origin === 'subagent',
    })
    if (parentSessionId === undefined) continue
    edges.push({
      parentSessionId,
      childSessionId: sessionId,
      relationKind: relationKindOf(input.placementOf(sessionId), summary),
    })
  }
  return { sceneId: input.sceneId, nodes, edges }
}

/**
 * Whether a subagent's DSH lineage reaches one of this scene's seeds through
 * subagent links only. Cycle-guarded; see {@link buildDagGraph}'s doc for why
 * each abandonment condition is there.
 * @param sessionId - the subagent row being considered.
 * @param seedIds - the scene's placed sessions.
 * @param archived - sessions DSH has archived.
 * @param summaryOf - the session-list lookup.
 * @returns true when the row belongs in this scene's graph.
 */
function climbsToSeed(
  sessionId: string,
  seedIds: ReadonlySet<string>,
  archived: ReadonlySet<string>,
  summaryOf: (sessionId: string) => DagSessionFacts | undefined,
): boolean {
  const visited = new Set<string>([sessionId])
  let cursor = summaryOf(sessionId)?.parentId
  while (cursor !== undefined) {
    if (seedIds.has(cursor)) return true
    if (visited.has(cursor) || archived.has(cursor)) return false
    visited.add(cursor)
    const facts = summaryOf(cursor)
    if (facts === undefined || facts.origin !== 'subagent') return false
    cursor = facts.parentId
  }
  return false
}
