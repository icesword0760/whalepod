// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createDagPanelStore } from '../src/client/dag/panel-store.ts'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { createNotificationStore } from '../src/client/notifications/store.ts'
import type { MatouTaskView } from '../src/client/org/derive.ts'
import { SceneTabBar, humanizeSceneActionError } from '../src/client/workbench/SceneTabBar.tsx'
import { createWorkbenchActions } from '../src/client/workbench/actions.ts'
import type { WorkbenchActions } from '../src/client/workbench/actions.ts'

const t = (key: MatouKey, params?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

const TASK: MatouTaskView = {
  id: 't-1', workspaceId: 'ws', title: 'T', status: 'planned', isPinned: false, virtual: false, ordinal: 1,
  scenes: [
    { id: 'sc-a', taskId: 't-1', name: '排查', titlePinned: false, virtual: false, ordinal: 1, sessions: [{ sessionId: 's-1', ordinal: 1 }] },
    { id: 'sc-b', taskId: 't-1', name: '验证', titlePinned: false, virtual: false, ordinal: 2, sessions: [] },
  ],
}

function actionsDouble(): WorkbenchActions {
  return {
    addWorkspace: vi.fn(async () => undefined), createTask: vi.fn(async () => 'new'), renameTask: vi.fn(async () => undefined), setTaskPinned: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined), createScene: vi.fn(async () => 'sc'), renameScene: vi.fn(async () => undefined),
    deleteScene: vi.fn(async () => undefined), newSession: vi.fn(async () => undefined), openSession: vi.fn(),
    clearSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), renameSession: vi.fn(async () => undefined), archiveSession: vi.fn(async () => undefined),
    navigate: vi.fn(), openDag: vi.fn(), closeDag: vi.fn(),
    drillTo: vi.fn(), returnToParent: vi.fn(),
    forkChild: vi.fn(async () => undefined), forkSibling: vi.fn(async () => undefined), forkPeer: vi.fn(async () => undefined),
    removeCard: vi.fn(async () => undefined),
  }
}

afterEach(cleanup)

describe('SceneTabBar', () => {
  it('renders tabs, switches on click, and creates a numbered tab', () => {
    const actions = actionsDouble()
    render(<SceneTabBar task={TASK} activeSceneId="sc-a" t={t} actions={actions} />)
    expect(screen.getByRole('tab', { name: /排查/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: /验证/ }))
    expect(actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1', sceneId: 'sc-b' })
    fireEvent.click(screen.getByLabelText('新建页签'))
    expect(actions.createScene).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't-1' }), '新页签')
  })

  it('closes an empty tab silently and confirms for a tab with sessions', async () => {
    const actions = actionsDouble()
    render(<SceneTabBar task={TASK} activeSceneId="sc-a" t={t} actions={actions} />)
    const closes = screen.getAllByLabelText('关闭页签')
    fireEvent.click(closes[1]!)
    expect(actions.deleteScene).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 'sc-b' }))
    fireEvent.click(closes[0]!)
    expect(await screen.findByText(/1 个会话不会被删除/)).toBeTruthy()
    fireEvent.click(screen.getByText('确认关闭'))
    await vi.waitFor(() => { expect(actions.deleteScene).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 'sc-a' })) })
  })

  it('页签条右侧含「会话 DAG」与「新会话」按钮', () => {
    const actions = { createScene: vi.fn(), openDag: vi.fn(), newSession: vi.fn() } as never
    render(<SceneTabBar task={TASK} activeSceneId="sc-a" t={t} actions={actions} />)
    expect(screen.getByRole('button', { name: /会话 DAG/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新会话/ })).toBeTruthy()
  })

  /**
   * S4 Task 7 的接线证据，端到端而非 mock 断言：真的 `createWorkbenchActions`
   * + 真的 `createDagPanelStore` 实例，点按钮之后读 store 的快照。其余 deps
   * 用 `as never` 是诚实的——`openDag` 只碰 `deps.dag`，喂真的 sessions /
   * workspaces / nav / level 只会让这条断言的对象变模糊。
   */
  it('点「会话 DAG」经真实 actions 把 DAG 面板 store 翻成 open: true', () => {
    const dag = createDagPanelStore().create()
    const real = createWorkbenchActions({
      sessions: undefined as never, workspaces: undefined as never, uiWorkspace: undefined as never,
      getOrg: () => undefined, nav: undefined as never, level: undefined as never,
      pendingInteractions: undefined as never, dag,
    })
    const actions = { ...actionsDouble(), openDag: real.openDag, closeDag: real.closeDag }
    render(<SceneTabBar task={TASK} activeSceneId="sc-a" t={t} actions={actions} />)
    expect(dag.getSnapshot().open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /会话 DAG/ }))
    expect(dag.getSnapshot().open).toBe(true)
  })

  it('「新会话」按钮把 currentParentId 转发给 newSession（下钻层新会话挂当前层父，spec §4）', () => {
    const actions = actionsDouble()
    render(<SceneTabBar task={TASK} activeSceneId="sc-a" currentParentId="s-1" t={t} actions={actions} />)
    fireEvent.click(screen.getByRole('button', { name: /新会话/ }))
    expect(actions.newSession).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 'sc-a' }), 's-1')
  })
})

/**
 * S5 Task 8: 「切页签不清任何东西」(spec §5 已读规则) — a REVERSE assertion.
 *
 * Verified against 码头 source: `hierarchy/SceneTabBar.tsx` touches the
 * notification store exactly once, in `sceneHasUnread` (line 124, a READ for
 * the tab's red dot); its tab `onClick` calls no store method at all. So the
 * rule is "nothing happens". Be honest about what each half of this test can
 * prove: the store assertions are STRUCTURAL — `SceneTabBar` is never handed
 * a store, so "the numbers are untouched" holds by construction, and would
 * keep holding even if a future edit wired in a read-clearing prop this test
 * does not pass. The half with teeth is the actions sweep: the bar can only
 * reach the world through `actions`, so any write it grows beyond `navigate`
 * turns this red. The store half stays as the statement of intent, naming
 * what must remain true.
 */
describe('SceneTabBar — 切页签不清任何东西（S5 Task 8 反向断言）', () => {
  it('切到另一个页签后未读数不变，红点仍在，且除 navigate 外没有其他动作被调用', () => {
    const store = createNotificationStore({ now: () => 1_000 })
    store.push({ eventId: 'e1', eventType: 'permission', title: 'Claude Code', sessionId: 's-1', taskId: 't-1', sceneId: 'sc-a' })
    const before = store.snapshot()
    expect(before.unreadCount).toBe(1)

    const actions = actionsDouble()
    render(<SceneTabBar
      task={TASK} activeSceneId="sc-a" t={t} actions={actions}
      notifications={before.notifications}
    />)
    expect(screen.getByTestId('scene-unread-sc-a')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /验证/ }))

    const after = store.snapshot()
    expect(after.unreadCount).toBe(1)
    expect(after.notifications).toHaveLength(1)
    expect(after.notifications[0]?.read).toBe(false)
    // The tab bar's only legitimate write on a tab click.
    expect(actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1', sceneId: 'sc-b' })
    for (const [name, fn] of Object.entries(actions)) {
      if (name === 'navigate') continue
      expect(fn).not.toHaveBeenCalled()
    }
    // The dot is a pure projection of the (unchanged) list, so it survives.
    expect(screen.getByTestId('scene-unread-sc-a')).toBeTruthy()
  })
})

/**
 * 2026-09-14 桌面端走查：一屏中文界面上，页签栏挂着一句
 * `matou-layout: organization changed elsewhere; please retry`——裸英文内部错误，
 * 而且落位文档早已重新同步（客户端与磁盘同为 revision 91），它还在让用户「retry」，
 * 也没有任何关掉它的地方。`card-actions.tsx` 的移除/分叉路径在首轮走查就补过同款
 * 翻译，页签栏这条漏掉了。
 */
describe('SceneTabBar — 失败提示', () => {
  it('把落位冲突翻译成中文，不把内部错误原文摆给用户', () => {
    const text = humanizeSceneActionError(
      new Error('matou-layout: organization changed elsewhere; please retry'), t)
    expect(text).toBe(zh['scene.action.conflict'])
    expect(text).not.toMatch(/matou-layout:|changed elsewhere/)
  })

  it('其它失败落到通用文案，同样不漏内部错误原文', () => {
    const text = humanizeSceneActionError(new Error('matou-layout: whatever went wrong'), t)
    expect(text).toBe(zh['scene.action.error'])
    expect(text).not.toMatch(/matou-layout:/)
  })

  it('提示条显示后自动消失，不会一直挂在页签栏上', async () => {
    vi.useFakeTimers()
    try {
      const actions = actionsDouble()
      actions.createScene = vi.fn(async () => {
        throw new Error('matou-layout: organization changed elsewhere; please retry')
      })
      render(<SceneTabBar task={TASK} activeSceneId="sc-a" t={t} actions={actions} />)
      fireEvent.click(screen.getByRole('button', { name: zh['scene.add'] }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('alert').textContent).toBe(zh['scene.action.conflict'])

      await act(async () => { vi.advanceTimersByTime(6000) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
