// @vitest-environment jsdom
/**
 * S5 Task 4 wiring spec: DSH's own global session state, diffed on every
 * change, actually lands in the notification store.
 *
 * The pure halves are covered elsewhere — `notification-derive.spec.ts` owns
 * the seven derivation rules, `notification-store.spec.ts` owns the push
 * pipeline. What is only observable HERE is the seam between them: that
 * AppFrame feeds `useSessionPendingInteraction` / `useSessions` (both GLOBAL
 * standard props, never filtered to the active scene) through
 * `deriveNotificationEvents` into `pushNotification`, that its very first run
 * passes `undefined` rather than an empty snapshot (Ruling-S5-6), and that a
 * real store fed by that seam reports the record as read when the session in
 * question is the focused one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { AppFrame } from 'dsh-plugin-matou-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from 'dsh-plugin-matou-layout/src/client/AppFrame.tsx'
import { createNotificationStore } from 'dsh-plugin-matou-layout/src/client/notifications/store.ts'
import type { PendingSnapshot } from 'dsh-plugin-matou-layout/src/client/notifications/derive.ts'
import { EMPTY_ORG_STATE } from 'dsh-plugin-matou-layout/src/org/model.ts'
import { EMPTY_NAV } from 'dsh-plugin-matou-layout/src/client/nav/navigation.ts'
import { createLayoutStore } from 'dsh-plugin-matou-layout/src/client/stores.ts'
import { zh } from 'dsh-plugin-matou-layout/src/client/locales.ts'
import type { MatouKey } from 'dsh-plugin-matou-layout/src/client/locales.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Mutable fixture the render harness reads lazily on every render. */
const fixture = {
  pending: new Map() as PendingSnapshot,
  sessions: [] as { id: string; running: boolean; completed?: boolean }[],
  current: undefined as string | undefined,
  /** 有现场时的工作区列表；空数组等于「没有任何 Matou 现场」。 */
  workspaceItems: [] as readonly { workspaceId: string; title: string; sessionIds: readonly string[] }[],
  org: EMPTY_ORG_STATE as typeof EMPTY_ORG_STATE,
  /** 当前显示的层；`{}` 表示没有显式层级。 */
  level: {} as Record<string, string | null>,
}

/**
 * A real store (bare factory, so it stays safe-by-default and never touches
 * `AudioContext`/`localStorage` — the contract Task 1/2's fix locked down),
 * with a no-op clock so ids stay deterministic across a test.
 */
let store = createNotificationStore({ now: () => 1_000 })

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function mount() {
  const instance = createLayoutStore().create()
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const byId: Record<string, unknown> = {}
    for (const s of fixture.sessions) {
      byId[s.id] = {
        sessionId: s.id, displayTitle: s.id, running: s.running, blank: false,
        ...(s.completed === undefined ? {} : { completed: s.completed }),
      }
    }
    return sel({
      ids: fixture.sessions.map(s => s.id), byId, current: fixture.current, staged: [],
    } as never)
  }) as AppFrameProps['useSessions']
  const t = ((key: MatouKey) => zh[key]) as never
  const element = () => (
    <AppFrame
      useStore={(sel => sel(instance.getSnapshot())) as never}
      actions={instance.actions}
      renderSlot={(() => null) as never}
      useSessions={useSessions}
      useSessionPendingInteraction={(sel => sel(fixture.pending)) as never}
      useSessionLifecycle={(() => undefined) as never}
      useWorkspaces={((sel: (s: WorkspaceSnapshot) => unknown) =>
        sel({ items: fixture.workspaceItems, ready: true, archivedSessionIds: [] } as never)) as never}
      useOrg={((sel: (s: unknown) => unknown) =>
        sel({ phase: 'ready', revision: 0, org: fixture.org })) as never}
      useNav={((sel: (s: unknown) => unknown) => sel(EMPTY_NAV)) as never}
      useLevel={((sel: (s: unknown) => unknown) => sel({ parentBySceneId: fixture.level })) as never}
      // S4 Task 8: inert — this file is about notification derivation, and the
      // forced-recenter path lives in `carousel-reveal.client.spec.tsx`.
      useReveal={((sel: (s: unknown) => unknown) => sel({ bySceneId: {} })) as never}
      useNotifications={((sel: (s: unknown) => unknown) => sel(store.snapshot())) as never}
      pushNotification={store.push}
      addWorkspace={vi.fn()} createTask={vi.fn()} renameTask={vi.fn()} setTaskPinned={vi.fn()}
      deleteTask={vi.fn()} createScene={vi.fn()} renameScene={vi.fn()} deleteScene={vi.fn()}
      newSession={vi.fn()} openSession={vi.fn()} clearSession={vi.fn()} pinSession={vi.fn()}
      unpinSession={vi.fn()} renameSession={vi.fn()} archiveSession={vi.fn()} navigate={vi.fn()}
      drillTo={vi.fn()} returnToParent={vi.fn()} forkChild={vi.fn()} forkSibling={vi.fn()}
      forkPeer={vi.fn()} removeCard={vi.fn()} commitInteractions={(async () => {}) as never}
      SessionProvider={(({ children }: { children?: unknown }) => <>{children}</>) as never}
      t={t}
    />
  )
  const utils = render(element())
  return { rerender: () => { act(() => { utils.rerender(element()) }) } }
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  store = createNotificationStore({ now: () => 1_000 })
  fixture.pending = new Map()
  fixture.sessions = []
  fixture.current = undefined
  fixture.workspaceItems = []
  fixture.org = EMPTY_ORG_STATE
  fixture.level = {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AppFrame → notification store wiring', () => {
  it('produces nothing on the very first render (the caller passes undefined, Ruling-S5-6)', () => {
    // State that WOULD be newsworthy as a transition is already present at
    // mount: without the explicit first-call signal this would explode into
    // notifications the instant the page opens.
    fixture.sessions = [{ id: 's1', running: false, completed: true }]
    fixture.pending = new Map([['s1', { key: 'k1', kind: 'approval', sessionId: 's1' }]])

    mount()

    expect(store.snapshot().notifications).toHaveLength(0)
  })

  it('turns a newly appearing approval into one unread permission record', () => {
    fixture.sessions = [{ id: 's1', running: true }]
    const frame = mount()
    expect(store.snapshot().notifications).toHaveLength(0) // first render is silent

    fixture.pending = new Map([['s1', { key: 'k1', kind: 'approval', sessionId: 's1' }]])
    frame.rerender()

    const snapshot = store.snapshot()
    expect(snapshot.notifications).toHaveLength(1)
    expect(snapshot.notifications[0]).toMatchObject({ eventType: 'permission', sessionId: 's1', read: false })
    expect(snapshot.unreadCount).toBe(1)
  })

  it('marks the record read (and stays silent) when the interaction is on the focused session', () => {
    // Same transition as above, differing only in which session DSH has
    // selected — the store's "focus is read" rule fires only if the wiring
    // actually forwards `current` as `focusedSessionId`.
    fixture.sessions = [{ id: 's1', running: true }]
    fixture.current = 's1'
    const frame = mount()

    fixture.pending = new Map([['s1', { key: 'k1', kind: 'approval', sessionId: 's1' }]])
    frame.rerender()

    const snapshot = store.snapshot()
    expect(snapshot.notifications).toHaveLength(1)
    expect(snapshot.notifications[0]).toMatchObject({ sessionId: 's1', read: true })
    expect(snapshot.unreadCount).toBe(0)
  })
})

/**
 * S3c Task 6: 「聚焦即已读」还缺一半——那个会话得**真的在用户眼前**。
 *
 * 码头的判据是 `active && visible`，化简后就是「是聚焦卡 **且** 它所在页
 * 签就是当前页签」（`HierarchyShell.tsx:1121` 的 `|| isFocused` 让
 * cardVisible 对聚焦卡不起作用，所以跟渲染窗口/横向滚动无关）。本插件此
 * 前只比对了会话 id 相等。
 *
 * 真实的漏判场景只有一个：用户显式下钻到某个会话的子层，而那层是空的
 * （界面上写着「当前画布没有活跃会话」，一张卡都不画）。此时 DSH 的当前会
 * 话仍是上一层那个，它要是这会儿请求审批，用户什么提示都收不到——通知被
 * 当作「你已经看见了」直接标成已读且静音。
 */
describe('AppFrame → 通知：聚焦即已读要求该会话真的在当前层渲染（S3c Task 6）', () => {
  /** 一个页签，两个根会话 A、C；显式下钻到 C 的子层——而 C 没有子会话。 */
  function emptyLayerFixture() {
    fixture.sessions = [{ id: 'A', running: true }, { id: 'C', running: true }]
    fixture.workspaceItems = [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'C'] }]
    fixture.org = {
      tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
      scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
      placements: [
        { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
        { sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
      ],
    }
    fixture.level = { 'sc-1': 'C' }
    fixture.current = 'A'
  }

  it('显式空层里，当前会话的等待输入仍然算未读（不许静默吞掉）', () => {
    emptyLayerFixture()
    const frame = mount()

    fixture.pending = new Map([['A', { key: 'k1', kind: 'approval', sessionId: 'A' }]])
    frame.rerender()

    const snapshot = store.snapshot()
    expect(snapshot.notifications).toHaveLength(1)
    expect(snapshot.notifications[0]).toMatchObject({ sessionId: 'A', read: false })
    expect(snapshot.unreadCount).toBe(1)
  })

  it('同一现场、回到 A 真正所在的那一层时，才算已读（正向对照）', () => {
    emptyLayerFixture()
    fixture.level = { 'sc-1': null } // 显式回到根层——A 就在这一层
    const frame = mount()

    fixture.pending = new Map([['A', { key: 'k1', kind: 'approval', sessionId: 'A' }]])
    frame.rerender()

    const snapshot = store.snapshot()
    expect(snapshot.notifications).toHaveLength(1)
    expect(snapshot.notifications[0]).toMatchObject({ sessionId: 'A', read: true })
    expect(snapshot.unreadCount).toBe(0)
  })
})
