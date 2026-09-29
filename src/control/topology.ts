/**
 * The control plane's view of the workbench: every card an in-workbench Agent
 * can address, with the ordinals the user sees.
 *
 * **This module composes; it does not decide.** Every judgement it needs —
 * who is visible, whose parent is whose, which order a layer is in, what the
 * 1-based 工作区/事项/页签 ordinals are — already has exactly one implementation
 * on the client side, and those implementations are imported here IN PLACE
 * (`client/org/derive.ts`, `client/workbench/known-sessions.ts`,
 * `client/carousel/nodes.ts`, `client/carousel/graph.ts`). They are pure data
 * transforms with no React, no DOM and no browser API, so they bundle into the
 * host cleanly. They are deliberately NOT moved and NOT copied: moving them
 * would collide with client work happening in parallel, and copying them would
 * let the two orderings drift apart silently — and the ordering is the whole
 * product promise here. 设计稿 §「排序键是一等公民」 states the hard
 * precondition: 「AI 说『第 3 个会话』必须与用户看到的第 3 个一致」. The 同源
 * 断言 in `tests/control-topology.spec.ts` is what keeps that true.
 *
 * **Why the carousel's order is also the CORRECT control-plane order (D-S7-3).**
 * 码头 does not use its carousel order for `left`/`right`/`sibling:N`; it uses
 * `compareProjectedTarget`, whose keys are window → workspace → task → canvas →
 * depth → session ordinal → id (`apps/runtime/src/control/host-topology-projector.ts:312-320`),
 * where `session.ordinal` is itself the 1-based position inside the sibling
 * group (`:215`, `compareSibling` at `:283-287` = 最近交互 DESC → 创建序 ASC →
 * id ASC). The divergence 码头 has is entirely in the keys ABOVE the sibling
 * group. In DSH those keys cannot differ across an addressable set: there is no
 * window dimension at all, and the only ordinals this plane exposes are within
 * 「调用者所在层」and 「调用者的子会话」— two sets that are by construction the
 * same workspace, same task, same scene and same depth. Every high-order key is
 * therefore constant, and `compareProjectedTarget` reduces to `orderSiblings`.
 * So reusing the carousel's ordering is not a shortcut; it is the same answer.
 *
 * **One deliberate divergence from the carousel (D-S7-2).**
 * `selectKnownSessionIds` keeps a blank session visible while it is the
 * client's CURRENT session. The host has no such notion, so `currentId` is
 * `undefined` here. Consequence: a session that is both blank and unplaced is
 * visible in the carousel to the user who has it selected, but is not
 * addressable from the control plane. That is harmless — it has nothing to
 * read and no turn to interrupt — and it is on purpose, not a defect to
 * "fix" by inventing a current-session concept on the host.
 *
 * **Cycles and duplicates.** `placement/set` validates nothing about
 * `parentSessionId`, so the document can express a cycle (a session can even be
 * its own parent). Layers are walked from the roots, so a cycle's members are
 * simply never reached — exactly as in the carousel, where no drill path leads
 * to them either; they are dropped rather than guessed at. Separately, the
 * `reached` set makes the walk idempotent: `deriveOrgView` routes
 * `workspace.sessionIds` entry by entry, so a duplicated id there would
 * otherwise yield the same card twice, each with its own ordinal — an
 * ambiguity `sibling:N` must never inherit.
 * @module dsh-plugin-matou-layout/src/control/topology
 */

import { childrenOfLevel } from '../client/carousel/graph.ts'
import type { CarouselNode } from '../client/carousel/graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from '../client/carousel/nodes.ts'
import { deriveOrgView } from '../client/org/derive.ts'
import { selectKnownSessionIds } from '../client/workbench/known-sessions.ts'
import type { MatouOrgState } from '../org/model.ts'

/**
 * The `SessionSummary` fields the projection reads
 * (`packages/api/session-controller/src/types.ts:155-165`), narrowed so a test
 * fixture need not build a whole summary. Provider-agnostic on purpose: not one
 * of these is Claude-specific, and nothing here may ever branch on a provider.
 */
export interface ControlSessionFacts {
  /** DSH's own parent link; a placement parent outranks it (see `graph.ts#effectiveParentOf`). */
  readonly parentId?: string | undefined
  readonly origin?: 'subagent' | undefined
  readonly updatedAt?: number | undefined
  readonly blank?: boolean | undefined
  readonly running?: boolean | undefined
  /** `session.header.cwd` is optional in DSH; the target simply omits the field when it is absent. */
  readonly cwd?: string | undefined
  readonly title?: string | undefined
}

/** One DSH workspace as `workspaceRegistry.list()` reports it. */
export interface ControlWorkspaceFacts {
  readonly workspaceId: string
  readonly title: string
  /** The workspace's manual session order; the fallback routing order for unplaced sessions. */
  readonly sessionIds: readonly string[]
}

export interface ProjectControlInput {
  readonly workspaces: readonly ControlWorkspaceFacts[]
  readonly summaryOf: (sessionId: string) => ControlSessionFacts | undefined
  readonly archivedSessionIds: readonly string[]
  readonly org: MatouOrgState
}

/** A named container with the stable 1-based ordinal `deriveOrgView` assigns it. */
export interface ControlWorkspaceRef {
  readonly id: string
  readonly title: string
  readonly ordinal: number
}

/** A task container; `title` may be the virtual 「默认」 group's. */
export type ControlTaskRef = ControlWorkspaceRef

/** A scene (页签) container. Named `name` rather than `title`, matching `MatouScene`. */
export interface ControlSceneRef {
  readonly id: string
  readonly name: string
  readonly ordinal: number
}

/** One addressable card. `ref` shape copied from 码头 `host-topology-projector.ts:275-277`. */
export interface ControlTarget {
  readonly ref: string
  readonly sessionId: string
  readonly title: string
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly workspace: ControlWorkspaceRef
  readonly task: ControlTaskRef
  readonly scene: ControlSceneRef
  /** Drill depth inside its scene; 0 is the root layer. */
  readonly depth: number
  readonly parentRef?: string
  /** Direct children, in their own layer's order. */
  readonly childRefs: readonly string[]
  /** 1-based position inside its layer — the number `sibling:N` indexes. */
  readonly levelOrdinal: number
}

/**
 * A session's stable control-plane reference.
 * @param sessionId - the session id.
 * @returns the `session:<id>` ref.
 */
export function controlRefOf(sessionId: string): string {
  return `session:${sessionId}`
}

interface LayeredNode {
  readonly node: CarouselNode
  readonly depth: number
  readonly levelOrdinal: number
}

interface SceneLayers {
  readonly layered: readonly LayeredNode[]
  /** The ids the walk actually reached; everything else in the scene is cycle-bound or a duplicate. */
  readonly reached: ReadonlySet<string>
}

/**
 * Walk one scene's projected nodes layer by layer, from the roots.
 * @param nodes - the scene's carousel nodes.
 * @returns each reachable node with its depth and 1-based position in its layer, plus the reachable id set.
 */
function layersOf(nodes: readonly CarouselNode[]): SceneLayers {
  const layered: LayeredNode[] = []
  const reached = new Set<string>()
  const walk = (parentId: string | undefined, depth: number): void => {
    const level = childrenOfLevel(nodes, parentId)
    const entered: CarouselNode[] = []
    for (const node of level) {
      // A duplicated id in `workspace.sessionIds` is the way the same session
      // can be offered twice; see the module doc. The ordinal counts ENTERED
      // nodes rather than the raw index, so a skipped duplicate cannot punch a
      // hole in the layer's numbering — `sibling:N` has to stay contiguous.
      if (reached.has(node.sessionId)) continue
      reached.add(node.sessionId)
      entered.push(node)
      layered.push({ node, depth, levelOrdinal: entered.length })
    }
    for (const node of entered) walk(node.sessionId, depth + 1)
  }
  walk(undefined, 0)
  return { layered, reached }
}

/**
 * Project every addressable card in the workbench.
 *
 * The returned array is ordered 工作区 → 事项 → 页签 → depth → 层内序号 →
 * sessionId, i.e. 码头's `compareProjectedTarget` minus the window key DSH does
 * not have. Callers that need an addressable set ask {@link levelOf} or
 * {@link childrenOf} rather than indexing this array.
 * @param input - the three host sources: DSH workspaces + session summaries, DSH's archive set, and the plugin's org document.
 * @returns one target per visible session.
 */
export function projectControlTargets(input: ProjectControlInput): readonly ControlTarget[] {
  const knownSessionIds = selectKnownSessionIds({
    ids: input.workspaces.flatMap(workspace => workspace.sessionIds),
    summaryOf: (id: string) => {
      const facts = input.summaryOf(id)
      return facts === undefined ? undefined : { blank: facts.blank === true, origin: facts.origin }
    },
    archivedIds: input.archivedSessionIds,
    // Deliberate: the host has no "current session". See the module doc.
    currentId: undefined,
    org: input.org,
  })
  const view = deriveOrgView({ workspaces: input.workspaces, knownSessionIds, org: input.org })
  const placementsBySession = placementsBySessionOf(input.org.placements)
  const interactionAtBySession = new Map(
    input.org.placements.flatMap(placement => (
      placement.interactionAt === undefined ? [] : [[placement.sessionId, placement.interactionAt] as const]
    )),
  )
  const targets: ControlTarget[] = []

  for (const workspace of view) {
    const workspaceRef: ControlWorkspaceRef = {
      id: workspace.workspaceId, title: workspace.title, ordinal: workspace.ordinal,
    }
    for (const task of workspace.tasks) {
      const taskRef: ControlTaskRef = { id: task.id, title: task.title, ordinal: task.ordinal }
      for (const scene of task.scenes) {
        const sceneRef: ControlSceneRef = { id: scene.id, name: scene.name, ordinal: scene.ordinal }
        const ordinals = new Map(scene.sessions.map(ref => [ref.sessionId, ref.ordinal]))
        // Wired exactly as `AppFrame.tsx:216-226` wires the carousel: the
        // scene's own sessions, the shared projection, the scene's placement
        // order as the creation-order tie-break.
        const nodes = projectCarouselNodes({
          ids: scene.sessions.map(ref => ref.sessionId),
          summaryOf: input.summaryOf,
          placementsBySession,
          archivedIds: input.archivedSessionIds,
          ordinalOf: (id: string) => ordinals.get(id) ?? 0,
          // 与轮播同源的第二项：已提交的排序键。前端「聚焦期间钉住位置」若只做
          // 在内存里，这里算出来的序号就会与屏幕分叉；落在落位文档上，两边天然
          // 一致（`org/model.ts` 的 `interactionAt`）。
          interactionAtOf: (id: string) => interactionAtBySession.get(id),
          manualOrderOf: id => input.org.placements.find(row => row.sessionId === id)?.manualOrder,
        })
        const { layered, reached } = layersOf(nodes)
        const childRefsOf = (sessionId: string): readonly string[] => childrenOfLevel(nodes, sessionId)
          .filter(child => reached.has(child.sessionId))
          .map(child => controlRefOf(child.sessionId))

        const sceneTargets = layered.map(({ node, depth, levelOrdinal }): ControlTarget => {
          const facts = input.summaryOf(node.sessionId)
          return {
            ref: controlRefOf(node.sessionId),
            sessionId: node.sessionId,
            title: facts?.title ?? '',
            running: facts?.running === true,
            blank: facts?.blank === true,
            ...(facts?.cwd === undefined ? {} : { cwd: facts.cwd }),
            workspace: workspaceRef,
            task: taskRef,
            scene: sceneRef,
            depth,
            ...(node.parentId === undefined ? {} : { parentRef: controlRefOf(node.parentId) }),
            childRefs: childRefsOf(node.sessionId),
            levelOrdinal,
          }
        })
        sceneTargets.sort((left, right) => left.depth - right.depth
          || left.levelOrdinal - right.levelOrdinal
          || left.sessionId.localeCompare(right.sessionId))
        targets.push(...sceneTargets)
      }
    }
  }
  return targets
}

/**
 * The layer `sessionId` sits in — same scene, same effective parent — including
 * `sessionId` itself, in the order the user sees. This is the set `left` /
 * `right` / `sibling:N` address; 码头's sibling group likewise contains the
 * caller (`host-topology-projector.ts:89-94`).
 * @param targets - the projection.
 * @param sessionId - the calling session.
 * @returns the layer in `levelOrdinal` order, or an empty array when the session is not in the projection.
 */
export function levelOf(targets: readonly ControlTarget[], sessionId: string): readonly ControlTarget[] {
  const self = targets.find(target => target.sessionId === sessionId)
  if (self === undefined) return []
  return targets
    .filter(target => target.scene.id === self.scene.id && target.parentRef === self.parentRef)
    .sort((left, right) => left.levelOrdinal - right.levelOrdinal)
}

/**
 * The direct children of `sessionId`, in their own layer's order — the set
 * `child:N` addresses.
 * @param targets - the projection.
 * @param sessionId - the parent session.
 * @returns the children in `levelOrdinal` order; empty when there are none.
 */
export function childrenOf(targets: readonly ControlTarget[], sessionId: string): readonly ControlTarget[] {
  const parentRef = controlRefOf(sessionId)
  return targets
    .filter(target => target.parentRef === parentRef)
    .sort((left, right) => left.levelOrdinal - right.levelOrdinal)
}
