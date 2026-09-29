import { describe, expect, it, vi } from 'vitest'
import { effectiveParentOf } from '../src/client/carousel/graph.ts'
import { placementsBySessionOf } from '../src/client/carousel/nodes.ts'
import { createLevelStore } from '../src/client/carousel/level-store.ts'
import { createRevealStore } from '../src/client/carousel/reveal-store.ts'
import { createDagPanelStore } from '../src/client/dag/panel-store.ts'
import { createNavStore } from '../src/client/nav/store.ts'
import { createWorkbenchActions } from '../src/client/workbench/actions.ts'
import type { SceneRef, TaskRef, WorkbenchDeps } from '../src/client/workbench/actions.ts'
import { applyOrgOps } from '../src/org/ops.ts'
import type { MatouOrgOp } from '../src/org/ops.ts'
import type { MatouOrgApplyResult } from '../src/org/wire.ts'
import { EMPTY_ORG_STATE, defaultTaskId } from '../src/org/model.ts'
import type { MatouOrgState } from '../src/org/model.ts'

interface HarnessOptions {
  applyScript?: (ops: readonly MatouOrgOp[], call: number) => MatouOrgApplyResult
  /** Pre-existing org state `locationOf`/`parentOf` (drillTo/fork resolution) read from. */
  orgState?: MatouOrgState
  workspaceItems?: readonly { workspaceId: string; title: string; sessionIds: readonly string[] }[]
  sessionSummaries?: Record<string, { parentId?: string; running?: boolean; origin?: 'subagent'; updatedAt?: number }>
  currentSessionId?: string
  forkResult?: string
  renameOk?: boolean
  /** Session ids with a pending interaction (等待输入) — drillTo's active-child priority reads this. */
  pendingIds?: readonly string[]
  /** DSH's archived sessions — excluded by the shared node projection (final review I2/M8). */
  archivedSessionIds?: readonly string[]
}

function harness(options: HarnessOptions = {}) {
  const applied: MatouOrgOp[][] = []
  let calls = 0
  const orgState = options.orgState ?? EMPTY_ORG_STATE
  const org = {
    apply: vi.fn(async (ops: readonly MatouOrgOp[]): Promise<MatouOrgApplyResult> => {
      applied.push([...ops])
      calls += 1
      return options.applyScript?.(ops, calls) ?? { ok: true, value: { revision: calls, state: orgState } }
    }),
    store: { getSnapshot: () => ({ revision: 0, org: orgState }) },
  }
  const sessionsById: Record<string, unknown> = {}
  for (const [id, summary] of Object.entries(options.sessionSummaries ?? {})) {
    sessionsById[id] = { id, displayTitle: id, running: summary.running ?? false, blank: false, updatedAt: 0, ...summary }
  }
  const rename = vi.fn(async () => (options.renameOk === false
    ? { ok: false, error: new Error('rename failed') }
    : { ok: true, value: undefined }))
  const sessions = {
    create: vi.fn(async () => 's-new' as never),
    open: vi.fn(),
    clear: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    fork: vi.fn(async () => (options.forkResult ?? 'child-new') as never),
    binding: vi.fn(() => ({ session: { rename } })),
    list: {
      getSnapshot: () => ({
        ids: Object.keys(sessionsById), byId: sessionsById, current: options.currentSessionId, phase: 'ready',
      }),
    },
  }
  const workspaces = {
    archiveSession: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ workspaceId: 'ws-new' })),
    list: {
      getSnapshot: () => ({
        items: options.workspaceItems ?? [], archivedSessionIds: options.archivedSessionIds ?? [],
      }),
    },
  }
  const uiWorkspace = { pickDirectory: vi.fn(async () => '/tmp/picked') }
  const nav = createNavStore().create()
  const level = createLevelStore().create()
  const dag = createDagPanelStore().create()
  const reveal = createRevealStore().create()
  const pendingSet = new Set(options.pendingIds ?? [])
  const pendingInteractions = { getSnapshot: () => pendingSet }
  const deps: WorkbenchDeps = {
    sessions: sessions as never,
    workspaces: workspaces as never,
    // 依赖形状从 `uiWorkspace` 换成 `pickDirectory` 之后，这个替身一直没跟上：
    // `WorkbenchDeps` 上多余的字段被 TS 结构化类型接受，缺的那个直到运行时才炸。
    // 于是 addWorkspace 整条路**从来没有测试覆盖**——0.1.5 迁移把它写死
    //（`ctx.uiWorkspace` 触发 Cordis 守卫抛错）也就没人拦得住。
    pickDirectory: () => uiWorkspace.pickDirectory(),
    getOrg: () => org as never,
    nav,
    level,
    dag,
    reveal,
    pendingInteractions,
    newId: () => 'fresh',
  }
  const cleanup = () => { nav.clearPersisted(); level.clearPersisted() }
  return {
    actions: createWorkbenchActions(deps), applied, sessions, workspaces, nav, level, dag, reveal, org, rename, cleanup,
  }
}

/** 固定时钟，喂给真实 reducer 用（S3c Task 1）。 */
const NOW_S3C = 1_760_000_000_000

const VIRTUAL_TASK: TaskRef = { workspaceId: 'ws', taskId: 'task:default:ws', virtual: true, title: '默认' }
const VIRTUAL_SCENE: SceneRef = {
  ...VIRTUAL_TASK, sceneId: 'scene:default:task:default:ws', sceneVirtual: true, name: '默认',
}
const STORED_SCENE: SceneRef = {
  workspaceId: 'ws', taskId: 't-1', virtual: false, title: 'T', sceneId: 'sc-1', sceneVirtual: false, name: 'S',
}

/** One workspace/task/scene with A (root), C (root sibling of A), B (child of A) — the fork/drill test fixture. */
const FORK_ORG_STATE: MatouOrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [
    { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
    { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 3, updatedAt: 1 },
  ],
}
const FORK_WORKSPACE_ITEMS = [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B', 'C'] }]

/** A two-session scene (A root, B its only child) — the removeCard cascade/guard fixture. */
const REMOVE_ORG_STATE: MatouOrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [
    { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 2, updatedAt: 1 },
  ],
}
const REMOVE_WORKSPACE_ITEMS = [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B'] }]

/** A three-deep chain (A root → B → C) — the "reparent the descendants" fixture (C2). */
const NESTED_ORG_STATE: MatouOrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [
    { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 2, updatedAt: 1 },
    { sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'B', sortKey: 3, updatedAt: 1 },
  ],
}
const NESTED_WORKSPACE_ITEMS = [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B', 'C'] }]

/** A single-session scene — the "would leave the tab empty" guard fixture. */
const SOLO_ORG_STATE: MatouOrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-solo', taskId: 't-1', name: 'Solo', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [{ sessionId: 'X', taskId: 't-1', sceneId: 'sc-solo', sortKey: 1, updatedAt: 1 }],
}
const SOLO_WORKSPACE_ITEMS = [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['X'] }]

/** A three-children fixture for drillTo's active-child priority (A root, B1/B2/B3 its children). */
const PRIORITY_ORG_STATE: MatouOrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [
    { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 'B1', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 2, updatedAt: 1 },
    { sessionId: 'B2', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 3, updatedAt: 1 },
    { sessionId: 'B3', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 4, updatedAt: 1 },
  ],
}
const PRIORITY_WORKSPACE_ITEMS = [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B1', 'B2', 'B3'] }]

describe('workbench actions', () => {
  it('newSession on a virtual scene materializes task then scene, places the session, navigates, opens', async () => {
    const h = harness()
    await h.actions.newSession(VIRTUAL_SCENE)
    expect(h.applied[0]!.map(op => op.kind)).toEqual(['task/create', 'scene/create', 'placement/set'])
    expect(h.applied[0]![2]).toMatchObject({ sessionId: 's-new', sceneId: VIRTUAL_SCENE.sceneId })
    expect(h.sessions.open).toHaveBeenCalledWith('s-new')
    expect(h.nav.getSnapshot().sessionByScene[VIRTUAL_SCENE.sceneId]).toBe('s-new')
    h.cleanup()
  })

  it('newSession on a stored scene only places the session', async () => {
    const h = harness()
    await h.actions.newSession(STORED_SCENE)
    expect(h.applied[0]!.map(op => op.kind)).toEqual(['placement/set'])
    h.cleanup()
  })

  it('newSession(scene, parentSessionId) places the new session under the current drill layer\'s parent (spec §4)', async () => {
    const h = harness()
    await h.actions.newSession(STORED_SCENE, 'A')
    expect(h.applied[0]![0]).toMatchObject({ kind: 'placement/set', sessionId: 's-new', parentSessionId: 'A' })
    h.cleanup()
  })

  it('newSession at the root layer (no parentSessionId) omits the field entirely — not null, not undefined-as-clear', async () => {
    const h = harness()
    await h.actions.newSession(STORED_SCENE)
    const op = h.applied[0]![0] as Extract<MatouOrgOp, { kind: 'placement/set' }>
    expect('parentSessionId' in op).toBe(false)
    h.cleanup()
  })

  it('renaming a virtual task materializes it with the new title', async () => {
    const h = harness()
    await h.actions.renameTask(VIRTUAL_TASK, '改名')
    expect(h.applied[0]).toEqual([
      { kind: 'task/create', id: VIRTUAL_TASK.taskId, workspaceId: 'ws', title: '改名' },
    ])
    h.cleanup()
  })

  /**
   * 码头的不变量：不存在「有事项/页签但没有会话卡」的状态。
   * `hierarchy-application-service.ts` 的 `#createTaskHierarchy` 在同一个事务里建出
   * 事项 → 画布 → 会话 → 挂载；`createScene` 同样带一条 `INSERT INTO sessions`。
   * 本插件此前只写 task/scene，新建出来是一张「当前画布没有活跃会话」的空页
   * （2026-09-14 用户报的）。三条 op 必须在**同一次 apply** 里下去：中间不出现
   * 空状态，也不多推进一次共享的 revision。
   */
  it('createScene under a virtual task materializes the task first and lands one session card', async () => {
    const h = harness()
    const id = await h.actions.createScene(VIRTUAL_TASK, '新页签')
    expect(id).toBe('fresh')
    expect(h.applied).toHaveLength(1) // 一次 apply，不是三次
    expect(h.applied[0]!.map(op => op.kind)).toEqual(['task/create', 'scene/create', 'placement/set'])
    expect(h.applied[0]!.at(-1)).toMatchObject({ sessionId: 's-new', taskId: VIRTUAL_TASK.taskId, sceneId: 'fresh' })
    expect(h.nav.getSnapshot().sceneByTask[VIRTUAL_TASK.taskId]).toBe('fresh')
    h.cleanup()
  })

  it('createTask 一并建出默认页签与第一张会话卡（新建的事项不得是空画布）', async () => {
    const h = harness()
    const id = await h.actions.createTask('ws', '修 bug')
    expect(id).toBe('fresh')
    expect(h.applied).toHaveLength(1)
    expect(h.applied[0]!.map(op => op.kind)).toEqual(['task/create', 'scene/create', 'placement/set'])
    expect(h.applied[0]![1]).toMatchObject({ kind: 'scene/create', id: 'scene:default:fresh', taskId: 'fresh' })
    expect(h.applied[0]![2]).toMatchObject({ kind: 'placement/set', sessionId: 's-new', sceneId: 'scene:default:fresh' })
    h.cleanup()
  })

  it('addWorkspace 之后同样落一张会话卡，而不是一张空画布', async () => {
    const h = harness()
    await h.actions.addWorkspace()
    expect(h.applied).toHaveLength(1)
    expect(h.applied[0]!.map(op => op.kind)).toEqual(['task/create', 'scene/create', 'placement/set'])
    expect(h.applied[0]![0]).toMatchObject({ kind: 'task/create', id: 'task:default:ws-new', workspaceId: 'ws-new' })
    expect(h.applied[0]![2]).toMatchObject({ kind: 'placement/set', sessionId: 's-new' })
    h.cleanup()
  })

  it('deletes Default by archiving its sessions, then opens a fresh task and session', async () => {
    const h = harness({ workspaceItems: [{ workspaceId: 'ws', title: 'workspace', sessionIds: ['a', 'b'] }], sessionSummaries: { a: {}, b: {} }, currentSessionId: 'a' })
    await h.actions.deleteTask(VIRTUAL_TASK)
    expect(h.workspaces.archiveSession.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
    expect(h.applied[0]?.[0]?.kind).toBe('task/create')
    expect(h.applied[1]?.map(op => op.kind)).toEqual(['task/delete', 'task/create', 'scene/create', 'placement/set'])
    expect(h.sessions.create).toHaveBeenCalledWith({ workspaceId: 'ws' })
    expect(h.sessions.open).toHaveBeenCalledWith('s-new')
    expect(h.sessions.clear).toHaveBeenCalled()
    h.cleanup()
  })

  it('archives only the deleted stored task, leaving other tasks intact', async () => {
    const h = harness({ orgState: FORK_ORG_STATE, workspaceItems: [{ workspaceId: 'ws-1', title: 'workspace', sessionIds: ['A', 'B', 'C', 'outside'] }], sessionSummaries: { A: {}, B: {}, C: {}, outside: {} } })
    await h.actions.deleteTask({ workspaceId: 'ws-1', taskId: 't-1', virtual: false, title: 'T' })
    expect(h.workspaces.archiveSession.mock.calls.map(call => call[0]).sort()).toEqual(['A', 'B', 'C'])
    expect(h.applied).toEqual([[{ kind: 'task/delete', id: 't-1' }]])
    expect(h.nav.getSnapshot().taskByWorkspace['ws-1']).toBe('task:default:ws-1')
    h.cleanup()
  })

  it('keeps running work intact and reports the reason', async () => {
    const h = harness({ workspaceItems: [{ workspaceId: 'ws', title: 'workspace', sessionIds: ['a'] }], sessionSummaries: { a: { running: true } } })
    await expect(h.actions.deleteTask(VIRTUAL_TASK)).rejects.toThrow('运行中')
    expect(h.workspaces.archiveSession).not.toHaveBeenCalled()
    expect(h.applied).toHaveLength(0)
    h.cleanup()
  })

  it('keeps task organization on archive failure for retry', async () => {
    const h = harness({ workspaceItems: [{ workspaceId: 'ws', title: 'workspace', sessionIds: ['a'] }], sessionSummaries: { a: {} } })
    h.workspaces.archiveSession.mockRejectedValueOnce(new Error('archive failed'))
    await expect(h.actions.deleteTask(VIRTUAL_TASK)).rejects.toThrow('archive failed')
    expect(h.applied.flat().some(op => op.kind === 'task/delete')).toBe(false)
    expect(h.sessions.clear).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('manual ordering materializes Default and persists the complete sibling sequence', async () => {
    const h = harness({ workspaceItems: [{ workspaceId: 'ws', title: 'W', sessionIds: ['a', 'b'] }], sessionSummaries: { a: {}, b: {} } })
    await h.actions.reorderCards!(['b', 'a'])
    expect(h.applied[0]?.filter(op => op.kind === 'placement/order')).toEqual([
      { kind: 'placement/order', sessionId: 'b', order: 0 },
      { kind: 'placement/order', sessionId: 'a', order: 1 },
    ])
    expect(h.applied[0]?.filter(op => op.kind === 'placement/set')).toEqual([
      { kind: 'placement/set', sessionId: 'b', taskId: VIRTUAL_TASK.taskId, sceneId: VIRTUAL_SCENE.sceneId, parentSessionId: null },
      { kind: 'placement/set', sessionId: 'a', taskId: VIRTUAL_TASK.taskId, sceneId: VIRTUAL_SCENE.sceneId, parentSessionId: null },
    ])
    h.cleanup()
  })

  it('rejects cross-layer or stale drag lists instead of changing parent relationships', async () => {
    const h = harness({ orgState: FORK_ORG_STATE, workspaceItems: [{ workspaceId: 'ws-1', title: 'W', sessionIds: ['A', 'B', 'C'] }], sessionSummaries: { A: {}, B: { parentId: 'A' }, C: {} } })
    await expect(h.actions.reorderCards!(['B', 'A'])).rejects.toThrow('会话列表已变更')
    expect(h.applied).toHaveLength(0)
    h.cleanup()
  })

  it('deleting a missing task is a no-op; stored scenes emit delete ops', async () => {
    const h = harness()
    await h.actions.deleteTask(VIRTUAL_TASK)
    await h.actions.deleteScene(VIRTUAL_SCENE)
    expect(h.applied).toHaveLength(0)
    await h.actions.deleteScene(STORED_SCENE)
    expect(h.applied[0]).toEqual([{ kind: 'scene/delete', id: 'sc-1' }])
    h.cleanup()
  })

  it('retries once after a revision conflict and surfaces invalid ops as errors', async () => {
    const conflictOnce = harness({
      applyScript: (_, call) => call === 1
        ? { ok: false, error: { code: 'revision-conflict', revision: 9, state: EMPTY_ORG_STATE } }
        : { ok: true, value: { revision: 10, state: EMPTY_ORG_STATE } },
    })
    await conflictOnce.actions.createTask('ws', 'X')
    expect(conflictOnce.org.apply).toHaveBeenCalledTimes(2)
    conflictOnce.cleanup()

    const invalid = harness({ applyScript: () => ({ ok: false, error: { code: 'invalid-op', index: 0, reason: 'nope' } }) })
    await expect(invalid.actions.createTask('ws', 'X')).rejects.toThrow(/nope/)
    invalid.cleanup()
  })
})

describe('workbench actions — drillTo / returnToParent (S3b Task 10, spec §4)', () => {
  function forkHarness(over: Partial<HarnessOptions> = {}) {
    return harness({
      orgState: FORK_ORG_STATE,
      workspaceItems: FORK_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: { parentId: undefined }, C: {} },
      ...over,
    })
  }

  it('drillTo(A) switches the level store to A\'s scene/A and focuses A\'s first child', () => {
    const h = forkHarness()
    h.actions.drillTo('A')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBe('A')
    expect(h.sessions.open).toHaveBeenCalledWith('B')
    h.cleanup()
  })

  it('drillTo on a childless session switches the level without forcing a focus (no children to open)', () => {
    const h = forkHarness()
    h.actions.drillTo('C')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBe('C')
    expect(h.sessions.open).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('drillTo an unresolvable session id is a no-op (no scene to resolve)', () => {
    const h = forkHarness()
    h.actions.drillTo('ghost')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeUndefined()
    h.cleanup()
  })

  it('returnToParent 弹一层并聚焦原来那个被下钻的父会话；根层写显式 null 而不是"未设置"', () => {
    const h = forkHarness()
    h.level.actions.setLevel('sc-1', 'A') // simulate already drilled into A's children
    h.actions.returnToParent('sc-1')
    // A itself is a root session, so the pop lands at the root layer — written
    // EXPLICITLY (null), never left unset: unset means "derive from the focused
    // session", which would immediately re-derive A's child layer and undo the pop.
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeNull()
    expect(h.sessions.open).toHaveBeenCalledWith('A')
    h.cleanup()
  })

  it('returnToParent at the root layer is a no-op', () => {
    const h = forkHarness()
    h.actions.returnToParent('sc-1')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeUndefined()
    expect(h.sessions.open).not.toHaveBeenCalled()
    h.cleanup()
  })

  /**
   * I5 rule 1 reaches `returnToParent` too: after a reload the level store is
   * empty while the carousel is showing a DERIVED drilled layer (focus sits on
   * a child). Reading the raw store there would make the breadcrumb's own
   * 「返回父会话」 button a silent no-op.
   */
  it('无显式层级但焦点在子层时，returnToParent 按派生出的层级弹回（面包屑按钮不再是空操作）', () => {
    const h = forkHarness({ currentSessionId: 'B' }) // B is A's child; the level store is untouched
    h.actions.returnToParent('sc-1')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeNull()
    expect(h.sessions.open).toHaveBeenCalledWith('A')
    h.cleanup()
  })
})

/**
 * S3c Task 1: 「创建子分支」在**尚未物化**的虚拟默认事项/页签里必须先建行。
 *
 * `placement/set` 的 reducer 头两条就要求 scene 行已存在（`org/ops.ts:207-208`）。
 * 全仓其他写路径都先跑 `materializeSceneOps`（`newSession` / `removeCard`），
 * `performFork` 是唯一漏网的——而「DSH 官方入口建会话 → 在它上面点创建子分支」
 * 恰恰是最常见的一条路。
 *
 * 第二条用例把 actions 真正发出的 ops 喂进**真实 reducer**，所以它测的不是
 * "有没有带上那两个 op"，而是"这串 op 到底能不能落库"——这正是用户遇到的现象。
 */
describe('workbench actions — performFork 先物化虚拟事项/页签（S3c Task 1）', () => {
  /** 一个工作区、一个会话 A，组织文档全空 —— 事项与页签都还是虚拟的。 */
  function virtualHarness() {
    return harness({
      orgState: EMPTY_ORG_STATE,
      workspaceItems: [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A'] }],
      sessionSummaries: { A: {} },
    })
  }

  it('发出的 ops 里 task/create 与 scene/create 排在 placement/set 之前', async () => {
    const h = virtualHarness()
    await h.actions.forkChild('A', '子分支')
    const ops = h.applied.at(-1)!
    const kinds = ops.map(op => op.kind)
    expect(kinds).toEqual(['task/create', 'scene/create', 'placement/set'])
    h.cleanup()
  })

  it('这串 ops 喂进真实 reducer 能落库（修复前会被拒）', async () => {
    const h = virtualHarness()
    await h.actions.forkChild('A', '子分支')
    const result = applyOrgOps(EMPTY_ORG_STATE, h.applied.at(-1)!, NOW_S3C)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.reason)
    const placement = result.state.placements.find(row => row.sessionId === 'child-new')
    expect(placement).toBeDefined()
    expect(placement!.parentSessionId).toBe('A')
    expect(placement!.taskId).toBe(defaultTaskId('ws-1'))
    h.cleanup()
  })
})

describe('workbench actions — forkChild / forkSibling / forkPeer (S3b Task 10, spec §4 fork table)', () => {
  function forkHarness(over: Partial<HarnessOptions> = {}) {
    return harness({
      orgState: FORK_ORG_STATE,
      workspaceItems: FORK_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: { parentId: undefined }, C: {} },
      ...over,
    })
  }

  it('forkChild(A): forks A\'s state, places the child under A, drills into A\'s layer, focuses the child', async () => {
    const h = forkHarness()
    await h.actions.forkChild('A', '子分支')
    expect(h.sessions.fork).toHaveBeenCalledWith({ sessionId: 'A' })
    expect(h.rename).toHaveBeenCalledWith('子分支')
    const placementOp = h.applied[0]![0] as Extract<MatouOrgOp, { kind: 'placement/set' }>
    expect(placementOp).toMatchObject({
      kind: 'placement/set', sessionId: 'child-new', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A',
    })
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBe('A') // switched into A's children layer
    expect(h.sessions.open).toHaveBeenCalledWith('child-new') // the new child, not A's other children
    h.cleanup()
  })

  it('message fork passes the selected answer sequence and retains child placement/navigation', async () => {
    const h = forkHarness()
    await h.actions.forkChild('A', '从这里继续', 42)
    expect(h.sessions.fork).toHaveBeenCalledWith({ sessionId: 'A', atSeq: 42 })
    expect(h.rename).toHaveBeenCalledWith('从这里继续')
    expect(h.applied[0]![0]).toMatchObject({ kind: 'placement/set', parentSessionId: 'A', relationKind: 'forked-from', taskId: 't-1', sceneId: 'sc-1' })
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBe('A')
    expect(h.sessions.open).toHaveBeenCalledWith('child-new')
    h.cleanup()
  })

  it('forkSibling(B): forks B\'s EFFECTIVE PARENT (A)\'s state, places the child under A, stays in the current layer', async () => {
    const h = forkHarness()
    await h.actions.forkSibling('B', '兄弟分支')
    // Name-forwarding to rename() is already covered by the forkChild case above;
    // this test's own focus is the state-source/placement split (forked FROM A, not B).
    expect(h.sessions.fork).toHaveBeenCalledWith({ sessionId: 'A' }) // forked FROM A, not B
    const placementOp = h.applied[0]![0] as Extract<MatouOrgOp, { kind: 'placement/set' }>
    expect(placementOp).toMatchObject({ sessionId: 'child-new', parentSessionId: 'A' })
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeUndefined() // NOT drilled — stays at B's own layer
    h.cleanup()
  })

  it('forkSibling on a root session (no effective parent) rejects — the caller gates this button on canForkSibling', async () => {
    const h = forkHarness()
    await expect(h.actions.forkSibling('A', 'x')).rejects.toThrow(/effective parent/)
    h.cleanup()
  })

  it('forkPeer(B): forks B\'s OWN state (a copy), places the child under B\'s effective parent (A), stays put', async () => {
    const h = forkHarness()
    await h.actions.forkPeer('B', '平级分支')
    expect(h.sessions.fork).toHaveBeenCalledWith({ sessionId: 'B' }) // forked FROM B itself, unlike forkSibling
    const placementOp = h.applied[0]![0] as Extract<MatouOrgOp, { kind: 'placement/set' }>
    expect(placementOp).toMatchObject({ sessionId: 'child-new', parentSessionId: 'A' })
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeUndefined()
    h.cleanup()
  })

  it('forkPeer(A) on a ROOT session: forks A itself, the child lands unparented in A\'s own scene (spec §4 "A 是根则无父")', async () => {
    const h = forkHarness()
    await h.actions.forkPeer('A', 'E')
    expect(h.sessions.fork).toHaveBeenCalledWith({ sessionId: 'A' })
    const placementOp = h.applied[0]![0] as Extract<MatouOrgOp, { kind: 'placement/set' }>
    expect(placementOp).toMatchObject({ sessionId: 'child-new', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null })
    h.cleanup()
  })

  it('a failed rename after fork rejects and surfaces the rename error', async () => {
    const h = forkHarness({ renameOk: false })
    await expect(h.actions.forkChild('A', '子分支')).rejects.toThrow(/rename failed/)
    h.cleanup()
  })
})

describe('workbench actions — removeCard cascade + empty-tab guard (fix round: review I1)', () => {
  function removeHarness(over: Partial<HarnessOptions> = {}) {
    return harness({
      orgState: REMOVE_ORG_STATE,
      workspaceItems: REMOVE_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: {} },
      ...over,
    })
  }

  it('removeCard(B, false): B has no children, archives just B and writes no placement op at all', async () => {
    const h = removeHarness()
    await h.actions.removeCard('B', false)
    expect(h.workspaces.archiveSession).toHaveBeenCalledTimes(1)
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('B')
    expect(h.applied).toHaveLength(0) // a leaf has nothing to reparent
    h.cleanup()
  })

  /**
   * C2 (final review): 码头's own remove dialog PROMISES this
   * (`RemoveNodeDialog.tsx:31-35`: 「后代会话将重连到当前节点的父级 / 直接后代
   * 会话将成为根节点」). Archiving A without rewriting B's parent left B
   * unreachable in the plugin outright: `known-sessions.ts` drops archived A,
   * so `allNodes` has no A; B's `parentId` still points at A, so
   * `childrenOfLevel(allNodes, undefined)` excludes it from the root layer;
   * and with no A card there is no badge to drill through — while the drill
   * level itself is deliberately unpersisted, so a reload cannot recover it
   * either. B kept counting toward the tab's session total and its
   * empty-tab guard the whole time.
   */
  it('removeCard(A, false)：归档前把 A 的直接子代重挂到 A 的父级；A 是根，故 B 显式清父', async () => {
    const h = removeHarness()
    await h.actions.removeCard('A', false)
    expect(h.applied).toEqual([[
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null },
    ]])
    expect(h.workspaces.archiveSession).toHaveBeenCalledTimes(1)
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('A')
    expect(h.workspaces.archiveSession).not.toHaveBeenCalledWith('B')
    h.cleanup()
  })

  it('removeCard(B, false) 在 A→B→C 链上：C 重挂到 B 的父级 A（不是变成根）', async () => {
    const h = harness({
      orgState: NESTED_ORG_STATE, workspaceItems: NESTED_WORKSPACE_ITEMS, sessionSummaries: { A: {}, B: {}, C: {} },
    })
    await h.actions.removeCard('B', false)
    expect(h.applied).toEqual([[
      { kind: 'placement/set', sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A' },
    ]])
    expect(h.workspaces.archiveSession).toHaveBeenCalledTimes(1)
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('B')
    h.cleanup()
  })

  /**
   * C2 follow-up: above, B's direct children AND full descendants are both
   * exactly {C} — it can't tell "reparent direct children only" from
   * "reparent every descendant". Removing A diverges the two: only B (A's
   * direct child) may move; C (B's child, not A's) must stay under B.
   */
  it('removeCard(A, false) 在 A→B→C 链上：只重挂直接子代 B（根则显式清父），C 保持挂在 B 下不被触碰', async () => {
    const h = harness({
      orgState: NESTED_ORG_STATE, workspaceItems: NESTED_WORKSPACE_ITEMS, sessionSummaries: { A: {}, B: {}, C: {} },
    })
    await h.actions.removeCard('A', false)
    expect(h.applied).toEqual([[
      { kind: 'placement/set', sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: null },
    ]])
    expect(h.workspaces.archiveSession).toHaveBeenCalledTimes(1)
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('A')
    h.cleanup()
  })

  it('removeCard(A, true): cascade=true archives A AND its descendant B', async () => {
    const h = removeHarness()
    // Cascading A+B would empty the 2-session scene entirely — the guard
    // below covers that case; here we only assert the descendant collection
    // itself is correct, using a scene wide enough that cascading A doesn't
    // trip the guard (C is an unrelated root sibling, not part of A's subtree).
    const wide = harness({
      orgState: FORK_ORG_STATE, workspaceItems: FORK_WORKSPACE_ITEMS, sessionSummaries: { A: {}, B: {}, C: {} },
    })
    await wide.actions.removeCard('A', true)
    expect(wide.workspaces.archiveSession).toHaveBeenCalledTimes(2)
    expect(wide.workspaces.archiveSession).toHaveBeenCalledWith('A')
    expect(wide.workspaces.archiveSession).toHaveBeenCalledWith('B')
    expect(wide.workspaces.archiveSession).not.toHaveBeenCalledWith('C')
    // C2: nothing is reparented on a cascade — the whole subtree is leaving.
    expect(wide.applied).toHaveLength(0)
    wide.cleanup()
    h.cleanup()
  })

  it('removeCard(A, true) rejects when cascading A+B would empty the 2-session scene entirely (spec §3/§7.1)', async () => {
    const h = removeHarness()
    await expect(h.actions.removeCard('A', true)).rejects.toThrow(/no sessions/)
    expect(h.workspaces.archiveSession).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('清空守卫拒绝时不写任何 placement——重挂发生在守卫之后（C2）', async () => {
    const h = harness({ orgState: SOLO_ORG_STATE, workspaceItems: SOLO_WORKSPACE_ITEMS, sessionSummaries: { X: {} } })
    await expect(h.actions.removeCard('X', false)).rejects.toThrow(/no sessions/)
    expect(h.applied).toHaveLength(0)
    h.cleanup()
  })

  it('removeCard(X, false) on a solo session rejects — 移除页签里最后一张被拒绝', async () => {
    const h = harness({ orgState: SOLO_ORG_STATE, workspaceItems: SOLO_WORKSPACE_ITEMS, sessionSummaries: { X: {} } })
    await expect(h.actions.removeCard('X', false)).rejects.toThrow(/no sessions/)
    expect(h.workspaces.archiveSession).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('removeCard on a session with no resolvable placement archives it unconditionally (no scene to keep non-empty)', async () => {
    const h = harness({ sessionSummaries: { ghost: {} } })
    await h.actions.removeCard('ghost', false)
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('ghost')
    h.cleanup()
  })
})

/**
 * I2 + M8 (final review, Ruling-20): `actions.ts` now reads the same node
 * projection AppFrame's carousel and the header seat read, so archived rows
 * are gone everywhere at once and a descendant walk cannot leave the tab.
 */
describe('workbench actions — 节点投影同源：归档过滤与场景边界', () => {
  it('drillTo：唯一子会话已归档时不聚焦它（此前会切到轮播里不存在的已归档会话）', () => {
    const h = harness({
      orgState: REMOVE_ORG_STATE, workspaceItems: REMOVE_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: {} }, archivedSessionIds: ['B'],
    })
    h.actions.drillTo('A')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBe('A')
    expect(h.sessions.open).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('removeCard 级联：已归档的后代不再被重复归档，也不再计入清空守卫', async () => {
    const h = harness({
      orgState: NESTED_ORG_STATE, workspaceItems: NESTED_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: {}, C: {} }, archivedSessionIds: ['C'],
    })
    // Live sessions in sc-1 are A and B; cascading A takes only A + B, which
    // would empty the tab — the guard must see 2 live rows, not 3.
    await expect(h.actions.removeCard('A', true)).rejects.toThrow(/no sessions/)
    expect(h.workspaces.archiveSession).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('removeCard 级联：后代收集不跨页签（M8：别的页签里指向 A 的会话不受牵连）', async () => {
    const crossScene: MatouOrgState = {
      tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
      scenes: [
        { id: 'sc-1', taskId: 't-1', name: 'S1', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 },
        { id: 'sc-2', taskId: 't-1', name: 'S2', titlePinned: false, sortKey: 2, createdAt: 1, updatedAt: 1 },
      ],
      placements: [
        { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
        { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 2, updatedAt: 1 },
        { sessionId: 'K', taskId: 't-1', sceneId: 'sc-1', sortKey: 3, updatedAt: 1 },
        { sessionId: 'Y', taskId: 't-1', sceneId: 'sc-2', parentSessionId: 'A', sortKey: 1, updatedAt: 1 },
      ],
    }
    const h = harness({
      orgState: crossScene,
      workspaceItems: [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B', 'K', 'Y'] }],
      sessionSummaries: { A: {}, B: {}, K: {}, Y: {} },
    })
    await h.actions.removeCard('A', true)
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('A')
    expect(h.workspaces.archiveSession).toHaveBeenCalledWith('B')
    expect(h.workspaces.archiveSession).not.toHaveBeenCalledWith('Y')
    h.cleanup()
  })
})

describe('workbench actions — drillTo focuses the first ACTIVE child (fix round: review I2)', () => {
  function priorityHarness(over: Partial<HarnessOptions> = {}) {
    return harness({
      orgState: PRIORITY_ORG_STATE, workspaceItems: PRIORITY_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B1: {}, B2: {}, B3: {} },
      ...over,
    })
  }

  it('all children idle: falls back to MRU order (first child, B1)', () => {
    const h = priorityHarness()
    h.actions.drillTo('A')
    expect(h.sessions.open).toHaveBeenCalledWith('B1')
    h.cleanup()
  })

  it('one child running (B2): picks the running child over idle siblings, even though it is not first in MRU order', () => {
    const h = priorityHarness({ sessionSummaries: { A: {}, B1: {}, B2: { running: true }, B3: {} } })
    h.actions.drillTo('A')
    expect(h.sessions.open).toHaveBeenCalledWith('B2')
    h.cleanup()
  })

  it('one child pending (等待输入, B3) outranks a running child (B2) — CHILD_STATE_PRIORITY order', () => {
    const h = priorityHarness({ sessionSummaries: { A: {}, B1: {}, B2: { running: true }, B3: {} }, pendingIds: ['B3'] })
    h.actions.drillTo('A')
    expect(h.sessions.open).toHaveBeenCalledWith('B3')
    h.cleanup()
  })

  it('a completed-but-unseen child (B1) outranks idle siblings but loses to a running one (B2)', () => {
    const h = priorityHarness({ sessionSummaries: { A: {}, B1: { completed: true }, B2: { running: true }, B3: {} } })
    h.actions.drillTo('A')
    expect(h.sessions.open).toHaveBeenCalledWith('B2')
    h.cleanup()
  })
})

/**
 * S5 Task 8: `revealSession` — the plugin's single-call equivalent of 码头's
 * `TaskSidebar.tsx:159-182` `navigateNotification` body, minus the parts
 * three rulings deliberately drop.
 *
 * 码头 runs four separate activations (workspace → task → scene → session)
 * plus `HierarchyShell.tsx:1040-1055`'s `onRevealSession`, which sets that
 * scene's layer to the target's own `parentSessionId ?? null`. Here that is
 * one `navigate({workspaceId, taskId, sceneId, sessionId})` — this repo's
 * nav memory writes all four levels at once — plus the same explicit
 * `setLevel(sceneId, parent ?? null)`, plus `sessions.open` (码头's
 * `activateSession`; nav memory alone does not move DSH's current session
 * when the scene is unchanged).
 *
 * Ruling-S5-7: the "detached to another window" branch is NOT ported — DSH
 * has no such dimension. Ruling-S5-8: a target the org view cannot place
 * (its session archived, its workspace gone, …) is ONE failure, reported as
 * `false`, never a silent partial navigation — the caller turns that into a
 * toast. `locateSession` is what decides that, so there is no three-tier
 * task fallback here: this plugin's notifications always carry a session,
 * and a session either has a full home or none.
 */
/**
 * S3c Task 3 的端到端用例：在一个**根**会话上「⑂ Fork 会话」，新会话必须与
 * 它并排，而不是变成它的子会话。
 *
 * 这条路径要三层都对才成立，所以在这里合起来测：actions 发出显式
 * `parentSessionId: null` → reducer 原样存下 null（而不是压成缺席）→
 * `effectiveParentOf` 见到 null 就不回落 DSH 的父。DSH 记的新会话
 * `parentId` 恰恰是它复制状态的那个源会话，任何一层漏掉第三态，用户就会
 * 看到新会话跑到源会话的下一层去。
 */
/**
 * S3c Task 4: 落位记录关系种类，供关系图把两种边画成不同样式（码头
 * `dag.css:32-35`：forked-from 实线、derived-from 虚线）。
 *
 * 种类不需要新参数——它由 `performFork` 已有的两个字段推出：**挂到谁下面**
 * 与**从谁复制状态**是不是同一个会话。这也正是调研复核给出的重建规则
 * （placement 父 == DSH parentId → forked-from）。
 *
 * | 入口 | 挂到 | 状态来自 | 种类 |
 * |---|---|---|---|
 * | 创建子分支 | A | A | forked-from |
 * | 兄弟分支   | A 的父 P | P | forked-from |
 * | ⑂ Fork 会话 | A 的父 P | A | derived-from |
 * | 下钻层新会话 | 当前层父 | 无 | derived-from |
 */
describe('workbench actions — 落位记录关系种类（S3c Task 4）', () => {
  function forkHarnessS3c() {
    return harness({
      orgState: FORK_ORG_STATE,
      workspaceItems: FORK_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: { parentId: 'A' }, C: {} },
    })
  }

  const placementOf = (h: ReturnType<typeof harness>) =>
    h.applied.at(-1)!.find(op => op.kind === 'placement/set')! as Extract<MatouOrgOp, { kind: 'placement/set' }>

  it('创建子分支 → forked-from（挂到 A、状态也来自 A）', async () => {
    const h = forkHarnessS3c()
    await h.actions.forkChild('A', '子')
    expect(placementOf(h).relationKind).toBe('forked-from')
    h.cleanup()
  })

  it('兄弟分支 → forked-from（挂到 A 的父、状态也来自那个父）', async () => {
    const h = forkHarnessS3c()
    await h.actions.forkSibling('B', '兄弟')
    expect(placementOf(h).relationKind).toBe('forked-from')
    h.cleanup()
  })

  it('⑂ Fork 会话 → derived-from（挂到 A 的父、状态却来自 A）', async () => {
    const h = forkHarnessS3c()
    await h.actions.forkPeer('B', '平级')
    expect(placementOf(h).relationKind).toBe('derived-from')
    h.cleanup()
  })

  it('下钻层里「新会话」→ derived-from（谁的状态都没复制）', async () => {
    const h = forkHarnessS3c()
    await h.actions.newSession(STORED_SCENE, 'A')
    expect(placementOf(h).relationKind).toBe('derived-from')
    h.cleanup()
  })

  it('根层「新会话」不写种类（没有父边，也就没有边可标）', async () => {
    const h = forkHarnessS3c()
    await h.actions.newSession(STORED_SCENE)
    expect(placementOf(h).relationKind).toBeUndefined()
    h.cleanup()
  })
})

describe('workbench actions — 根会话上的平级 Fork 不该变成子会话（S3c Task 3）', () => {
  it('emitted ops 经真实 reducer 后，新会话的有效父是「根」而不是源会话', async () => {
    const h = harness({
      orgState: FORK_ORG_STATE,
      workspaceItems: FORK_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: { parentId: 'A' }, C: {} },
      forkResult: 'E',
    })
    await h.actions.forkPeer('A', '平级')

    const applied = applyOrgOps(FORK_ORG_STATE, h.applied.at(-1)!, NOW_S3C)
    if (!applied.ok) throw new Error(applied.error.reason)
    // 盘上是「追加一个标记」而不是「把父写成 null」（S3c 审查 I1：值域放宽会
    // 让旧代码打不开整个存储域）。真正要证明的是下面那句——有效父是「根」。
    const stored = applied.state.placements.find(row => row.sessionId === 'E')!
    expect(stored.parentSessionId).toBeUndefined()
    expect(stored.explicitRoot).toBe(true)

    // DSH 那边把 E 的父记成 A（它就是从 A 复制的状态）——第三态必须挡住这次回落。
    const parent = effectiveParentOf(
      'E',
      placementsBySessionOf(applied.state.placements),
      id => (id === 'E' ? 'A' : undefined),
    )
    expect(parent).toBeUndefined()
    h.cleanup()
  })
})

describe('workbench actions — revealSession（S5 Task 8，码头 navigateNotification + onRevealSession）', () => {
  function forkHarness(over: Partial<HarnessOptions> = {}) {
    return harness({
      orgState: FORK_ORG_STATE,
      workspaceItems: FORK_WORKSPACE_ITEMS,
      sessionSummaries: { A: {}, B: {}, C: {} },
      ...over,
    })
  }

  it('跳到子层会话 B：层级设成 B 的父 A，导航四段齐全，并聚焦 B', () => {
    const h = forkHarness()
    expect(h.actions.revealSession('B')).toBe(true)
    // 码头 onRevealSession: levelParentByScene[sceneId] = node.parentSessionId ?? null
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBe('A')
    const nav = h.nav.getSnapshot()
    expect(nav.activeWorkspaceId).toBe('ws-1')
    expect(nav.taskByWorkspace['ws-1']).toBe('t-1')
    expect(nav.sceneByTask['t-1']).toBe('sc-1')
    // Only written when BOTH sceneId and sessionId reached `remember` — the
    // proof that all four segments were passed in one call.
    expect(nav.sessionByScene['sc-1']).toBe('B')
    expect(h.sessions.open).toHaveBeenCalledWith('B')
    h.cleanup()
  })

  it('跳到根层会话 A：层级写显式 null（不是"未设置"，否则会被焦点派生立刻改回去）', () => {
    const h = forkHarness()
    expect(h.actions.revealSession('A')).toBe(true)
    expect(h.level.getSnapshot().parentBySceneId).toHaveProperty('sc-1')
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeNull()
    expect(h.sessions.open).toHaveBeenCalledWith('A')
    h.cleanup()
  })

  it('会话已不在现场（已归档）：返回 false，层级/导航/焦点一概不动', () => {
    const h = forkHarness({ archivedSessionIds: ['B'] })
    expect(h.actions.revealSession('B')).toBe(false)
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeUndefined()
    expect(h.nav.getSnapshot().activeWorkspaceId).toBeUndefined()
    expect(h.sessions.open).not.toHaveBeenCalled()
    h.cleanup()
  })

  /**
   * Ruling-S5-8: 码头's own first step (`workspaces.find(...)` then a bare
   * `return`) leaves the user with a dead click — no feedback, panel still
   * open. Here a missing workspace is the SAME failure as a missing session,
   * so the caller can give it the same toast.
   */
  it('工作区已不存在：与"会话已不存在"走同一条失败路径（Ruling-S5-8）', () => {
    const h = forkHarness({ workspaceItems: [] })
    expect(h.actions.revealSession('B')).toBe(false)
    expect(h.level.getSnapshot().parentBySceneId['sc-1']).toBeUndefined()
    expect(h.sessions.open).not.toHaveBeenCalled()
    h.cleanup()
  })

  it('完全未知的会话 id：返回 false', () => {
    const h = forkHarness()
    expect(h.actions.revealSession('ghost')).toBe(false)
    expect(h.sessions.open).not.toHaveBeenCalled()
    h.cleanup()
  })

  /**
   * S4 Task 8（裁定 T-5）：`sessions.open` 之后再补一条**强制重新居中**请求。
   * 没有它，「点 DAG 里那个已经是当前会话的节点」和「点通知中心里指向当前已
   * 聚焦会话的那一条」都只是把已经成立的状态又写了一遍 —— 焦点 id 没变，
   * `useCarouselController` 的居中副作用就不会跑，屏幕上一动不动。码头的
   * `onRevealSession`（`HierarchyShell.tsx:1047-1054`）同样在这一步递增
   * `sequence`。
   */
  it('成功跳转会为该页签递增一次强制居中请求（seq 从 1 起）', () => {
    const h = forkHarness()
    expect(h.actions.revealSession('B')).toBe(true)
    expect(h.reveal.getSnapshot().bySceneId['sc-1']).toEqual({ sessionId: 'B', seq: 1 })
    h.cleanup()
  })

  it('对同一个会话连点两次：seq 递增到 2（目标不变正是这条修复的目标情形）', () => {
    const h = forkHarness()
    h.actions.revealSession('B')
    h.actions.revealSession('B')
    expect(h.reveal.getSnapshot().bySceneId['sc-1']).toEqual({ sessionId: 'B', seq: 2 })
    h.cleanup()
  })

  it('失败路径不写请求：会话已归档时 reveal store 一个字都不动', () => {
    const h = forkHarness({ archivedSessionIds: ['B'] })
    expect(h.actions.revealSession('B')).toBe(false)
    expect(h.reveal.getSnapshot().bySceneId).toEqual({})
    h.cleanup()
  })
})

/**
 * S4 Task 7: the DAG overlay's open/closed flag is a store the actions write,
 * not local React state — the tab-bar button (`SceneTabBar.tsx`) and the
 * overlay (`shell.overlay`) are different seats in different React subtrees,
 * the same Ruling-S5-1 reason `notifications/panel-store.ts` gives.
 */
describe('openDag / closeDag（S4 Task 7）', () => {
  it('openDag 把 DAG 面板 store 写成 open: true', () => {
    const h = harness()
    expect(h.dag.getSnapshot().open).toBe(false)
    h.actions.openDag()
    expect(h.dag.getSnapshot().open).toBe(true)
    h.cleanup()
  })

  it('closeDag 把 DAG 面板 store 写成 open: false', () => {
    const h = harness()
    h.actions.openDag()
    h.actions.closeDag()
    expect(h.dag.getSnapshot().open).toBe(false)
    h.cleanup()
  })

  /**
   * 两个方向永远来自不同的交互（浮层开着时 `#root` 是 inert 的，页签栏那颗
   * 按钮根本点不到），所以这两个动作各写一个方向、绝不翻转——这条断言是
   * "没有 toggle" 这个决定在 actions 这一层的牙齿。
   */
  it('两个方向都幂等：重复调用不会把对方的结果翻回去', () => {
    const h = harness()
    h.actions.openDag()
    h.actions.openDag()
    expect(h.dag.getSnapshot().open).toBe(true)
    h.actions.closeDag()
    h.actions.closeDag()
    expect(h.dag.getSnapshot().open).toBe(false)
    h.cleanup()
  })

  /**
   * `openDag` 从可选改必选（plan Task 7）的运行时对照：`createWorkbenchActions`
   * 的返回值必须两个都实现。`tsconfig.json` 只 typecheck `src`，所以 src 侧
   * 由类型兜底，这里给测试侧留一个同样的断言。
   */
  it('createWorkbenchActions 一定实现这两个动作（不是可选成员）', () => {
    const h = harness()
    expect(typeof h.actions.openDag).toBe('function')
    expect(typeof h.actions.closeDag).toBe('function')
    h.cleanup()
  })
})

describe('new session directly right of a card', () => {
  it.each(['A', 'C', 'B'])('inserts next to %s and retains its effective parent', async (anchorId) => {
    const h = harness({ orgState: FORK_ORG_STATE, workspaceItems: FORK_WORKSPACE_ITEMS, sessionSummaries: { A: {}, B: { parentId: 'A' }, C: {} } })
    await h.actions.newSessionNextTo(anchorId)
    expect(h.sessions.fork).not.toHaveBeenCalled()
    const result = applyOrgOps(FORK_ORG_STATE, h.applied[0]!, NOW_S3C)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const rows = result.state.placements.filter(row => row.sceneId === 'sc-1').sort((a, b) => a.sortKey - b.sortKey)
    expect(rows[rows.findIndex(row => row.sessionId === anchorId) + 1]?.sessionId).toBe('s-new')
    const added = rows.find(row => row.sessionId === 's-new')!
    expect(added.parentSessionId).toBe(anchorId === 'B' ? 'A' : undefined)
    expect(added.interactionAt).toBe(0)
    expect(h.sessions.open).toHaveBeenCalledWith('s-new')
    h.cleanup()
  })
  it('materializes a virtual default without losing existing cards', async () => {
    const h = harness({ workspaceItems: [{ workspaceId: 'ws', title: 'W', sessionIds: ['A', 'B'] }], sessionSummaries: { A: {}, B: {} } })
    await h.actions.newSessionNextTo('A')
    const result = applyOrgOps(EMPTY_ORG_STATE, h.applied[0]!, NOW_S3C)
    expect(result.ok).toBe(true)
    if (result.ok) expect([...result.state.placements].sort((a,b) => a.sortKey - b.sortKey).map(row => row.sessionId)).toEqual(['A', 's-new', 'B'])
    h.cleanup()
  })
  it('does not create a session when the source card has gone', async () => {
    const h = harness()
    await expect(h.actions.newSessionNextTo('gone')).rejects.toThrow()
    expect(h.sessions.create).not.toHaveBeenCalled()
    h.cleanup()
  })
})

it('keeps a new card immediately right after persisted MRU ordering, including a pending source interaction', async () => {
  const { projectControlTargets } = await import('../src/control/topology.ts')
  const state: MatouOrgState = { ...FORK_ORG_STATE, placements: FORK_ORG_STATE.placements.map(row => ({ ...row, interactionAt: row.sessionId === 'A' ? 20 : 80 })) }
  const h = harness({ orgState: state, workspaceItems: FORK_WORKSPACE_ITEMS, sessionSummaries: { A: { updatedAt: 100 }, B: { parentId: 'A' }, C: { updatedAt: 80 } } })
  await h.actions.newSessionNextTo('A')
  const result = applyOrgOps(state, h.applied[0]!, NOW_S3C)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.state.placements.find(row => row.sessionId === 's-new')?.interactionAt).toBe(100)
  const targets = projectControlTargets({
    org: result.state, archivedSessionIds: [],
    workspaces: FORK_WORKSPACE_ITEMS.map(ws => ({ ...ws, sessionIds: [...ws.sessionIds, 's-new'] })),
    summaryOf: id => id === 'B' ? { parentId: 'A', updatedAt: 80 } : { updatedAt: id === 'A' ? 100 : id === 'C' ? 80 : 0 },
  })
  expect(targets.filter(target => target.depth === 0).map(target => target.sessionId)).toEqual(['A', 's-new', 'C'])
  h.cleanup()
})
