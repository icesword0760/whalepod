// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OrgMirrorState } from '../src/client/org/store.ts'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import type { WorkbenchActions } from '../src/client/workbench/actions.ts'
import {
  aggregateChildState, CardHeaderActions, CardHeaderActionsEntry, directChildCount,
  hasEffectiveParent, placementsBySessionOf, registerHeaderSeats,
} from '../src/client/carousel/header-seats.tsx'
import type {
  CardHeaderActionsEntryProps, CardHeaderActionsFace, CardHeaderActionsInjected,
} from '../src/client/carousel/header-seats.tsx'

afterEach(cleanup)

/** A spy wrapping the real zh dictionary (same convention as card-shell.client.spec.tsx). */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

function actionsDouble(): CardHeaderActionsFace {
  return {
    drillTo: vi.fn(),
    forkChild: vi.fn(async () => undefined),
    forkSibling: vi.fn(async () => undefined),
    forkPeer: vi.fn(async () => undefined),
    removeCard: vi.fn(),
  }
}

/** `registerHeaderSeats`' 3rd param (Task 10: the seat delegates to the plugin's one real `WorkbenchActions`). */
function workbenchActionsDouble(): WorkbenchActions {
  return {
    addWorkspace: vi.fn(async () => undefined), createTask: vi.fn(async () => 'new'),
    renameTask: vi.fn(async () => undefined), setTaskPinned: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined), createScene: vi.fn(async () => 'sc'), renameScene: vi.fn(async () => undefined),
    deleteScene: vi.fn(async () => undefined), newSession: vi.fn(async () => undefined), openSession: vi.fn(),
    clearSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(),
    renameSession: vi.fn(async () => undefined), archiveSession: vi.fn(async () => undefined), navigate: vi.fn(),
    newSessionNextTo: vi.fn(async () => undefined),
    drillTo: vi.fn(), returnToParent: vi.fn(),
    forkChild: vi.fn(async () => undefined), forkSibling: vi.fn(async () => undefined), forkPeer: vi.fn(async () => undefined),
    removeCard: vi.fn(async () => undefined),
  }
}

const EMPTY_ORG: OrgMirrorState = { phase: 'ready', revision: 0, org: { tasks: [], scenes: [], placements: [] } }

function orgStoreDouble(state: OrgMirrorState = EMPTY_ORG) {
  return { getSnapshot: () => state, subscribe: () => () => {} }
}

const BASE = {
  sessionId: 'A',
  title: '登录修复',
  childCount: 0,
  canForkSibling: false,
}

describe('registerHeaderSeats', () => {
  /** Minimal SlotRegistry bench: declares the header-actions list slot flat under a fake root. */
  async function bench(over: { sessions?: unknown; workspaces?: unknown } = {}) {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.session.header.utilities': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    ctx.provide('sessions', (over.sessions ?? { binding: () => undefined }) as never)
    ctx.provide('workspaces', (over.workspaces ?? { archiveSession: vi.fn(async () => undefined) }) as never)
    return { ctx, slots: ctx.get('slots') as SlotRegistry }
  }

  it('注册 conversation.session.header.utilities，order 30 坐最后', async () => {
    const { ctx, slots } = await bench()
    registerHeaderSeats(ctx, orgStoreDouble(), workbenchActionsDouble())
    const entry = slots.entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'matou-card-actions')
    expect(entry?.options.order).toBe(30)
    expect(entry?.locale).toBe('matou')
  })

  it('disposer 移除注册（HMR 安全）', async () => {
    const { ctx, slots } = await bench()
    const dispose = registerHeaderSeats(ctx, orgStoreDouble(), workbenchActionsDouble())
    const ids = () => slots.entries('conversation.session.header.utilities').map(entry => entry.options.id)
    expect(ids()).toContain('matou-card-actions')
    dispose()
    expect(ids()).not.toContain('matou-card-actions')
  })

  it('face 的 removeCard 委派给注入的 WorkbenchActions.removeCard（Task 10：不再直连 ctx.workspaces）', async () => {
    const workbenchActions = workbenchActionsDouble()
    const { ctx, slots } = await bench()
    registerHeaderSeats(ctx, orgStoreDouble(), workbenchActions)
    const entry = slots.entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'matou-card-actions')!
    const face = (entry.inject as () => CardHeaderActionsInjected)()
    face.removeCard('s1', true)
    expect(workbenchActions.removeCard).toHaveBeenCalledWith('s1', true)
  })

  it('face 的 renameSession 委派给 ctx.sessions.binding(id).session.rename（已有服务，非占位，未过 WorkbenchActions）', async () => {
    const rename = vi.fn(async () => ({ ok: true, value: undefined }))
    const { ctx, slots } = await bench({ sessions: { binding: () => ({ session: { rename } }) } })
    registerHeaderSeats(ctx, orgStoreDouble(), workbenchActionsDouble())
    const entry = slots.entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'matou-card-actions')!
    const face = (entry.inject as () => CardHeaderActionsInjected)()
    await face.renameSession('s1', '新标题')
    expect(rename).toHaveBeenCalledWith('新标题')
  })

  it('face 的 drillTo/forkChild/forkSibling/forkPeer 委派给注入的 WorkbenchActions（Task 10：真实实现，非占位）', async () => {
    const workbenchActions = workbenchActionsDouble()
    const { ctx, slots } = await bench()
    registerHeaderSeats(ctx, orgStoreDouble(), workbenchActions)
    const entry = slots.entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'matou-card-actions')!
    const face = (entry.inject as () => CardHeaderActionsInjected)()
    await face.newSessionNextTo!('s1')
    expect(workbenchActions.newSessionNextTo).toHaveBeenCalledWith('s1')
    face.drillTo('s1')
    expect(workbenchActions.drillTo).toHaveBeenCalledWith('s1')
    await face.forkChild('s1', '子分支')
    expect(workbenchActions.forkChild).toHaveBeenCalledWith('s1', '子分支')
    await face.forkSibling('s1', '兄弟分支')
    expect(workbenchActions.forkSibling).toHaveBeenCalledWith('s1', '兄弟分支')
    await face.forkPeer('s1', 'Fork 会话')
    expect(workbenchActions.forkPeer).toHaveBeenCalledWith('s1', 'Fork 会话')
  })

  it('face 带 hooks.org，绑的是 registerHeaderSeats 收到的同一个 org store（既有 hooks 装配模式）', async () => {
    const store = orgStoreDouble()
    const { ctx, slots } = await bench()
    registerHeaderSeats(ctx, store, workbenchActionsDouble())
    const entry = slots.entries('conversation.session.header.utilities')
      .find(candidate => candidate.options.id === 'matou-card-actions')!
    const face = (entry.inject as () => CardHeaderActionsInjected)()
    expect(face.hooks.org).toBe(store)
  })
})

describe('placementsBySessionOf', () => {
  it('把 placements 数组折成 sessionId -> parentSessionId 的 Map', () => {
    const map = placementsBySessionOf([
      { sessionId: 'c1', parentSessionId: 'p' },
      { sessionId: 'c2' },
    ])
    expect(map.get('c1')).toBe('p')
    expect(map.get('c2')).toBeUndefined()
    expect(map.has('other')).toBe(false)
  })
})

describe('directChildCount / hasEffectiveParent（真实 placements，非占位空 Map）', () => {
  function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
    return { displayTitle: over.id, running: false, blank: false, updatedAt: 0, ...over } as SessionSummary
  }

  function listOf(entries: readonly SessionSummary[]): SessionListState {
    const byId: Record<string, SessionSummary> = {}
    for (const entry of entries) byId[entry.id as unknown as string] = entry
    return {
      ids: entries.map(entry => entry.id),
      byId: byId as SessionListState['byId'],
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
      staged: [],
    }
  }

  it('按 DSH 会话的 parentId 统计直接子会话数（无 placements 参数时的默认口径）', () => {
    const list = listOf([
      summary({ id: 'p' }),
      summary({ id: 'c1', parentId: 'p' as SessionId }),
      summary({ id: 'c2', parentId: 'p' as SessionId }),
      summary({ id: 'other', parentId: 'x' as SessionId }),
    ])
    expect(directChildCount(list, 'p')).toBe(2)
  })

  it('排除 origin===subagent 的子会话（Ruling-4 同款口径：子代理进 DAG 不进这个徽标）', () => {
    const list = listOf([
      summary({ id: 'p' }),
      summary({ id: 'sub', parentId: 'p' as SessionId, origin: 'subagent' }),
    ])
    expect(directChildCount(list, 'p')).toBe(0)
  })

  it('无子会话时返回 0', () => {
    const list = listOf([summary({ id: 'p' })])
    expect(directChildCount(list, 'p')).toBe(0)
  })

  it('placement 的 parentSessionId 在 DSH 完全没有 parentId 时也算作子会话（Task 1 的边）', () => {
    const list = listOf([summary({ id: 'p' }), summary({ id: 'c1' })])
    const placements = placementsBySessionOf([{ sessionId: 'c1', parentSessionId: 'p' }])
    expect(directChildCount(list, 'p', placements)).toBe(1)
    expect(directChildCount(list, 'p')).toBe(0) // 不传 placements 时看不到这条边
  })

  it('placement 显式覆盖 DSH 自己的 parentId（effectiveParentOf 的既定优先级）', () => {
    const list = listOf([
      summary({ id: 'p' }), summary({ id: 'other' }),
      summary({ id: 'c1', parentId: 'other' as SessionId }),
    ])
    const placements = placementsBySessionOf([{ sessionId: 'c1', parentSessionId: 'p' }])
    expect(directChildCount(list, 'p', placements)).toBe(1)
    expect(directChildCount(list, 'other', placements)).toBe(0)
  })

  it('hasEffectiveParent：根层会话（无 DSH parentId 也无 placement）为假', () => {
    const list = listOf([summary({ id: 'root' })])
    expect(hasEffectiveParent(list, 'root')).toBe(false)
  })

  it('hasEffectiveParent：有 DSH parentId 时为真', () => {
    const list = listOf([summary({ id: 'p' }), summary({ id: 'c', parentId: 'p' as SessionId })])
    expect(hasEffectiveParent(list, 'c')).toBe(true)
  })

  it('hasEffectiveParent：只靠 placement（DSH 无 parentId）也为真', () => {
    const list = listOf([summary({ id: 'p' }), summary({ id: 'c' })])
    const placements = placementsBySessionOf([{ sessionId: 'c', parentSessionId: 'p' }])
    expect(hasEffectiveParent(list, 'c', placements)).toBe(true)
    expect(hasEffectiveParent(list, 'c')).toBe(false) // 不传 placements 时看不到这条边
  })
})

describe('aggregateChildState（M1：子级聚合状态，warning > ongoing > done）', () => {
  function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
    return { displayTitle: over.id, running: false, blank: false, updatedAt: 0, ...over } as SessionSummary
  }

  function listOf(entries: readonly SessionSummary[]): SessionListState {
    const byId: Record<string, SessionSummary> = {}
    for (const entry of entries) byId[entry.id as unknown as string] = entry
    return {
      ids: entries.map(entry => entry.id),
      byId: byId as SessionListState['byId'],
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
      staged: [],
    }
  }

  const NO_PENDING: ReadonlySet<string> = new Set()

  it('没有子会话时返回 undefined', () => {
    const list = listOf([summary({ id: 'p' })])
    expect(aggregateChildState(list, 'p', placementsBySessionOf([]), NO_PENDING)).toBeUndefined()
  })

  it('子会话 running 时聚合为 ongoing', () => {
    const list = listOf([summary({ id: 'p' }), summary({ id: 'c', parentId: 'p' as SessionId, running: true })])
    expect(aggregateChildState(list, 'p', placementsBySessionOf([]), NO_PENDING)).toBe('ongoing')
  })

  it('子会话 completed 时聚合为 done', () => {
    const list = listOf([summary({ id: 'p' }), summary({ id: 'c', parentId: 'p' as SessionId, completed: true })])
    expect(aggregateChildState(list, 'p', placementsBySessionOf([]), NO_PENDING)).toBe('done')
  })

  it('子会话在 pendingInteractions 里时聚合为 warning（等待输入优先级最高）', () => {
    const list = listOf([summary({ id: 'p' }), summary({ id: 'c', parentId: 'p' as SessionId, running: true })])
    expect(aggregateChildState(list, 'p', placementsBySessionOf([]), new Set(['c']))).toBe('warning')
  })

  it('多个子会话取最高优先级：ongoing 盖过 done', () => {
    const list = listOf([
      summary({ id: 'p' }),
      summary({ id: 'c1', parentId: 'p' as SessionId, completed: true }),
      summary({ id: 'c2', parentId: 'p' as SessionId, running: true }),
    ])
    expect(aggregateChildState(list, 'p', placementsBySessionOf([]), NO_PENDING)).toBe('ongoing')
  })

  it('多个子会话取最高优先级：warning 盖过 ongoing 与 done', () => {
    const list = listOf([
      summary({ id: 'p' }),
      summary({ id: 'c1', parentId: 'p' as SessionId, completed: true }),
      summary({ id: 'c2', parentId: 'p' as SessionId, running: true }),
      summary({ id: 'c3', parentId: 'p' as SessionId }),
    ])
    expect(aggregateChildState(list, 'p', placementsBySessionOf([]), new Set(['c3']))).toBe('warning')
  })
})

describe('CardHeaderActionsEntry（注册进座位的连接件）', () => {
  const CHILD = { id: 'child', displayTitle: 'C', parentId: 'A' as SessionId, running: false, blank: false, updatedAt: 0 }

  function props(over: {
    extraSessions?: readonly SessionSummary[]
    org?: OrgMirrorState
    pending?: ReadonlySet<SessionId>
    /** D4 (S3b Task 11d): overrides session 'A' row's `blank` — the connector's `selfForkReady`/`parentForkReady` source. */
    selfBlank?: boolean
    /** I2 (final review): DSH's archived set, which the connector must exclude exactly as the carousel does. */
    archivedSessionIds?: readonly string[]
  } & Partial<CardHeaderActionsEntryProps> = {}): CardHeaderActionsEntryProps {
    const {
      extraSessions = [CHILD as unknown as SessionSummary], org = EMPTY_ORG, pending = new Set(), selfBlank = false,
      archivedSessionIds = [], ...rest
    } = over
    const byId: Record<string, SessionSummary> = {
      A: { id: 'A', displayTitle: '登录修复', running: false, blank: selfBlank, updatedAt: 0 } as SessionSummary,
    }
    for (const entry of extraSessions) byId[entry.id as unknown as string] = entry
    const list: SessionListState = {
      ids: Object.keys(byId),
      byId: byId as SessionListState['byId'],
      current: 'A' as SessionId,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
      staged: [],
    }
    function useSessions<T>(select: (snapshot: SessionListState) => T): T {
      return select(list)
    }
    function useOrg<T>(select: (snapshot: OrgMirrorState) => T): T {
      return select(org)
    }
    function useSessionPendingInteraction<T>(select: (snapshot: ReadonlySet<SessionId>) => T): T {
      return select(pending)
    }
    // Only `archivedSessionIds` is read by the connector; the rest of
    // `WorkspaceSnapshot` is irrelevant here and deliberately not faked.
    function useWorkspaces<T>(select: (snapshot: { archivedSessionIds: readonly string[] }) => T): T {
      return select({ archivedSessionIds })
    }
    return {
      sessionId: 'A' as SessionId,
      useSessions,
      useOrg,
      useWorkspaces,
      // The real prop reads a Map<SessionId, SessionPendingInteraction>; this
      // fixture only needs "is this id pending", so it fakes a Set-shaped
      // read through the same call signature (CardHeaderActionsEntry only
      // ever calls .has on what this selector returns).
      useSessionPendingInteraction,
      t: spyT(),
      drillTo: vi.fn(),
      forkChild: vi.fn(),
      forkSibling: vi.fn(),
      forkPeer: vi.fn(),
      removeCard: vi.fn(),
      renameSession: vi.fn(async () => undefined),
      ...rest,
    } as unknown as CardHeaderActionsEntryProps
  }

  it('从 useSessions 派生标题与子会话数，渲染徽标', () => {
    render(<CardHeaderActionsEntry {...props()} />)
    expect(screen.getByText('子会话 1')).toBeTruthy()
  })

  it('点击子会话徽标调用注入 face 的 drillTo', () => {
    const drillTo = vi.fn()
    render(<CardHeaderActionsEntry {...props({ drillTo })} />)
    fireEvent.click(screen.getByRole('button', { name: /子会话 1/ }))
    expect(drillTo).toHaveBeenCalledWith('A')
  })

  it('I1：会话本身无有效父（根层）时不渲染兄弟分支按钮', () => {
    render(<CardHeaderActionsEntry {...props()} />)
    expect(screen.queryByRole('button', { name: /兄弟分支/ })).toBeNull()
  })

  it('I1：会话有 DSH parentId 时渲染兄弟分支按钮', () => {
    render(<CardHeaderActionsEntry {...props({ sessionId: 'child' as SessionId })} />)
    expect(screen.getByRole('button', { name: /兄弟分支/ })).toBeTruthy()
  })

  it('I2：仅靠 org store 的 placement（DSH 无 parentId）也渲染兄弟分支按钮', () => {
    const placement = { sessionId: 'A', taskId: 't', sceneId: 's', parentSessionId: 'root', sortKey: 0, updatedAt: 0 }
    const org: OrgMirrorState = {
      phase: 'ready', revision: 1,
      org: { tasks: [], scenes: [], placements: [placement] },
    }
    // `root` must be a real, live session: a sibling-fork resumes FROM the
    // parent, so a placement edge pointing at a session that isn't there is
    // not a parent the header may offer to fork (final review I2).
    const root = { id: 'root', displayTitle: 'Root', running: false, blank: false, updatedAt: 0 } as SessionSummary
    render(<CardHeaderActionsEntry {...props({ org, extraSessions: [root] })} />)
    expect(screen.getByRole('button', { name: /兄弟分支/ })).toBeTruthy()
  })

  /**
   * I2 (final review) scenario 3: the same card, two entry points, one
   * answer. An archived parent is no parent — the carousel's own layers
   * dropped it, so the header must not keep offering a sibling-fork whose
   * state source is gone.
   */
  it('I2：有效父已归档时，兄弟分支按钮消失（与轮播层级同源）', () => {
    const placement = { sessionId: 'A', taskId: 't', sceneId: 's', parentSessionId: 'root', sortKey: 0, updatedAt: 0 }
    const org: OrgMirrorState = {
      phase: 'ready', revision: 1,
      org: { tasks: [], scenes: [], placements: [placement] },
    }
    const root = { id: 'root', displayTitle: 'Root', running: false, blank: false, updatedAt: 0 } as SessionSummary
    render(<CardHeaderActionsEntry {...props({ org, extraSessions: [root], archivedSessionIds: ['root'] })} />)
    expect(screen.queryByRole('button', { name: /兄弟分支/ })).toBeNull()
  })

  /**
   * I2 (final review) scenario 1: the official header counted archived
   * children while the compact header (fed by AppFrame's already-filtered
   * projection) showed none — one card, two headers, two numbers.
   */
  it('I2：已归档的子会话不计入官方头的子会话徽标（此前两个头两个数）', () => {
    const org: OrgMirrorState = {
      phase: 'ready', revision: 1,
      org: {
        tasks: [], scenes: [],
        placements: [{ sessionId: 'gone', taskId: 't', sceneId: 's', parentSessionId: 'A', sortKey: 0, updatedAt: 0 }],
      },
    }
    const gone = { id: 'gone', displayTitle: 'Gone', running: false, blank: false, updatedAt: 0 } as SessionSummary
    const { rerender } = render(
      <CardHeaderActionsEntry {...props({ org, extraSessions: [gone] })} />,
    )
    expect(screen.getByText('子会话 1')).toBeTruthy()
    rerender(<CardHeaderActionsEntry {...props({ org, extraSessions: [gone], archivedSessionIds: ['gone'] })} />)
    expect(screen.queryByText('子会话 1')).toBeNull()
  })

  /**
   * I2 (final review) scenario 3, name check: the fork dialog's 「同层唯一」
   * validation must not reserve an archived sibling's name — the compact
   * header's entry point never did, and one card cannot have two answers.
   */
  it('I2：已归档同层会话的名字不再占用 fork 命名的唯一性校验', async () => {
    const org: OrgMirrorState = {
      phase: 'ready', revision: 1,
      org: {
        tasks: [], scenes: [],
        placements: [{ sessionId: 'gone', taskId: 't', sceneId: 's', parentSessionId: 'A', sortKey: 0, updatedAt: 0 }],
      },
    }
    const gone = { id: 'gone', displayTitle: '方案A', running: false, blank: false, updatedAt: 0 } as SessionSummary
    render(<CardHeaderActionsEntry {...props({ org, extraSessions: [gone], archivedSessionIds: ['gone'] })} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '方案A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByText(zh['card.fork.duplicate'])).toBeNull()
  })

  it('I2：子会话计数也接 org store 的 placement 覆盖（不再是空 Map 占位）', () => {
    const org: OrgMirrorState = {
      phase: 'ready', revision: 1,
      org: {
        tasks: [], scenes: [],
        placements: [{ sessionId: 'other', taskId: 't', sceneId: 's', parentSessionId: 'A', sortKey: 0, updatedAt: 0 }],
      },
    }
    const other = { id: 'other', displayTitle: 'O', running: false, blank: false, updatedAt: 0 } as SessionSummary
    render(<CardHeaderActionsEntry {...props({ org, extraSessions: [other] })} />)
    // DSH 侧 `other` 完全没有 parentId：只有 placement 记了这条边。
    expect(screen.getByText('子会话 1')).toBeTruthy()
  })

  it('M1：子会话 running 时徽标带 StateDot（聚合状态）', () => {
    const runningChild = { ...CHILD, running: true } as unknown as SessionSummary
    const { container } = render(<CardHeaderActionsEntry {...props({ extraSessions: [runningChild] })} />)
    expect(container.querySelector('[data-state="ongoing"]')).toBeTruthy()
  })

  it('D4：sessionId 自身 blank 为真时（连接件派生 selfForkReady=false），点「创建子分支」只弹提示、不 fork', async () => {
    const forkChild = vi.fn()
    render(<CardHeaderActionsEntry {...props({ selfBlank: true, forkChild })} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(forkChild).not.toHaveBeenCalled()
  })

  it('D4：sessionId 自身 blank 为假时（默认），点「创建子分支」正常打开对话框', async () => {
    render(<CardHeaderActionsEntry {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    expect(await screen.findByLabelText('分支名称')).toBeTruthy()
  })

  it('D4：有效父（A）blank 为真时（连接件派生 parentForkReady=false），点「兄弟分支」只弹提示、不 fork', async () => {
    const forkSibling = vi.fn()
    render(<CardHeaderActionsEntry {...props({ sessionId: 'child' as SessionId, selfBlank: true, forkSibling })} />)
    fireEvent.click(screen.getByRole('button', { name: /兄弟分支/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(forkSibling).not.toHaveBeenCalled()
  })
})

describe('CardHeaderActions', () => {
  it('有子会话时渲染徽标，点击触发 drillTo；子分支/兄弟分支按钮均显示', () => {
    const t = spyT()
    const actions = actionsDouble()
    render(
      <CardHeaderActions
        {...BASE}
        childCount={2}
        childState="ongoing"
        canForkSibling
        actions={actions}
        renameSession={vi.fn()}
        t={t}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /子会话 2/ }))
    expect(actions.drillTo).toHaveBeenCalledWith('A')
    expect(t).toHaveBeenCalledWith('card.children', { n: 2 })
    expect(screen.getByRole('button', { name: /子分支/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /兄弟分支/ })).toBeTruthy()
  })

  it('无子会话时不渲染徽标', () => {
    render(<CardHeaderActions {...BASE} actions={actionsDouble()} renameSession={vi.fn()} t={spyT()} />)
    expect(screen.queryByText(/子会话/)).toBeNull()
  })

  it('「创建子分支」按钮始终显示，点击打开命名对话框，提交调用 forkChild(sessionId, name)（Task 10：命名对话框，非直接调用）', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '子分支A' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(actions.forkChild).toHaveBeenCalledWith('A', '子分支A') })
  })

  it('canForkSibling 为假时不渲染兄弟分支按钮（根层会话无有效父的行为）', () => {
    render(<CardHeaderActions {...BASE} canForkSibling={false} actions={actionsDouble()} renameSession={vi.fn()} t={spyT()} />)
    expect(screen.queryByRole('button', { name: /兄弟分支/ })).toBeNull()
  })

  it('运行中的源会话点「创建子分支」只弹提示，不打开命名对话框、不 fork（spec §4）', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} selfRunning actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.blocked'])
    expect(screen.queryByLabelText('分支名称')).toBeNull()
    expect(actions.forkChild).not.toHaveBeenCalled()
  })

  it('D4：源会话尚无完成回合（selfForkReady=false）时点「创建子分支」只弹提示（未就绪文案，非运行中文案），不打开对话框、不 fork', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} selfForkReady={false} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(screen.queryByLabelText('分支名称')).toBeNull()
    expect(actions.forkChild).not.toHaveBeenCalled()
  })

  it('D4：selfForkReady 未传时默认已就绪（诚实降级，不阻塞），点「创建子分支」正常打开对话框', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    expect(await screen.findByLabelText('分支名称')).toBeTruthy()
  })

  it('D4：有效父尚无完成回合（parentForkReady=false）时点「兄弟分支」只弹提示，不 fork', async () => {
    const actions = actionsDouble()
    render(
      <CardHeaderActions {...BASE} canForkSibling parentForkReady={false} actions={actions} renameSession={vi.fn()} t={spyT()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /兄弟分支/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(actions.forkSibling).not.toHaveBeenCalled()
  })

  it('D4：菜单「⑂ Fork 会话」在源会话未就绪时也只弹提示，不打开对话框、不 fork', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} selfForkReady={false} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '创建子分支' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Fork 会话/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(zh['card.fork.notReady'])
    expect(screen.queryByLabelText('分支名称')).toBeNull()
    expect(actions.forkPeer).not.toHaveBeenCalled()
  })

  it('命名对话框拒绝同层重名（同层唯一校验，spec §4 Fork 对话框）', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} childTitles={['已存在']} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '创建子分支' }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '已存在' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(actions.forkChild).not.toHaveBeenCalled()
  })

  it('「移除」按钮打开确认对话框，确认后调用 removeCard（Task 10：不再直接调用）', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移除' }))
    await vi.waitFor(() => { expect(actions.removeCard).toHaveBeenCalledWith('A', false) })
  })

  it('右键卡片头打开菜单：重命名…／⑂ Fork 会话／移除', async () => {
    render(<CardHeaderActions {...BASE} actions={actionsDouble()} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '创建子分支' }))
    expect(await screen.findByRole('menuitem', { name: '重命名…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Fork 会话/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '移除' })).toBeTruthy()
  })

  it('C1：菜单「⑂ Fork 会话」打开命名对话框，提交调用 forkPeer——不是 forkSibling（平级 fork，语义不同，见 spec §4）', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '创建子分支' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Fork 会话/ }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'E' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(actions.forkPeer).toHaveBeenCalledWith('A', 'E') })
    expect(actions.forkSibling).not.toHaveBeenCalled()
  })

  it('C1：工具栏「兄弟分支」按钮打开命名对话框，提交调用 forkSibling——不是 forkPeer', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} canForkSibling actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: /兄弟分支/ }))
    const input = await screen.findByLabelText('分支名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'D' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(actions.forkSibling).toHaveBeenCalledWith('A', 'D') })
    expect(actions.forkPeer).not.toHaveBeenCalled()
  })

  it('菜单「移除」打开确认对话框，确认后调用 removeCard', async () => {
    const actions = actionsDouble()
    render(<CardHeaderActions {...BASE} actions={actions} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: '创建子分支' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移除' }))
    await vi.waitFor(() => { expect(actions.removeCard).toHaveBeenCalledWith('A', false) })
  })

  it('菜单「重命名…」打开对话框（预填当前标题），提交调用 renameSession(sessionId, name)', async () => {
    const renameSession = vi.fn(async () => undefined)
    render(
      <CardHeaderActions {...BASE} title="登录修复" actions={actionsDouble()} renameSession={renameSession} t={spyT()} />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: '创建子分支' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名…' }))
    const input = screen.getByLabelText('名称') as HTMLInputElement
    expect(input.value).toBe('登录修复')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(renameSession).toHaveBeenCalledWith('A', '新标题') })
  })

  it('重命名对话框拒绝空白名称', async () => {
    const renameSession = vi.fn(async () => undefined)
    render(
      <CardHeaderActions {...BASE} title="登录修复" actions={actionsDouble()} renameSession={renameSession} t={spyT()} />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: '创建子分支' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名…' }))
    const input = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(renameSession).not.toHaveBeenCalled()
  })
})

describe('Matou icon-only card actions', () => {
  it('uses the matching icons with accessible names and hover titles, without toolbar text', () => {
    render(<CardHeaderActions {...BASE} canForkSibling actions={actionsDouble()} renameSession={vi.fn()} t={spyT()} />)
    for (const [label, icon] of [['创建子分支', 'layers-plus'], ['兄弟分支', 'copy-plus'], ['移除', 'circle-minus']]) {
      const button = screen.getByRole('button', { name: label! })
      expect(button.textContent).toBe('')
      expect(button.getAttribute('title')).toBe(label)
      expect(button.querySelector(`svg[data-icon="${icon}"]`)).toBeTruthy()
    }
  })
})

describe('single card more menu', () => {
  it('keeps one trigger with rename, fork, download and remove together', async () => {
    const download = vi.fn(async () => undefined)
    render(<CardHeaderActions {...BASE} actions={{ ...actionsDouble(), downloadSessionLog: download }} renameSession={vi.fn()} t={spyT()} />)
    expect(screen.getAllByRole('button', { name: '更多操作' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    for (const label of [zh['card.menu.rename'], zh['card.menu.forkPeer'], zh['card.menu.download'], zh['card.remove']]) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: '下载会话日志' }))
    expect(download).toHaveBeenCalledExactlyOnceWith('A')
  })
  it('omits download when the optional DSH export service is missing', () => {
    const { container } = render(<CardHeaderActions {...BASE} actions={actionsDouble()} renameSession={vi.fn()} t={spyT()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect(screen.queryByRole('menuitem', { name: '下载会话日志' })).toBeNull()
    expect(container.querySelector('[data-matou-download]')).toBeNull()
  })
  it('delegates download to the existing DSH export controller', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({ name: 'root', children: { 'conversation.session.header.utilities': { kind: 'list', scope: 'session' } } } as never, () => null)
    const download = vi.fn(async () => undefined)
    ctx.provide('sessionLogDownload', { download } as never)
    ctx.provide('sessions', { binding: () => undefined } as never)
    registerHeaderSeats(ctx, orgStoreDouble(), workbenchActionsDouble())
    const entry = ctx.slots.entries('conversation.session.header.utilities').find(item => item.options.id === 'matou-card-actions')!
    const face = (entry.inject as () => CardHeaderActionsInjected)()
    await face.downloadSessionLog!('A')
    expect(download).toHaveBeenCalledExactlyOnceWith('A')
  })
})
