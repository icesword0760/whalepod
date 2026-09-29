import { describe, expect, it } from 'vitest'
import {
  EMPTY_ORG_STATE,
  defaultSceneId,
  defaultTaskId,
  matouOrgDocumentSchema,
} from '../src/org/model.ts'
import type { MatouOrgState } from '../src/org/model.ts'
import { applyOrgOps } from '../src/org/ops.ts'
import type { MatouOrgOp } from '../src/org/ops.ts'

const NOW = 1_760_000_000_000

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** Apply ops that must succeed, or fail the test with the reducer's reason. */
function applied(state: MatouOrgState, ops: readonly MatouOrgOp[], now = NOW): MatouOrgState {
  const outcome = applyOrgOps(deepFreeze(state), ops, now)
  if (!outcome.ok) throw new Error(`applyOrgOps rejected: ${outcome.error.reason}`)
  return outcome.state
}

/** Apply ops that must fail; returns the failure for assertions. */
function rejected(state: MatouOrgState, ops: readonly MatouOrgOp[], now = NOW) {
  const outcome = applyOrgOps(deepFreeze(state), ops, now)
  if (outcome.ok) throw new Error('applyOrgOps unexpectedly succeeded')
  return outcome.error
}

const WS = 'ws-1'

function seeded(): MatouOrgState {
  return applied(EMPTY_ORG_STATE, [
    { kind: 'task/create', id: 't-1', workspaceId: WS, title: '修 bug' },
    { kind: 'task/create', id: 't-2', workspaceId: WS, title: '方案设计' },
    { kind: 'scene/create', id: 'sc-1', taskId: 't-1', name: '排查' },
    { kind: 'scene/create', id: 'sc-2', taskId: 't-1', name: '验证' },
    { kind: 'placement/set', sessionId: 's-a', taskId: 't-1', sceneId: 'sc-1' },
    { kind: 'placement/set', sessionId: 's-b', taskId: 't-1', sceneId: 'sc-1' },
  ])
}

describe('matouOrgDocumentSchema', () => {
  it('accepts a valid document round-trip', () => {
    const document = { revision: 3, state: seeded() }
    expect(matouOrgDocumentSchema.parse(document)).toEqual(document)
  })

  it('rejects duplicate task ids', () => {
    const task = seeded().tasks[0]!
    const document = { revision: 0, state: { ...EMPTY_ORG_STATE, tasks: [task, task] } }
    expect(() => matouOrgDocumentSchema.parse(document)).toThrow(/duplicate/i)
  })

  it('rejects a negative revision', () => {
    expect(() => matouOrgDocumentSchema.parse({ revision: -1, state: EMPTY_ORG_STATE })).toThrow()
  })
})

describe('applyOrgOps: tasks', () => {
  it('creates tasks with planned status and tail sort keys per workspace', () => {
    const state = applied(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't-1', workspaceId: WS, title: 'A' },
      { kind: 'task/create', id: 't-2', workspaceId: WS, title: 'B' },
      { kind: 'task/create', id: 't-x', workspaceId: 'ws-2', title: 'C' },
    ])
    const [first, second, other] = state.tasks
    expect(first).toMatchObject({ id: 't-1', status: 'planned', isPinned: false, createdAt: NOW })
    expect(second!.sortKey).toBeGreaterThan(first!.sortKey)
    expect(other!.workspaceId).toBe('ws-2')
  })

  it('rejects creating a task whose id already exists', () => {
    const error = rejected(seeded(), [{ kind: 'task/create', id: 't-1', workspaceId: WS, title: 'X' }])
    expect(error).toMatchObject({ code: 'invalid-op', index: 0 })
  })

  it('materializes a default task id explicitly', () => {
    const id = defaultTaskId(WS)
    const state = applied(EMPTY_ORG_STATE, [
      { kind: 'task/create', id, workspaceId: WS, title: '默认' },
    ])
    expect(state.tasks[0]!.id).toBe(id)
  })

  it('updates title, status, and pin; rejects a missing task', () => {
    const state = applied(seeded(), [
      { kind: 'task/update', id: 't-1', patch: { title: '改名', status: 'active', isPinned: true } },
    ], NOW + 5)
    const task = state.tasks.find(candidate => candidate.id === 't-1')!
    expect(task).toMatchObject({ title: '改名', status: 'active', isPinned: true, updatedAt: NOW + 5 })
    expect(rejected(seeded(), [{ kind: 'task/update', id: 'nope', patch: {} }]).reason).toMatch(/nope/)
  })

  it('moves a task before a sibling and renormalizes sort keys', () => {
    const state = applied(seeded(), [{ kind: 'task/move', id: 't-2', beforeTaskId: 't-1' }])
    const ordered = state.tasks
      .filter(task => task.workspaceId === WS)
      .sort((left, right) => left.sortKey - right.sortKey)
      .map(task => task.id)
    expect(ordered).toEqual(['t-2', 't-1'])
    expect(state.tasks.map(task => task.sortKey).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('moves a task to the tail with beforeTaskId null', () => {
    const state = applied(seeded(), [{ kind: 'task/move', id: 't-1', beforeTaskId: null }])
    const ordered = state.tasks
      .sort((left, right) => left.sortKey - right.sortKey)
      .map(task => task.id)
    expect(ordered).toEqual(['t-2', 't-1'])
  })

  it('rejects moving before a task in another workspace', () => {
    const base = applied(seeded(), [{ kind: 'task/create', id: 't-z', workspaceId: 'ws-2', title: 'Z' }])
    expect(rejected(base, [{ kind: 'task/move', id: 't-1', beforeTaskId: 't-z' }]).reason)
      .toMatch(/workspace/)
  })

  it('deletes a task and cascades scenes and placements', () => {
    const state = applied(seeded(), [{ kind: 'task/delete', id: 't-1' }])
    expect(state.tasks.map(task => task.id)).toEqual(['t-2'])
    expect(state.scenes).toHaveLength(0)
    expect(state.placements).toHaveLength(0)
  })
})

describe('applyOrgOps: scenes', () => {
  it('rejects creating a scene under a missing task, including unmaterialized defaults', () => {
    expect(rejected(EMPTY_ORG_STATE, [
      { kind: 'scene/create', id: 'sc-x', taskId: defaultTaskId(WS), name: 'X' },
    ]).reason).toMatch(/task/)
  })

  it('renames and pins a scene title', () => {
    const state = applied(seeded(), [
      { kind: 'scene/update', id: 'sc-1', patch: { name: '重命名', titlePinned: true } },
    ])
    expect(state.scenes.find(scene => scene.id === 'sc-1')).toMatchObject({
      name: '重命名',
      titlePinned: true,
    })
  })

  it('reorders scenes within a task', () => {
    const state = applied(seeded(), [{ kind: 'scene/move', id: 'sc-2', beforeSceneId: 'sc-1' }])
    const ordered = state.scenes
      .sort((left, right) => left.sortKey - right.sortKey)
      .map(scene => scene.id)
    expect(ordered).toEqual(['sc-2', 'sc-1'])
  })

  it('deletes a scene and cascades its placements only', () => {
    const base = applied(seeded(), [
      { kind: 'placement/set', sessionId: 's-c', taskId: 't-1', sceneId: 'sc-2' },
    ])
    const state = applied(base, [{ kind: 'scene/delete', id: 'sc-1' }])
    expect(state.scenes.map(scene => scene.id)).toEqual(['sc-2'])
    expect(state.placements.map(placement => placement.sessionId)).toEqual(['s-c'])
  })
})

describe('applyOrgOps: placements', () => {
  it('rejects a placement whose scene belongs to another task', () => {
    expect(rejected(seeded(), [
      { kind: 'placement/set', sessionId: 's-x', taskId: 't-2', sceneId: 'sc-1' },
    ]).reason).toMatch(/scene/)
  })

  it('treats a repeated set as a move and keeps one placement per session', () => {
    const state = applied(seeded(), [
      { kind: 'placement/set', sessionId: 's-a', taskId: 't-1', sceneId: 'sc-2' },
    ])
    const rows = state.placements.filter(placement => placement.sessionId === 's-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sceneId).toBe('sc-2')
  })

  it('inserts before a sibling in the same scene and rejects a foreign anchor', () => {
    const state = applied(seeded(), [
      { kind: 'placement/set', sessionId: 's-c', taskId: 't-1', sceneId: 'sc-1', beforeSessionId: 's-a' },
    ])
    const ordered = state.placements
      .filter(placement => placement.sceneId === 'sc-1')
      .sort((left, right) => left.sortKey - right.sortKey)
      .map(placement => placement.sessionId)
    expect(ordered).toEqual(['s-c', 's-a', 's-b'])
    expect(rejected(state, [
      { kind: 'placement/set', sessionId: 's-d', taskId: 't-1', sceneId: 'sc-2', beforeSessionId: 's-a' },
    ]).reason).toMatch(/before/)
  })

  it('removes a placement idempotently', () => {
    const state = applied(seeded(), [
      { kind: 'placement/remove', sessionId: 's-a' },
      { kind: 'placement/remove', sessionId: 's-a' },
      { kind: 'placement/remove', sessionId: 'never-existed' },
    ])
    expect(state.placements.map(placement => placement.sessionId)).toEqual(['s-b'])
  })

  it('placement/set 记录并保留 parentSessionId', () => {
    const t0 = 1_000
    const created = applyOrgOps(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't1', workspaceId: 'w1', title: 'T' },
      { kind: 'scene/create', id: 's1', taskId: 't1', name: 'S' },
      { kind: 'placement/set', sessionId: 'child', taskId: 't1', sceneId: 's1', parentSessionId: 'parent' },
    ], t0)
    if (!created.ok) throw new Error(created.error.reason)
    expect(created.state.placements[0]?.parentSessionId).toBe('parent')

    // 不带 parentSessionId 的后续 set（换 scene）保留原父
    const moved = applyOrgOps(created.state, [
      { kind: 'placement/set', sessionId: 'child', taskId: 't1', sceneId: 's1' },
    ], t0 + 1)
    if (!moved.ok) throw new Error(moved.error.reason)
    expect(moved.state.placements[0]?.parentSessionId).toBe('parent')

    // 显式 null 清父 —— 且清完要留下「显式在根层」这个标记，而不是退回「没表过
    // 态」。S3c Task 3 之前这里断言的只有 toBeUndefined()，那锁住的正是要修的
    // 行为：读侧分不清两者，平级 Fork 一个根会话时新会话会回落到 DSH 记的父
    //（= 它复制状态的那个源会话）而被画成子会话。
    const cleared = applyOrgOps(moved.state, [
      { kind: 'placement/set', sessionId: 'child', taskId: 't1', sceneId: 's1', parentSessionId: null },
    ], t0 + 2)
    if (!cleared.ok) throw new Error(cleared.error.reason)
    expect(cleared.state.placements[0]?.parentSessionId).toBeUndefined()
    expect(cleared.state.placements[0]?.explicitRoot).toBe(true)
  })
})

describe('applyOrgOps: batch semantics', () => {
  it('fails the whole batch on the first invalid op and reports its index', () => {
    const error = rejected(seeded(), [
      { kind: 'task/update', id: 't-1', patch: { title: 'ok' } },
      { kind: 'scene/create', id: 'sc-9', taskId: 'missing', name: 'X' },
    ])
    expect(error.index).toBe(1)
  })

  it('never mutates the input state', () => {
    const state = deepFreeze(seeded())
    const outcome = applyOrgOps(state, [{ kind: 'task/delete', id: 't-1' }], NOW)
    expect(outcome.ok).toBe(true)
    expect(state.tasks.map(task => task.id)).toEqual(['t-1', 't-2'])
  })

  it('exposes default id helpers used by the client derivation', () => {
    expect(defaultTaskId('w')).toBe('task:default:w')
    expect(defaultSceneId('t')).toBe('scene:default:t')
  })
})


/**
 * S3c Task 2: 落位的父边完整性。
 *
 * 范围是刻意窄的（计划里写死）：**只**拒自指与成环，**不**拒「父不存在」
 * 与「父跨页签」。理由——父可能是一个还没落位的会话（`org/derive.ts` 有
 * 回落路径），而跨页签目前是读侧降级（`carousel/nodes.ts` 把不在投影里的
 * 父当根，`docs/parity/checklist.md` 已登记为已知落差）；改成写侧硬拒会
 * 让存量脏数据的用户从「静默降级」变成「操作失败」，是可见的行为变化。
 *
 * 也只管 placement 这一条边——DSH 自己那条 `summary.parentId` 边不归插件
 * 管，插件不为宿主的数据质量兜底。
 */
describe('applyOrgOps — placement 父边的自指与成环（S3c Task 2）', () => {
  /** 一个页签，三个会话，链式 A → B → C。 */
  function chain(): MatouOrgState {
    const base = applyOrgOps(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't-1', workspaceId: 'ws', title: 'T' },
      { kind: 'scene/create', id: 'sc-1', taskId: 't-1', name: 'S' },
      { kind: 'placement/set', sessionId: 'A', taskId: 't-1', sceneId: 'sc-1' },
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A' },
      { kind: 'placement/set', sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'B' },
    ], NOW)
    if (!base.ok) throw new Error(base.error.reason)
    return base.state
  }

  it('拒绝自指：把一个会话的父设成它自己', () => {
    const result = applyOrgOps(chain(), [
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'B' },
    ], NOW)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.error.reason).toContain('B')
  })

  it('拒绝成环：A → B → C 之后把 A 的父设成 C', () => {
    const result = applyOrgOps(chain(), [
      { kind: 'placement/set', sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'C' },
    ], NOW)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
  })

  it('不误伤正常的深链：把一个新会话挂到链尾', () => {
    const result = applyOrgOps(chain(), [
      { kind: 'placement/set', sessionId: 'D', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'C' },
    ], NOW)
    expect(result.ok).toBe(true)
  })

  it('不拒绝「父尚未落位」——那是读侧回落的合法情形（范围守卫）', () => {
    const result = applyOrgOps(chain(), [
      { kind: 'placement/set', sessionId: 'E', taskId: 't-1', sceneId: 'sc-1', parentSessionId: '还没落位的会话' },
    ], NOW)
    expect(result.ok).toBe(true)
  })

  it('不拒绝「父在另一个页签」——那是读侧降级的已知落差（范围守卫）', () => {
    const seeded = applyOrgOps(chain(), [
      { kind: 'scene/create', id: 'sc-2', taskId: 't-1', name: 'S2' },
      { kind: 'placement/set', sessionId: 'X', taskId: 't-1', sceneId: 'sc-2' },
    ], NOW)
    if (!seeded.ok) throw new Error(seeded.error.reason)
    const result = applyOrgOps(seeded.state, [
      { kind: 'placement/set', sessionId: 'Y', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'X' },
    ], NOW)
    expect(result.ok).toBe(true)
  })
})


/**
 * S3c Task 3: op 层本来就有三态语义（`org/ops.ts` 的注释原文：「省略该键 →
 * 保留原父；显式 null → 清父；字符串 → 设置」），但存储层把 null 压成了
 * undefined，于是读侧分不清「显式在根层」与「没表过态」。
 */
describe('applyOrgOps — placement 父的三态一路贯通（S3c Task 3）', () => {
  function seeded(): MatouOrgState {
    const base = applyOrgOps(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't-1', workspaceId: 'ws', title: 'T' },
      { kind: 'scene/create', id: 'sc-1', taskId: 't-1', name: 'S' },
    ], NOW)
    if (!base.ok) throw new Error(base.error.reason)
    return base.state
  }

  it('显式 null 落成「显式根层」标记（而不是压成缺席）', () => {
    const result = applyOrgOps(seeded(), [
      { kind: 'placement/set', sessionId: 'E', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null },
    ], NOW)
    if (!result.ok) throw new Error(result.error.reason)
    const row = result.state.placements.find(p => p.sessionId === 'E')!
    expect(row.explicitRoot).toBe(true)
    // 盘上不写 parentSessionId: null —— 旧 schema 见到 null 会 reject，整个
    // 存储域打不开（S3c 审查 I1）。
    expect('parentSessionId' in row).toBe(false)
  })

  it('省略该键则字段缺席（保持「没表过态」）', () => {
    const result = applyOrgOps(seeded(), [
      { kind: 'placement/set', sessionId: 'F', taskId: 't-1', sceneId: 'sc-1' },
    ], NOW)
    if (!result.ok) throw new Error(result.error.reason)
    const row = result.state.placements.find(p => p.sessionId === 'F')!
    expect('parentSessionId' in row).toBe(false)
  })

  it('显式 null 清掉原有的父，且清完带「显式根层」标记而不是退回「没表过态」', () => {
    const withParent = applyOrgOps(seeded(), [
      { kind: 'placement/set', sessionId: 'P', taskId: 't-1', sceneId: 'sc-1' },
      { kind: 'placement/set', sessionId: 'K', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'P' },
    ], NOW)
    if (!withParent.ok) throw new Error(withParent.error.reason)
    const cleared = applyOrgOps(withParent.state, [
      { kind: 'placement/set', sessionId: 'K', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null },
    ], NOW)
    if (!cleared.ok) throw new Error(cleared.error.reason)
    const row = cleared.state.placements.find(p => p.sessionId === 'K')!
    expect(row.parentSessionId).toBeUndefined()
    expect(row.explicitRoot).toBe(true)
  })

  it('带「显式根层」标记的文档通过 schema 校验（存储域兼容）', () => {
    const result = applyOrgOps(seeded(), [
      { kind: 'placement/set', sessionId: 'E', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null },
    ], NOW)
    if (!result.ok) throw new Error(result.error.reason)
    expect(() => matouOrgDocumentSchema.parse({ revision: 1, state: result.state })).not.toThrow()
  })
})


/**
 * S3c 审查 I3：没有父边，就没有边可标。
 *
 * 场景：根卡 A 有一个从 A fork 出来的子会话 B。用户对 A 做「移除本卡（仅本
 * 卡）」，`reparentOps` 把 B 重挂到「无父」。此前 `relationKind` 会被沿用，
 * 于是盘上留下一条 `{无父, relationKind: 'forked-from'}` 的悬空记录——关系图
 * 会给一个根节点画出一条指向不存在的父的 Fork 实线。
 *
 * 码头的对照做法（`session-canvas-service.ts:710-758`）：删除时把涉及该会话
 * 的 relation 行整条删掉，重连块只在有结构父时才跑，所以根节点被删后子会话
 * 一条 relation 都不留，自然也没有种类。
 *
 * 注意这与「改父到另一个**真实**的父时沿用种类」不冲突——那一条码头是原样
 * 搬运的（`:747-757`），审查已确认为对齐而非缺陷。
 */
describe('applyOrgOps — 清掉父边时一并丢弃关系种类（S3c 审查 I3）', () => {
  function withForkedChild(): MatouOrgState {
    const base = applyOrgOps(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't-1', workspaceId: 'ws', title: 'T' },
      { kind: 'scene/create', id: 'sc-1', taskId: 't-1', name: 'S' },
      { kind: 'placement/set', sessionId: 'A', taskId: 't-1', sceneId: 'sc-1' },
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', relationKind: 'forked-from' },
    ], NOW)
    if (!base.ok) throw new Error(base.error.reason)
    return base.state
  }

  it('把子会话重挂到「无父」后，不再留下悬空的关系种类', () => {
    const seeded = withForkedChild()
    expect(seeded.placements.find(p => p.sessionId === 'B')!.relationKind).toBe('forked-from')

    // reparentOps 在移除根卡时发的正是这个形状：显式 null，且不带 relationKind
    const reparented = applyOrgOps(seeded, [
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null },
    ], NOW)
    if (!reparented.ok) throw new Error(reparented.error.reason)
    const row = reparented.state.placements.find(p => p.sessionId === 'B')!
    expect(row.explicitRoot).toBe(true)
    expect(row.relationKind).toBeUndefined()
  })

  it('改挂到另一个真实的父时仍然沿用种类（与码头一致，不是缺陷）', () => {
    const seeded = applyOrgOps(withForkedChild(), [
      { kind: 'placement/set', sessionId: 'G', taskId: 't-1', sceneId: 'sc-1' },
    ], NOW)
    if (!seeded.ok) throw new Error(seeded.error.reason)
    const moved = applyOrgOps(seeded.state, [
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'G' },
    ], NOW)
    if (!moved.ok) throw new Error(moved.error.reason)
    expect(moved.state.placements.find(p => p.sessionId === 'B')!.relationKind).toBe('forked-from')
  })
})

/**
 * 第三轮活体走查（2026-09-07）修「正在操作的卡不跳位」时新增的 op。
 * 判定在 `carousel/interaction-commit.ts`，这里只钉落盘语义。
 */
describe('placement/interaction —— 已提交排序键', () => {
  const state = seeded()   // s-a / s-b 已落位在 sc-1

  it('写入排序键', () => {
    const next = applied(state, [{ kind: 'placement/interaction', sessionId: 's-a', at: 500 }])
    expect(next.placements.find(p => p.sessionId === 's-a')?.interactionAt).toBe(500)
  })

  it('只增不减：更小的值原样忽略', () => {
    const first = applied(state, [{ kind: 'placement/interaction', sessionId: 's-a', at: 500 }])
    const second = applied(first, [{ kind: 'placement/interaction', sessionId: 's-a', at: 100 }])
    expect(second.placements.find(p => p.sessionId === 's-a')?.interactionAt).toBe(500)
  })

  /**
   * 反例：未落位的会话必须**静默忽略**而不是整批失败。这个 op 由一个批量维护
   * 排序键的常驻副作用发出，卡片被移除与下一次维护之间必有窗口期；为一次时序
   * 竞争拒掉整批，会连带丢掉同批里其他卡的排序键。
   */
  it('未落位的会话静默忽略，同批其他 op 照常生效', () => {
    const next = applied(state, [
      { kind: 'placement/interaction', sessionId: 'ghost', at: 900 },
      { kind: 'placement/interaction', sessionId: 's-a', at: 700 },
    ])
    expect(next.placements.some(p => p.sessionId === 'ghost')).toBe(false)
    expect(next.placements.find(p => p.sessionId === 's-a')?.interactionAt).toBe(700)
  })

  it('负数或非安全整数被拒', () => {
    expect(rejected(state, [{ kind: 'placement/interaction', sessionId: 's-a', at: -1 }])).toBeDefined()
    expect(rejected(state, [{ kind: 'placement/interaction', sessionId: 's-a', at: 1.5 }])).toBeDefined()
  })
})
