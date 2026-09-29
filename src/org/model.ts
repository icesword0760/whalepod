/**
 * Organization model shared by the host service and the client store: the
 * task/scene grouping DSH itself does not know about. Sessions and workspaces
 * stay DSH-owned; this document only records how the plugin arranges them.
 * @module dsh-plugin-matou-layout/src/org/model
 */

import { z } from 'zod'

/** Kanban vocabulary carried by a task (Matou 事项). */
export type MatouTaskStatus = 'planned' | 'active' | 'blocked' | 'completed' | 'archived'

/** One 事项: a category of work inside one DSH workspace. */
export interface MatouTask {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: MatouTaskStatus
  readonly isPinned: boolean
  readonly sortKey: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One 页签: a canvas of sessions inside one task. */
export interface MatouScene {
  readonly id: string
  readonly taskId: string
  readonly name: string
  readonly titlePinned: boolean
  readonly sortKey: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** 一条父边的种类；见 {@link MatouPlacement.relationKind}。 */
export type MatouRelationKind = 'forked-from' | 'derived-from'

/** One session's explicit membership in a task/scene pair. */
export interface MatouPlacement {
  readonly sessionId: string
  readonly taskId: string
  readonly sceneId: string
  /** 有效父会话（插件记录 DSH 不记的边：页签内新会话挂当前层父、平级 Fork 挂源的父）。 */
  readonly parentSessionId?: string
  /**
   * 落位时**显式说了「就在根层」**——读侧因此不回落 DSH 自己的
   * `summary.parentId`。与「字段缺席」（没对父表过态，照旧回落）是两回事。
   *
   * 这一态是平级 Fork 的正确性所系：在一个根会话 A 上「⑂ Fork 会话」，新会话
   * 应与 A 并排，但 DSH 记的新会话 `parentId` 正是它复制状态的那个 A；没有这
   * 一态，它会被画成 A 的子会话。
   *
   * **为什么是追加一个字段，而不是把 `parentSessionId` 的值域放宽到
   * `string | null`**（S3c 审查 I1）：`src/org/spec.ts` 承诺「新文档被旧代码
   * 读到时只是无害地丢掉那个字段」，而本存储域不支持迁移——校验一失败整个域
   * 就打不开，用户的事项/页签/布局一起没。旧 schema 的 `identifier.optional()`
   * 见到 `null` 会直接 reject；见到这个未知键则原样 strip，退回旧的回落行为，
   * 是降级而不是打不开。
   *
   * 三态在**内存**里仍然合成一个值（`carousel/nodes.ts` 的
   * `placementsBySessionOf` 把它折成 `null`），盘上形状与内存契约就此分开。
   */
  readonly explicitRoot?: true
  /**
   * 这张卡在本层的**已提交排序键**——「最近交互倒序」用的就是它。
   *
   * 值取 DSH 的 `updatedAt`（= `max(createdAt, lastPromptAt)`，本身就是「最后
   * 一次用户提问」的时刻），空白会话记 0。之所以要在自己的文档里再存一份、
   * 而不是每次直接读 `updatedAt`，是为了实现 spec §7.1 第 5 条那半句
   * 「**正在操作的卡不跳位**」：聚焦期间不提交新值，焦点一离开才提交
   * ——码头用 `pending_user_interaction_seq` / `last_user_interaction_seq`
   * 一对列做同一件事（`session-interaction-service.ts:76-96`）。判定在
   * `carousel/interaction-commit.ts`。
   *
   * **为什么必须落在这份文档里**：轮播与控制面（`control/topology.ts`）读同一份
   * 落位数据排序，「AI 说的第 3 张 = 用户看到的第 3 张」这条不变式全靠这一点；
   * 若把「聚焦期间钉住」只做在前端内存里，宿主那边算出来的序号会与屏幕分叉。
   *
   * 缺席即「还没提交过」，读侧退回 `updatedAt`（见 `carousel/nodes.ts`）。
   * 与 `explicitRoot` 同理，这是**纯增量的可选字段**，不提升存储域版本。
   */
  readonly interactionAt?: number
  /** User-fixed sibling order; outranks interaction recency after a manual drag. */
  readonly manualOrder?: number
  /**
   * 这条父边的种类，供关系图区分两种连线（码头 `dag.css:32-35`：forked-from
   * 实线、derived-from 虚线）。判据是「挂到谁下面」与「从谁复制状态」是不是
   * 同一个会话：
   * - `forked-from` —— 新会话复制的正是它父亲的状态（创建子分支、兄弟分支）
   * - `derived-from` —— 只是结构上挂在那儿，状态不来自父亲（⑂ Fork 会话、
   *   下钻层里新建的会话）
   *
   * 可选：没有父边就没有边可标；旧文档没有这个字段也照常读得出来（zod 默认
   * strip 未知键，`tests/org-model-version-compat.spec.ts` 是可执行证明）。
   */
  readonly relationKind?: MatouRelationKind
  readonly sortKey: number
  readonly updatedAt: number
}

/** The whole organization structure, small enough to travel as one value. */
export interface MatouOrgState {
  readonly tasks: readonly MatouTask[]
  readonly scenes: readonly MatouScene[]
  readonly placements: readonly MatouPlacement[]
}

/** The persisted document: one revision counter over one state value. */
export interface MatouOrgDocument {
  readonly revision: number
  readonly state: MatouOrgState
}

/** The state a fresh deployment starts from. */
export const EMPTY_ORG_STATE: MatouOrgState = Object.freeze({
  tasks: Object.freeze([]),
  scenes: Object.freeze([]),
  placements: Object.freeze([]),
})

/**
 * Deterministic id of a workspace's default task. Unmaterialized defaults are
 * synthesized by the client derivation; a stored row with this id overrides
 * the virtual one (the user renamed or pinned it).
 */
export const defaultTaskId = (workspaceId: string): string => `task:default:${workspaceId}`

/** Deterministic id of a task's default scene; same materialization rule. */
export const defaultSceneId = (taskId: string): string => `scene:default:${taskId}`

const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1)

export const matouTaskStatusSchema: z.ZodType<MatouTaskStatus> = z.union([
  z.literal('planned'),
  z.literal('active'),
  z.literal('blocked'),
  z.literal('completed'),
  z.literal('archived'),
])

export const matouTaskSchema: z.ZodType<MatouTask> = z.object({
  id: identifier,
  workspaceId: identifier,
  title: z.string(),
  status: matouTaskStatusSchema,
  isPinned: z.boolean(),
  sortKey: z.number().finite(),
  createdAt: safeCount,
  updatedAt: safeCount,
})

export const matouSceneSchema: z.ZodType<MatouScene> = z.object({
  id: identifier,
  taskId: identifier,
  name: z.string(),
  titlePinned: z.boolean(),
  sortKey: z.number().finite(),
  createdAt: safeCount,
  updatedAt: safeCount,
})

export const matouPlacementSchema: z.ZodType<MatouPlacement> = z.object({
  sessionId: identifier,
  taskId: identifier,
  sceneId: identifier,
  parentSessionId: identifier.optional(),
  explicitRoot: z.literal(true).optional(),
  interactionAt: safeCount.optional(),
  manualOrder: safeCount.optional(),
  relationKind: z.enum(['forked-from', 'derived-from']).optional(),
  sortKey: z.number().finite(),
  updatedAt: safeCount,
}) as unknown as z.ZodType<MatouPlacement>

function requireUnique<T, K extends keyof T & string>(
  ctx: z.RefinementCtx,
  rows: readonly T[],
  key: K,
  path: string,
): void {
  const seen = new Set<unknown>()
  rows.forEach((row, index) => {
    const value: unknown = row[key]
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [path, index, key],
        message: `duplicate ${path} ${key} '${String(value)}'`,
      })
    }
    seen.add(value)
  })
}

export const matouOrgStateSchema: z.ZodType<MatouOrgState> = z.object({
  tasks: z.array(matouTaskSchema),
  scenes: z.array(matouSceneSchema),
  placements: z.array(matouPlacementSchema),
}).superRefine((state, ctx) => {
  requireUnique(ctx, state.tasks, 'id', 'tasks')
  requireUnique(ctx, state.scenes, 'id', 'scenes')
  requireUnique(ctx, state.placements, 'sessionId', 'placements')
}) as unknown as z.ZodType<MatouOrgState>

export const matouOrgDocumentSchema: z.ZodType<MatouOrgDocument> = z.object({
  revision: safeCount,
  state: matouOrgStateSchema,
}) as unknown as z.ZodType<MatouOrgDocument>

/**
 * Deep structural equality over two org states.
 *
 * 用来判断一个 op 批次有没有真的改变文档。没有改变就**不推进 revision**
 * （`src/index.ts` 的 `apply`），这是一条结构性闸门：
 *
 * 宿主有意让某些 op 在条件不满足时静默忽略（例如 `placement/interaction`
 * 落在一个尚未落位的会话上，见 `org/ops.ts`）。如果那样的批次照样把 revision
 * 加一，发起方就会看到「文档变了」→ 重新求值 → 发现自己要的效果仍未出现 →
 * 再写一次 → 无限循环，并且把**所有其他写入**挤掉（2026-09-14 桌面端走查：
 * 用户点「新会话」永远建不出来）。不推进 revision，这类循环第一轮就停。
 *
 * 只比较纯 JSON 值（本文档的全部内容）：不处理循环引用、`Date`、`Map` 等。
 * @param a - 一个状态。
 * @param b - 另一个状态。
 * @returns 两者结构相同则为 true。
 */
export function sameOrgState(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameOrgState(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  // 键集合相同才算相同：一个可选字段从「缺席」变成 `undefined` 也算变化，
  // 因为它会随 detached()/JSON 往返改变文档的观察结果。
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  if (leftKeys.some((key, index) => key !== rightKeys[index])) return false
  return leftKeys.every(key => sameOrgState(left[key], right[key]))
}
