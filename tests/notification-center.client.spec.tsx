// @vitest-environment jsdom
/**
 * S5 Task 7: the notification-center panel (`shell.overlay` occupant).
 *
 * Every test wires REAL `createNotificationStore`/`createPanelStore`
 * instances through a genuine `useSyncExternalStore`-backed selector hook —
 * the same shape the production renderer binds `hooks.notifications`/
 * `hooks.panel` into (`observableHook` in `ui-renderer/client/bindings.tsx`)
 * — rather than static prop doubles, so a click that calls `remove`/`clear`/
 * `setSoundEnabled`/`closePanel` is verified by the component ACTUALLY
 * re-rendering to the new state, not just by a spy having been called. The
 * open→closed transitions this exercises (Esc, click-outside, the two
 * "跃迁" tests) also stand in for the brief's "hook 调用次数恒定" constraint:
 * a hook-count mismatch between the open and closed render paths would throw
 * inside React when the SAME mounted instance crosses that branch, which is
 * exactly what these tests make happen.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  NotificationCenter, taskNameFor, workspaceNameFor,
} from '../src/client/notifications/NotificationCenter.tsx'
import type { NotificationCenterProps } from '../src/client/notifications/NotificationCenter.tsx'
import { createNotificationStore } from '../src/client/notifications/store.ts'
import { createPanelStore } from '../src/client/notifications/panel-store.ts'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { defaultTaskId } from '../src/org/model.ts'
import type { MatouTask } from '../src/org/model.ts'

afterEach(cleanup)

/** Real `zh` dictionary + `{param}` interpolation — same convention as `header-seats.client.spec.tsx`'s `spyT()`. */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

/**
 * Adapt a `getSnapshot`/`subscribe` pair into a real, reactive selector
 * hook — the exact shape `ui-renderer/client/bindings.tsx`'s `observableHook`
 * binds `hooks.X` sources into in production. Using this (instead of a
 * static prop returning a frozen value) is what makes a click that mutates
 * the underlying store show up in the next render without a manual
 * `rerender()` call.
 */
function reactiveHook<T>(source: { getSnapshot: () => T, subscribe: (fn: () => void) => () => void }) {
  return <S,>(selector: (value: T) => S): S => selector(useSyncExternalStore(source.subscribe, source.getSnapshot))
}

type NotificationStoreInstance = ReturnType<typeof createNotificationStore>
type PanelStoreInstance = ReturnType<ReturnType<typeof createPanelStore>['create']>

interface MountOptions {
  notificationsStore?: NotificationStoreInstance
  panelStore?: PanelStoreInstance
  workspaces?: readonly { workspaceId: string, title: string }[]
  tasks?: readonly MatouTask[]
  /** S5 Task 8: the injected `workbench/actions.ts` reveal; `true` = the target still exists. */
  revealSession?: (sessionId: string) => boolean
}

/**
 * Mount `NotificationCenter` plus an "outside" sentinel button in the same
 * document — the `document`-level pointerdown listener needs something
 * genuinely outside the panel's DOM subtree to click.
 */
function mount(options: MountOptions = {}) {
  const notificationsStore = options.notificationsStore ?? createNotificationStore({ now: () => 1_000 })
  const panelStore = options.panelStore ?? createPanelStore().create()
  const workspaces = options.workspaces ?? []
  const tasks = options.tasks ?? []
  const revealSession = vi.fn(options.revealSession ?? (() => true))

  const notificationsSource = {
    getSnapshot: () => notificationsStore.snapshot(),
    subscribe: notificationsStore.subscribe,
  }
  // Static, never-changing snapshots — captured ONCE per `mount()` call so
  // `getSnapshot()` returns the SAME reference every time. `useSyncExternalStore`
  // requires that stability (`Object.is` comparison across renders); a fresh
  // object literal per call would misreport a change on every render.
  const orgSnapshot = { org: { tasks, scenes: [], placements: [] } }
  const workspacesSnapshot = { items: workspaces }
  const props: NotificationCenterProps = {
    t: spyT(),
    usePanel: reactiveHook(panelStore),
    useNotifications: reactiveHook(notificationsSource),
    useOrg: (reactiveHook({
      getSnapshot: () => orgSnapshot,
      subscribe: () => () => {},
    })) as never,
    useWorkspaces: (reactiveHook({
      getSnapshot: () => workspacesSnapshot,
      subscribe: () => () => {},
    })) as never,
    closePanel: () => { panelStore.actions.setOpen(false) },
    removeNotification: notificationsStore.remove,
    clearNotifications: notificationsStore.clear,
    setNotificationSoundEnabled: notificationsStore.setSoundEnabled,
    revealSession,
  } as unknown as NotificationCenterProps

  const utils = render(
    <div>
      <button type="button" data-testid="outside">outside</button>
      <NotificationCenter {...props} />
    </div>,
  )
  return { ...utils, notificationsStore, panelStore, revealSession }
}

/** Push one bare notification, bypassing `derive.ts` entirely (this suite tests the panel, not the derivation layer). */
function pushOne(
  store: NotificationStoreInstance,
  over: { eventId: string, title: string, sessionId?: string, workspaceId?: string | null, taskId?: string | null },
) {
  store.push({
    eventId: over.eventId,
    eventType: 'waiting',
    title: over.title,
    sessionId: over.sessionId ?? over.eventId,
    workspaceId: over.workspaceId ?? null,
    taskId: over.taskId ?? null,
  })
}

describe('NotificationCenter', () => {
  it('关闭时不渲染面板', () => {
    mount()
    expect(screen.queryByRole('region', { name: '通知中心' })).toBeNull()
  })

  it('open 从 false 跃迁到 true 后渲染面板（同一实例，验证开/关两条路径 hook 调用次数一致）', () => {
    const panelStore = createPanelStore().create()
    mount({ panelStore })
    expect(screen.queryByRole('region', { name: '通知中心' })).toBeNull()
    act(() => { panelStore.actions.setOpen(true) })
    expect(screen.getByRole('region', { name: '通知中心' })).toBeTruthy()
  })

  it('头部计数是总数而非未读数（3 条其中 1 条未读，仍显示 3）', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    pushOne(notificationsStore, { eventId: 'e1', title: 'A', sessionId: 's1' })
    pushOne(notificationsStore, { eventId: 'e2', title: 'B', sessionId: 's2' })
    pushOne(notificationsStore, { eventId: 'e3', title: 'C', sessionId: 's3' })
    notificationsStore.markSessionRead('s1')
    notificationsStore.markSessionRead('s2')
    expect(notificationsStore.snapshot().unreadCount).toBe(1)

    mount({ panelStore, notificationsStore })

    expect(screen.getByText('通知 (3)')).toBeTruthy()
  })

  it('空态：显示"暂无通知"，且不显示清空按钮', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    mount({ panelStore })

    expect(screen.getByText('暂无通知')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '清空' })).toBeNull()
  })

  it('条目按时间倒序（存储已排好，组件不再重排）', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    let clock = 1_000
    const notificationsStore = createNotificationStore({ now: () => clock })
    pushOne(notificationsStore, { eventId: 'e1', title: 'A', sessionId: 's1' })
    clock = 2_000
    pushOne(notificationsStore, { eventId: 'e2', title: 'B', sessionId: 's2' })
    clock = 3_000
    pushOne(notificationsStore, { eventId: 'e3', title: 'C', sessionId: 's3' })

    mount({ panelStore, notificationsStore })

    const titles = screen.getAllByRole('article').map(article => article.querySelector('strong')?.textContent)
    expect(titles).toEqual(['C', 'B', 'A'])
  })

  it('单条 ✕ 调用 remove', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    pushOne(notificationsStore, { eventId: 'e1', title: 'A', sessionId: 's1' })
    pushOne(notificationsStore, { eventId: 'e2', title: 'B', sessionId: 's2' })

    mount({ panelStore, notificationsStore })

    const articleA = screen.getAllByRole('article').find(a => a.textContent?.includes('A'))!
    fireEvent.click(within(articleA).getByRole('button', { name: '清除此通知' }))

    expect(notificationsStore.snapshot().notifications.map(n => n.title)).toEqual(['B'])
    expect(screen.queryByText('A')).toBeNull()
  })

  it('清空按钮调用 clear', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    pushOne(notificationsStore, { eventId: 'e1', title: 'A', sessionId: 's1' })
    pushOne(notificationsStore, { eventId: 'e2', title: 'B', sessionId: 's2' })

    mount({ panelStore, notificationsStore })
    fireEvent.click(screen.getByRole('button', { name: '清空' }))

    expect(notificationsStore.snapshot().notifications).toHaveLength(0)
    expect(screen.getByText('暂无通知')).toBeTruthy()
  })

  it('Esc 关闭', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    mount({ panelStore })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(panelStore.getSnapshot().open).toBe(false)
    expect(screen.queryByRole('region', { name: '通知中心' })).toBeNull()
  })

  it('点击面板外关闭', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    mount({ panelStore })

    fireEvent.pointerDown(screen.getByTestId('outside'))

    expect(panelStore.getSnapshot().open).toBe(false)
    expect(screen.queryByRole('region', { name: '通知中心' })).toBeNull()
  })

  it('点击面板内不关闭', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    mount({ panelStore })

    fireEvent.pointerDown(screen.getByRole('region', { name: '通知中心' }))

    expect(panelStore.getSnapshot().open).toBe(true)
    expect(screen.getByRole('region', { name: '通知中心' })).toBeTruthy()
  })

  it('声音开关反映 soundEnabled 并写回 setSoundEnabled', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    mount({ panelStore, notificationsStore })

    const toggle = screen.getByRole('switch', { name: '通知声音' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    expect(notificationsStore.snapshot().soundEnabled).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('面包屑：查不到工作区/事项时显示"未知工作区"/"未知事项"', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    pushOne(notificationsStore, {
      eventId: 'e1', title: 'A', sessionId: 's1', workspaceId: 'missing-workspace', taskId: 'missing-task',
    })

    mount({ panelStore, notificationsStore, workspaces: [], tasks: [] })

    expect(screen.getByText('未知工作区')).toBeTruthy()
    expect(screen.getByText('未知事项')).toBeTruthy()
  })

  it('面包屑：能查到时显示真实工作区/事项名', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    pushOne(notificationsStore, {
      eventId: 'e1', title: 'A', sessionId: 's1', workspaceId: 'w1', taskId: 't1',
    })

    mount({
      panelStore,
      notificationsStore,
      workspaces: [{ workspaceId: 'w1', title: '我的工作区' }],
      tasks: [{
        id: 't1', workspaceId: 'w1', title: '我的事项', status: 'active',
        isPinned: false, sortKey: 0, createdAt: 0, updatedAt: 0,
      }],
    })

    expect(screen.getByText('我的工作区')).toBeTruthy()
    expect(screen.getByText('我的事项')).toBeTruthy()
  })
})

describe('workspaceNameFor / taskNameFor', () => {
  const t = spyT()

  it('workspaceId 为 null 时返回"未知工作区"', () => {
    expect(workspaceNameFor([], null, t)).toBe('未知工作区')
  })

  it('workspaceId 查不到时返回"未知工作区"', () => {
    expect(workspaceNameFor([{ workspaceId: 'w1', title: 'W1' }], 'w2', t)).toBe('未知工作区')
  })

  it('workspaceId 能查到时返回其 title', () => {
    expect(workspaceNameFor([{ workspaceId: 'w1', title: 'W1' }], 'w1', t)).toBe('W1')
  })

  it('taskId 为 null 时返回"未知事项"', () => {
    expect(taskNameFor([], 'w1', null, t)).toBe('未知事项')
  })

  it('taskId 查不到、且不是该工作区的默认事项 id 时返回"未知事项"', () => {
    expect(taskNameFor([], 'w1', 'some-other-task', t)).toBe('未知事项')
  })

  it('taskId 是该工作区未物化的默认事项 id 时返回"默认"', () => {
    expect(taskNameFor([], 'w1', defaultTaskId('w1'), t)).toBe('默认')
  })

  it('taskId 命中已落库的 task 行时返回其 title（即便它恰好等于默认 id）', () => {
    const stored: MatouTask = {
      id: defaultTaskId('w1'), workspaceId: 'w1', title: '重命名过的默认事项',
      status: 'active', isPinned: false, sortKey: 0, createdAt: 0, updatedAt: 0,
    }
    expect(taskNameFor([stored], 'w1', defaultTaskId('w1'), t)).toBe('重命名过的默认事项')
  })
})

/**
 * S5 Task 8: 「点条目跳转」(spec §5 点条目), ported from 码头
 * `TaskSidebar.tsx:159-182`'s `navigateNotification` tail:
 *
 * ```ts
 * if (success) notificationStore.remove(notification.id)
 * setNotificationCenterOpen(false)
 * ```
 *
 * i.e. the panel closes either way, and the row is removed ONLY when the
 * jump landed. The four activations plus the layer reset that decide
 * `success` live in `workbench/actions.ts`'s `revealSession` (covered by
 * `actions.client.spec.ts`); what is only observable HERE is the three-way
 * consequence: reveal → remove → close, or fail → toast → close, row kept.
 *
 * Ruling-S5-8 is why the "workspace is gone" case has no separate test on
 * this side: `revealSession` collapses every unreachable target into one
 * `false`, so this component has exactly one failure path to render.
 */
describe('NotificationCenter — 点条目跳回现场（S5 Task 8）', () => {
  function openWith(over: Partial<MountOptions> = {}) {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    pushOne(notificationsStore, { eventId: 'e1', title: '需要你确认', sessionId: 's1' })
    return mount({ panelStore, notificationsStore, ...over })
  }

  /** The row's clickable body (码头's `.notification-item__body`, a real button). */
  function bodyButton() {
    return within(screen.getByRole('article')).getByRole('button', { name: /打开通知/ })
  }

  it('跳转成功：调用 revealSession、删掉该条、关闭面板', () => {
    const h = openWith()

    fireEvent.click(bodyButton())

    expect(h.revealSession).toHaveBeenCalledWith('s1')
    expect(h.notificationsStore.snapshot().notifications).toHaveLength(0)
    expect(h.panelStore.getSnapshot().open).toBe(false)
    expect(screen.queryByRole('region', { name: '通知中心' })).toBeNull()
  })

  it('目标已不存在：轻提示 + 关闭面板，但条目仍在（码头只在 success 时 remove）', () => {
    const h = openWith({ revealSession: () => false })

    fireEvent.click(bodyButton())

    expect(h.revealSession).toHaveBeenCalledWith('s1')
    expect(screen.getByRole('alert').textContent).toContain('原会话已不存在')
    expect(h.panelStore.getSnapshot().open).toBe(false)
    expect(h.notificationsStore.snapshot().notifications).toHaveLength(1)
  })

  it('条目没有 sessionId：不调用 revealSession，按"已不存在"处理', () => {
    const panelStore = createPanelStore().create()
    panelStore.actions.setOpen(true)
    const notificationsStore = createNotificationStore({ now: () => 1_000 })
    notificationsStore.push({ eventId: 'e1', eventType: 'waiting', title: '孤儿通知' })
    const h = mount({ panelStore, notificationsStore })

    fireEvent.click(bodyButton())

    expect(h.revealSession).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('原会话已不存在')
    expect(h.panelStore.getSnapshot().open).toBe(false)
    expect(h.notificationsStore.snapshot().notifications).toHaveLength(1)
  })
})
