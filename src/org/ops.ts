/**
 * Pure reducer over the organization state. Every structural change travels
 * as an op batch: ops apply in order, the first invalid op fails the whole
 * batch, and the input state is never mutated. Naming rules (unique titles,
 * auto-numbering) are UI concerns and stay out of here; this module only
 * guards referential integrity and ordering.
 * @module dsh-plugin-matou-layout/src/org/ops
 */

import type {
  MatouOrgState,
  MatouPlacement,
  MatouRelationKind,
  MatouScene,
  MatouTask,
  MatouTaskStatus,
} from './model.ts'

export type MatouOrgOp =
  | { readonly kind: 'task/create'; readonly id: string; readonly workspaceId: string
    readonly title: string; readonly status?: MatouTaskStatus }
  | { readonly kind: 'task/update'; readonly id: string
    readonly patch: { readonly title?: string; readonly status?: MatouTaskStatus; readonly isPinned?: boolean } }
  | { readonly kind: 'task/move'; readonly id: string; readonly beforeTaskId?: string | null }
  | { readonly kind: 'task/delete'; readonly id: string }
  | { readonly kind: 'scene/create'; readonly id: string; readonly taskId: string
    readonly name: string; readonly titlePinned?: boolean }
  | { readonly kind: 'scene/update'; readonly id: string
    readonly patch: { readonly name?: string; readonly titlePinned?: boolean } }
  | { readonly kind: 'scene/move'; readonly id: string; readonly beforeSceneId?: string | null }
  | { readonly kind: 'scene/delete'; readonly id: string }
  | { readonly kind: 'placement/set'; readonly sessionId: string; readonly taskId: string
    readonly sceneId: string; readonly beforeSessionId?: string | null
    readonly parentSessionId?: string | null
    readonly relationKind?: MatouRelationKind }
  | { readonly kind: 'placement/order'; readonly sessionId: string; readonly order: number }
  | { readonly kind: 'placement/remove'; readonly sessionId: string }
  /**
   * 提交一张卡的排序键（`MatouPlacement.interactionAt`）。只增不减，未落位的
   * 会话静默忽略——判定在 `carousel/interaction-commit.ts`，这里只负责落盘。
   */
  | { readonly kind: 'placement/interaction'; readonly sessionId: string; readonly at: number }

/**
 * Every op kind, frozen.
 *
 * Exists to keep three things that must agree from drifting: this union, the
 * reducer's `switch`, and **`org/wire-schemas.ts`'s `matouOrgOpSchema`** — the
 * validator on the client→host RPC boundary. The third one is the trap: tests
 * call the reducer directly, so a kind missing from the wire schema passes
 * every unit test and then fails only in a real browser, as
 * `client api: matouLayout/apply rejected "request"` with nothing else said.
 * That is exactly how `placement/interaction` shipped broken on 2026-09-07 —
 * 1086 tests green, the feature silently dead on the page.
 *
 * `MatouOrgOpKindsAreExhaustive` below makes TypeScript reject this list if a
 * kind is added to the union and not to it; `org-wire-schemas.spec.ts` walks
 * the schema's own branches and compares them against it.
 */
export const MATOU_ORG_OP_KINDS = Object.freeze([
  'task/create',
  'task/update',
  'task/move',
  'task/delete',
  'scene/create',
  'scene/update',
  'scene/move',
  'scene/delete',
  'placement/set',
  'placement/remove',
  'placement/interaction',
  'placement/order',
] as const)

/**
 * Errors if {@link MATOU_ORG_OP_KINDS} misses a kind the union has, OR invents
 * one it does not. Both directions matter: the first lets a new op slip past
 * the wire-schema test, the second makes that test demand a schema branch for
 * a kind nothing can ever send (this caught a `workspace/ensure` typo the day
 * the list was written)。
 */
export type MatouOrgOpKindsAreExhaustive =
  Exclude<MatouOrgOp['kind'], (typeof MATOU_ORG_OP_KINDS)[number]> extends never
    ? Exclude<(typeof MATOU_ORG_OP_KINDS)[number], MatouOrgOp['kind']> extends never ? true : never
    : never

export interface MatouOrgOpFailure {
  readonly code: 'invalid-op'
  readonly index: number
  readonly reason: string
}

export type MatouOrgApplyOutcome =
  | { readonly ok: true; readonly state: MatouOrgState }
  | { readonly ok: false; readonly error: MatouOrgOpFailure }

/** Mutable working copy the reducer edits between ops. */
interface Working {
  tasks: MatouTask[]
  scenes: MatouScene[]
  placements: MatouPlacement[]
}

class OpError extends Error {}

function fail(reason: string): never {
  throw new OpError(reason)
}

function tailSortKey(rows: readonly { readonly sortKey: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.sortKey), 0) + 1
}

/**
 * Reorder `rows` so `subject` sits before `anchor` (or at the tail when the
 * anchor is null), then renormalize sort keys to 1..n in the new order.
 */
function resequence<T extends { readonly sortKey: number }>(
  rows: readonly T[],
  subject: T,
  anchor: T | null,
  assign: (row: T, sortKey: number) => T,
): T[] {
  const remaining = rows.filter(row => row !== subject)
  const at = anchor === null ? remaining.length : remaining.indexOf(anchor)
  remaining.splice(at, 0, subject)
  return remaining.map((row, index) => assign(row, index + 1))
}

function orderedBySortKey<T extends { readonly sortKey: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.sortKey - right.sortKey)
}

function applyOne(working: Working, op: MatouOrgOp, now: number): void {
  switch (op.kind) {
    case 'task/create': {
      if (working.tasks.some(task => task.id === op.id)) fail(`task '${op.id}' already exists`)
      working.tasks.push({
        id: op.id,
        workspaceId: op.workspaceId,
        title: op.title,
        status: op.status ?? 'planned',
        isPinned: false,
        sortKey: tailSortKey(working.tasks.filter(task => task.workspaceId === op.workspaceId)),
        createdAt: now,
        updatedAt: now,
      })
      return
    }
    case 'task/update': {
      const index = working.tasks.findIndex(task => task.id === op.id)
      if (index === -1) fail(`task '${op.id}' does not exist`)
      const task = working.tasks[index]!
      working.tasks[index] = {
        ...task,
        ...(op.patch.title === undefined ? {} : { title: op.patch.title }),
        ...(op.patch.status === undefined ? {} : { status: op.patch.status }),
        ...(op.patch.isPinned === undefined ? {} : { isPinned: op.patch.isPinned }),
        updatedAt: now,
      }
      return
    }
    case 'task/move': {
      const subject = working.tasks.find(task => task.id === op.id)
      if (subject === undefined) fail(`task '${op.id}' does not exist`)
      let anchor: MatouTask | null = null
      if (op.beforeTaskId !== null && op.beforeTaskId !== undefined) {
        anchor = working.tasks.find(task => task.id === op.beforeTaskId) ?? null
        if (anchor === null) fail(`task '${op.beforeTaskId}' does not exist`)
        if (anchor.workspaceId !== subject.workspaceId) {
          fail(`task '${op.beforeTaskId}' is in another workspace`)
        }
      }
      const siblings = orderedBySortKey(working.tasks.filter(
        task => task.workspaceId === subject.workspaceId,
      ))
      const moved = resequence(
        siblings,
        siblings.find(task => task.id === subject.id)!,
        anchor === null ? null : siblings.find(task => task.id === anchor!.id)!,
        (task, sortKey) => ({ ...task, sortKey, ...(task.id === subject.id ? { updatedAt: now } : {}) }),
      )
      working.tasks = working.tasks
        .filter(task => task.workspaceId !== subject.workspaceId)
        .concat(moved)
      return
    }
    case 'task/delete': {
      if (!working.tasks.some(task => task.id === op.id)) fail(`task '${op.id}' does not exist`)
      const doomedScenes = new Set(
        working.scenes.filter(scene => scene.taskId === op.id).map(scene => scene.id),
      )
      working.tasks = working.tasks.filter(task => task.id !== op.id)
      working.scenes = working.scenes.filter(scene => scene.taskId !== op.id)
      working.placements = working.placements.filter(
        placement => placement.taskId !== op.id && !doomedScenes.has(placement.sceneId),
      )
      return
    }
    case 'scene/create': {
      if (working.scenes.some(scene => scene.id === op.id)) fail(`scene '${op.id}' already exists`)
      if (!working.tasks.some(task => task.id === op.taskId)) {
        fail(`task '${op.taskId}' does not exist (materialize the default task first)`)
      }
      working.scenes.push({
        id: op.id,
        taskId: op.taskId,
        name: op.name,
        titlePinned: op.titlePinned ?? false,
        sortKey: tailSortKey(working.scenes.filter(scene => scene.taskId === op.taskId)),
        createdAt: now,
        updatedAt: now,
      })
      return
    }
    case 'scene/update': {
      const index = working.scenes.findIndex(scene => scene.id === op.id)
      if (index === -1) fail(`scene '${op.id}' does not exist`)
      const scene = working.scenes[index]!
      working.scenes[index] = {
        ...scene,
        ...(op.patch.name === undefined ? {} : { name: op.patch.name }),
        ...(op.patch.titlePinned === undefined ? {} : { titlePinned: op.patch.titlePinned }),
        updatedAt: now,
      }
      return
    }
    case 'scene/move': {
      const subject = working.scenes.find(scene => scene.id === op.id)
      if (subject === undefined) fail(`scene '${op.id}' does not exist`)
      let anchor: MatouScene | null = null
      if (op.beforeSceneId !== null && op.beforeSceneId !== undefined) {
        anchor = working.scenes.find(scene => scene.id === op.beforeSceneId) ?? null
        if (anchor === null) fail(`scene '${op.beforeSceneId}' does not exist`)
        if (anchor.taskId !== subject.taskId) fail(`scene '${op.beforeSceneId}' is in another task`)
      }
      const siblings = orderedBySortKey(working.scenes.filter(
        scene => scene.taskId === subject.taskId,
      ))
      const moved = resequence(
        siblings,
        siblings.find(scene => scene.id === subject.id)!,
        anchor === null ? null : siblings.find(scene => scene.id === anchor!.id)!,
        (scene, sortKey) => ({ ...scene, sortKey, ...(scene.id === subject.id ? { updatedAt: now } : {}) }),
      )
      working.scenes = working.scenes
        .filter(scene => scene.taskId !== subject.taskId)
        .concat(moved)
      return
    }
    case 'scene/delete': {
      if (!working.scenes.some(scene => scene.id === op.id)) fail(`scene '${op.id}' does not exist`)
      working.scenes = working.scenes.filter(scene => scene.id !== op.id)
      working.placements = working.placements.filter(placement => placement.sceneId !== op.id)
      return
    }
    case 'placement/set': {
      const scene = working.scenes.find(candidate => candidate.id === op.sceneId)
      if (scene === undefined) fail(`scene '${op.sceneId}' does not exist`)
      if (scene.taskId !== op.taskId) {
        fail(`scene '${op.sceneId}' does not belong to task '${op.taskId}'`)
      }
      // 语义：op 省略该键 → 保留原父；显式 null → 清父；字符串 → 设置。
      const prev = working.placements.find(placement => placement.sessionId === op.sessionId)
      // op 的三态（省略该键 → 沿用原状态；显式 null → 显式根层；字符串 → 设置）
      // 翻译成盘上的两个**追加式**字段——见 `MatouPlacement.explicitRoot` 的
      // 文档：值域放宽会破掉存储域的向前兼容承诺，追加字段不会。
      const parent = op.parentSessionId === undefined
        ? { at: prev?.parentSessionId, root: prev?.explicitRoot }
        : op.parentSessionId === null
          ? { at: undefined, root: true as const }
          : { at: op.parentSessionId, root: undefined }
      const parentSessionId = parent.at
      if (parentSessionId !== undefined) {
        // Referential integrity, deliberately NARROW (S3c Task 2): reject a
        // self-parent and a parent that would close a cycle; do NOT reject a
        // parent that has no placement row yet (`org/derive.ts` legitimately
        // falls back for those) nor one in another scene (that is a READ-side
        // downgrade today — `carousel/nodes.ts` treats an off-projection
        // parent as a root — and hard-rejecting it here would turn existing
        // dirty data from a silent downgrade into a failed operation).
        // Only this edge is checked; DSH's own `summary.parentId` edge is not
        // the plugin's to vouch for.
        if (parentSessionId === op.sessionId) {
          fail(`session '${op.sessionId}' cannot be its own parent`)
        }
        const seen = new Set<string>([op.sessionId])
        let cursor: string | undefined = parentSessionId
        while (cursor !== undefined) {
          if (seen.has(cursor)) {
            fail(`parent '${parentSessionId}' would put session '${op.sessionId}' in a cycle`)
          }
          seen.add(cursor)
          // `null`（显式根层）与缺席一样，都表示这条链到顶了。
          cursor = working.placements.find(row => row.sessionId === cursor)?.parentSessionId ?? undefined
        }
      }
      working.placements = working.placements.filter(
        placement => placement.sessionId !== op.sessionId,
      )
      let anchor: MatouPlacement | null = null
      if (op.beforeSessionId !== null && op.beforeSessionId !== undefined) {
        anchor = working.placements.find(
          placement => placement.sessionId === op.beforeSessionId
            && placement.sceneId === op.sceneId,
        ) ?? null
        if (anchor === null) fail(`before session '${op.beforeSessionId}' is not in scene '${op.sceneId}'`)
      }
      // 种类跟着父边走：op 省略则沿用原值（与 parentSessionId 同构的语义，
      // 与码头 `session-canvas-service.ts:747-757` 重连子会话时原样搬运
      // `child.relation_kind` 一致）。但**没有父边就没有边可标**——移除根卡
      // 后子会话被重挂到「无父」时，留着旧种类会让关系图给一个根节点画出一条
      // 指向不存在的父的 Fork 实线（S3c 审查 I3；码头那边是整条 relation 行
      // 一起删掉的）。
      const relationKind = parentSessionId === undefined
        ? undefined
        : (op.relationKind ?? prev?.relationKind)
      const subject: MatouPlacement = {
        sessionId: op.sessionId,
        taskId: op.taskId,
        sceneId: op.sceneId,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(parent.root === true ? { explicitRoot: true as const } : {}),
        ...(relationKind === undefined ? {} : { relationKind }),
        ...(prev?.manualOrder === undefined || prev.sceneId !== op.sceneId || prev.parentSessionId !== parentSessionId
          ? {} : { manualOrder: prev.manualOrder }),
        sortKey: 0,
        updatedAt: now,
      }
      const siblings = orderedBySortKey(working.placements.filter(
        placement => placement.sceneId === op.sceneId,
      ))
      siblings.push(subject)
      const moved = resequence(
        siblings,
        subject,
        anchor === null ? null : siblings.find(placement => placement === anchor)!,
        (placement, sortKey) => ({ ...placement, sortKey }),
      )
      working.placements = working.placements
        .filter(placement => placement.sceneId !== op.sceneId)
        .concat(moved)
      return
    }
    case 'placement/remove': {
      working.placements = working.placements.filter(
        placement => placement.sessionId !== op.sessionId,
      )
      return
    }
    case 'placement/order': {
      if (!Number.isSafeInteger(op.order) || op.order < 0) fail('invalid manual order')
      if (!working.placements.some(row => row.sessionId === op.sessionId)) fail('session has no placement')
      working.placements = working.placements.map(row => row.sessionId === op.sessionId
        ? { ...row, manualOrder: op.order } : row)
      return
    }
    case 'placement/interaction': {
      if (!Number.isSafeInteger(op.at) || op.at < 0) fail(`interaction time '${op.at}' is not a safe non-negative integer`)
      // 未落位的会话静默忽略：这个 op 由「维护排序键」的常驻副作用批量发出，
      // 而卡片被移除与下一次维护之间必然有窗口期。为一次时序竞争拒掉整批，
      // 会连带丢掉同批里其他卡的排序键。
      working.placements = working.placements.map(placement => (
        placement.sessionId === op.sessionId && (placement.interactionAt ?? -1) < op.at
          ? { ...placement, interactionAt: op.at }
          : placement
      ))
      return
    }
  }
}

/**
 * Apply an op batch to a state value.
 * @param state - current state; never mutated.
 * @param ops - ops applied in order; the first failure rejects the batch.
 * @param now - timestamp stamped onto created and updated rows.
 * @returns the next state, or the first op's failure with its index.
 */
export function applyOrgOps(
  state: MatouOrgState,
  ops: readonly MatouOrgOp[],
  now: number,
): MatouOrgApplyOutcome {
  const working: Working = {
    tasks: [...state.tasks],
    scenes: [...state.scenes],
    placements: [...state.placements],
  }
  for (const [index, op] of ops.entries()) {
    try {
      applyOne(working, op, now)
    } catch (error) {
      if (error instanceof OpError) {
        return { ok: false, error: { code: 'invalid-op', index, reason: error.message } }
      }
      throw error
    }
  }
  return {
    ok: true,
    state: {
      tasks: working.tasks,
      scenes: working.scenes,
      placements: working.placements,
    },
  }
}
