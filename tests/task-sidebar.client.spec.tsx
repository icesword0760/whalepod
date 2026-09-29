// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { EMPTY_NAV, resolveActive } from '../src/client/nav/navigation.ts'
import { createNotificationStore } from '../src/client/notifications/store.ts'
import type { MatouWorkspaceOrgView } from '../src/client/org/derive.ts'
import { TaskSidebar } from '../src/client/workbench/TaskSidebar.tsx'
import type { WorkbenchActions } from '../src/client/workbench/actions.ts'

const t = (key: MatouKey, params?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

const VIEW: readonly MatouWorkspaceOrgView[] = [{
  workspaceId: 'ws', title: '项目甲', ordinal: 1,
  tasks: [
    { id: 'task:default:ws', workspaceId: 'ws', title: '默认', status: 'planned', isPinned: false, virtual: true, ordinal: 1,
      scenes: [{ id: 'scene:default:task:default:ws', taskId: 'task:default:ws', name: '默认', titlePinned: false, virtual: true, ordinal: 1,
        sessions: [{ sessionId: 's-1', ordinal: 1 }, { sessionId: 's-2', ordinal: 2 }] }] },
    { id: 't-1', workspaceId: 'ws', title: '修 bug', status: 'planned', isPinned: false, virtual: false, ordinal: 2, scenes: [] },
  ],
}]

function actionsDouble(): WorkbenchActions {
  return {
    addWorkspace: vi.fn(async () => undefined), createTask: vi.fn(async () => 'new'), renameTask: vi.fn(async () => undefined), setTaskPinned: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined), createScene: vi.fn(async () => 'sc'), renameScene: vi.fn(async () => undefined),
    deleteScene: vi.fn(async () => undefined), newSession: vi.fn(async () => undefined), openSession: vi.fn(),
    clearSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), renameSession: vi.fn(async () => undefined), archiveSession: vi.fn(async () => undefined),
    navigate: vi.fn(),
  }
}

afterEach(cleanup)

describe('TaskSidebar', () => {
  it('renders the workspace group with its tasks and the session count slot', () => {
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actionsDouble()} />)
    expect(screen.getByText('项目甲')).toBeTruthy()
    expect(screen.getByText('默认')).toBeTruthy()
    expect(screen.getByText('修 bug')).toBeTruthy()
    expect(screen.getByText('2 个会话')).toBeTruthy()
  })

  it('offers deletion for Default and requires confirmation; cancel preserves sessions', async () => {
    const actions = actionsDouble()
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions} />)
    fireEvent.contextMenu(screen.getByText('默认'))
    fireEvent.click(await screen.findByText('删除…'))
    expect(screen.getByText(/归档其中的 2 个会话/)).toBeTruthy()
    expect(actions.deleteTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('取消'))
    expect(actions.deleteTask).not.toHaveBeenCalled()
    fireEvent.contextMenu(screen.getByText('默认'))
    fireEvent.click(await screen.findByText('删除…'))
    fireEvent.click(screen.getByText('确认删除'))
    await vi.waitFor(() => expect(actions.deleteTask).toHaveBeenCalledWith(expect.objectContaining({ virtual: true })))
  })

  it('clicking a task navigates to it', () => {
    const actions = actionsDouble()
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions} />)
    fireEvent.click(screen.getByText('修 bug'))
    expect(actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1' })
  })

  it('creates a task with the next free numbered name', () => {
    const actions = actionsDouble()
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions} />)
    fireEvent.click(screen.getByLabelText('新建事项'))
    expect(actions.createTask).toHaveBeenCalledWith('ws', '新事项')
  })

  /**
   * 空状态的提示必须指向**界面上真实存在**的那颗按钮。
   *
   * 2026-09-14 把侧栏顶部的「新会话」换成「新建工作区」时，区块头上那颗小「＋」
   * 一并去掉了，而提示文案还写着「点右上角 ＋」——第一次打开应用的用户按提示
   * 找不到任何 ＋。文案里点名的控件和实际渲染出来的控件脱节，没有任何编译或
   * 类型检查会发现。
   */
  it('shows the empty state when there is no workspace, and its hint names a control that exists', () => {
    const onAddWorkspace = vi.fn()
    render(
      <TaskSidebar
        view={[]} active={{}} degraded={false} t={t}
        actions={actionsDouble()} onAddWorkspace={onAddWorkspace}
      />,
    )
    expect(screen.getByText('还没有工作区')).toBeTruthy()
    // 提示里点名的控件，必须真的在这一屏上，并且点得动。
    expect(zh['workspace.empty.hint']).toContain(zh['workspace.new'])
    const button = screen.getByRole('button', { name: zh['workspace.new'] })
    fireEvent.click(button)
    expect(onAddWorkspace).toHaveBeenCalled()
    // 不得再引用任何已经不存在的入口。
    expect(zh['workspace.empty.hint']).not.toContain('右上角')
  })

  it('rename dialog validates duplicates before submitting', async () => {
    const actions = actionsDouble()
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions} />)
    fireEvent.contextMenu(screen.getByText('修 bug'))
    fireEvent.click(await screen.findByText('重命名…'))
    const input = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: '默认' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(actions.renameTask).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '方案' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => { expect(actions.renameTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't-1' }), '方案') })
  })

  describe('S5 Task 5 — 事项行未读徽标', () => {
    const DEFAULT_TASK_ID = 'task:default:ws'

    /** Push one unread `permission` notification, `taskId` defaulting to the fixture's default task. */
    function pushUnread(store: ReturnType<typeof createNotificationStore>, sessionId: string, taskId = DEFAULT_TASK_ID): void {
      store.push({ eventId: sessionId, eventType: 'permission', title: 'Claude Code', taskId, sessionId })
    }

    function renderWith(store: ReturnType<typeof createNotificationStore>) {
      return render(<TaskSidebar
        view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actionsDouble()}
        notifications={store.snapshot().notifications}
      />)
    }

    it('shows the unread badge, hides the "…" button, while the task has unread — the OTHER task keeps its own', () => {
      const store = createNotificationStore({ now: () => 1_000 })
      pushUnread(store, 's-1')
      const { container } = renderWith(store)
      const row = container.querySelector(`[data-task-id="${DEFAULT_TASK_ID}"]`) as HTMLElement
      expect(within(row).getByText('1')).toBeTruthy()
      // The badge takes over the row's one right-hand text slot — the
      // session count it otherwise shows must not also render.
      expect(within(row).queryByText('2 个会话')).toBeNull()
      expect(within(row).queryByLabelText('更多操作')).toBeNull()
      // The OTHER task ('修 bug', no unread) keeps its own "…" button —
      // hiding is per-row, not global.
      expect(screen.getAllByLabelText('更多操作')).toHaveLength(1)
    })

    /**
     * Fix round 1 (review, Important): `menuOpen` is a `useState` that
     * outlives the "…" button's own render gate — `TaskRow` mounts once per
     * `task.id`, so unread clearing (Task 1's "focus reads it" rule, the very
     * next render after the user opens that task's one unread session) does
     * NOT remount it. An unconditional `setMenuOpen(true)` on right-click
     * would arm this silently while the row is unread (no visible menu, since
     * it isn't rendered yet) and then pop the dropdown open with no click the
     * instant the row's unread count reaches 0.
     */
    it('right-clicking an unread row does not silently arm the "…" menu, which would otherwise pop open once unread clears', () => {
      const store = createNotificationStore({ now: () => 1_000 })
      pushUnread(store, 's-1')
      const { container, rerender } = renderWith(store)
      const row = container.querySelector(`[data-task-id="${DEFAULT_TASK_ID}"]`) as HTMLElement
      fireEvent.contextMenu(row)
      expect(screen.queryByRole('menu')).toBeNull() // still hidden — unread suppresses the menu, as before

      // The row's unread clears with no further user click.
      rerender(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actionsDouble()}
        notifications={[]} />)
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('caps the unread badge display at "99+" past 99 unread', () => {
      const store = createNotificationStore({ now: () => 1_000 })
      for (let index = 0; index < 130; index += 1) pushUnread(store, `s-${index}`)
      renderWith(store)
      expect(screen.getByText('99+')).toBeTruthy()
    })

    it('never lights the workspace/group header itself — spec §5 Ruling, matches 码头 source (regression guard)', () => {
      const store = createNotificationStore({ now: () => 1_000 })
      pushUnread(store, 's-1')
      renderWith(store)
      // 守的是「未读数不许出现在工作区头上」这件事本身，而不是子元素个数——
      // 原来的写法是数 children（折叠箭头 + 名称 = 2），2026-09-14 给工作区行补上
      // 码头那颗文件夹图标时它就红了，而规则一字未改。按个数守会把每一次合法的
      // 结构调整都变成假警报，真正要拦的东西反而没写出来。
      const groupToggle = screen.getByText('项目甲').closest('button')!
      const groupHeader = groupToggle.parentElement!
      expect(within(groupHeader).queryByText('1')).toBeNull()
      expect(groupHeader.textContent).not.toMatch(/\d/)
    })
  })
})

/**
 * S5 Task 8: 「点事项行或工作区头 = 整个工作区已读」(spec §5 已读规则).
 *
 * Ported from 码头 `hierarchy/TaskSidebar.tsx:222-231, 267-272`, where
 * `notificationStore.markWorkspaceRead(workspace.id)` is the FIRST statement
 * of both the `workspace-group__toggle` click and the task row's own click —
 * and, notably, is absent from that row's `onKeyDown` (Enter/Space), which
 * only calls `activateTask`. Two details this pins down:
 *
 * - the task row marks the whole WORKSPACE read, not just its own task (the
 *   store has no `markTaskRead`, and 码头 never asks for one);
 * - the keyboard path deliberately does NOT mark read — a faithful port,
 *   even though it reads like an oversight upstream.
 */
describe('TaskSidebar — 点工作区头 / 事项行标记整个工作区已读（S5 Task 8）', () => {
  function renderWith(markWorkspaceRead: (workspaceId: string) => void) {
    const actions = actionsDouble()
    const utils = render(<TaskSidebar
      view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions}
      markWorkspaceRead={markWorkspaceRead}
    />)
    return { ...utils, actions }
  }

  it('点工作区头：整个工作区标记已读', () => {
    const markWorkspaceRead = vi.fn()
    renderWith(markWorkspaceRead)
    fireEvent.click(screen.getByText('项目甲'))
    expect(markWorkspaceRead).toHaveBeenCalledWith('ws')
  })

  it('点事项行：标记的是所属工作区（不是该事项），并照旧导航', () => {
    const markWorkspaceRead = vi.fn()
    const h = renderWith(markWorkspaceRead)
    fireEvent.click(screen.getByText('修 bug'))
    expect(markWorkspaceRead).toHaveBeenCalledWith('ws')
    expect(h.actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1' })
  })

  it('事项行按 Enter：只激活，不标记已读（码头 onKeyDown 没有这一句）', () => {
    const markWorkspaceRead = vi.fn()
    const h = renderWith(markWorkspaceRead)
    fireEvent.keyDown(screen.getByText('修 bug').closest('[data-task-id]') as HTMLElement, { key: 'Enter' })
    expect(h.actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1' })
    expect(markWorkspaceRead).not.toHaveBeenCalled()
  })

  it('未接线 markWorkspaceRead 时点事项行仍照旧导航（S5 之前的调用方不受影响）', () => {
    const actions = actionsDouble()
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions} />)
    fireEvent.click(screen.getByText('修 bug'))
    expect(actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1' })
  })
})

describe('task-row DAG entry', () => {
  it('selects the clicked task before opening DAG without marking the workspace read', () => {
    const actions = { ...actionsDouble(), openDag: vi.fn() }
    const markRead = vi.fn()
    render(<TaskSidebar view={VIEW} active={resolveActive(VIEW, EMPTY_NAV)} degraded={false} t={t} actions={actions} markWorkspaceRead={markRead} />)
    const dag = screen.getAllByRole('button', { name: '会话 DAG' })[1]!
    expect(dag.querySelector('svg[data-icon="graph-ring"]')).toBeTruthy()
    fireEvent.click(dag)
    expect(actions.navigate).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws', taskId: 't-1' })
    expect(actions.openDag).toHaveBeenCalledOnce()
    expect(actions.navigate.mock.invocationCallOrder[0]).toBeLessThan(actions.openDag.mock.invocationCallOrder[0]!)
    expect(markRead).not.toHaveBeenCalled()
  })
})
