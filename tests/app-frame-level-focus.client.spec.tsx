// @vitest-environment jsdom
/**
 * `AppFrame → levelFocusTargetOf` 这一跳的护栏。
 *
 * 修完「切走页签再切回焦点跑到第一张」之后，我用探针查过：把 `AppFrame` 里
 * `persistedFocusedSessionId: persistedFocus` 改成恒为 `undefined`，全量 1068 条
 * **一条都不响**——纯函数那 7 条测的是函数自己，谁都没测「AppFrame 真的把存档喂给了它」。
 * 这与 S4 审查抓到的 I-1（`revealByScene[sceneId]` 那一跳无人覆盖）是同一类漏洞，
 * 所以照同样的办法钉住：只断言**它最终让哪个会话被打开**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('dsh-plugin-matou-layout/src/client/carousel/Carousel.tsx', () => ({
  Carousel: () => <div data-testid="carousel-stub" />,
}))

const { AppFrame } = await import('dsh-plugin-matou-layout/src/client/AppFrame.tsx')
const { createLayoutStore } = await import('dsh-plugin-matou-layout/src/client/stores.ts')
const { createNotificationStore } = await import('dsh-plugin-matou-layout/src/client/notifications/store.ts')
const { EMPTY_NAV } = await import('dsh-plugin-matou-layout/src/client/nav/navigation.ts')
const { zh } = await import('dsh-plugin-matou-layout/src/client/locales.ts')
const { geometryKey } = await import('dsh-plugin-matou-layout/src/client/carousel/geometry-store.ts')
const { EMPTY_ORG_STATE } = await import('dsh-plugin-matou-layout/src/org/model.ts')
type OrgState = typeof EMPTY_ORG_STATE

/**
 * 根层两张卡 A、B（A 的 `updatedAt` 更大，所以本层第一张是 A），外加 Z 挂在 A 下面
 * ——Z 当「当前会话」，于是根层这一层的焦点必须由本规则挑。
 */
const ORG: OrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [
    { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
    { sessionId: 'Z', taskId: 't-1', sceneId: 'sc-1', sortKey: 3, updatedAt: 1, parentSessionId: 'A' },
  ],
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * 挂载一次，返回 `openSession` 收到的调用。
 * @returns 被打开的会话 id 列表。
 */
function mount(): string[] {
  const layout = createLayoutStore().create()
  const notifications = createNotificationStore({ now: () => 1_000 })
  const opened: string[] = []
  const byId: Record<string, unknown> = {
    A: { sessionId: 'A', displayTitle: 'A', running: false, blank: false, updatedAt: 20 },
    B: { sessionId: 'B', displayTitle: 'B', running: false, blank: false, updatedAt: 10 },
    Z: { sessionId: 'Z', displayTitle: 'Z', running: false, blank: false, updatedAt: 30 },
  }
  render(
    <AppFrame
      useStore={(sel => sel(layout.getSnapshot())) as never}
      actions={layout.actions}
      renderSlot={(() => null) as never}
      useSessions={((sel: (s: unknown) => unknown) =>
        sel({ ids: ['A', 'B', 'Z'], byId, current: 'Z', staged: [] })) as never}
      useSessionPendingInteraction={(sel => sel(new Map())) as never}
      useSessionLifecycle={(() => undefined) as never}
      useWorkspaces={((sel: (s: unknown) => unknown) =>
        sel({ items: [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B', 'Z'] }], ready: true, archivedSessionIds: [] })) as never}
      useOrg={((sel: (s: unknown) => unknown) => sel({ phase: 'ready', revision: 0, org: ORG })) as never}
      useNav={((sel: (s: unknown) => unknown) => sel(EMPTY_NAV)) as never}
      // 显式站在根层（三态里的 `null`），当前会话 Z 却在 A 的子层——正是本规则的适用条件。
      useLevel={((sel: (s: unknown) => unknown) => sel({ parentBySceneId: { 'sc-1': null } })) as never}
      useReveal={((sel: (s: unknown) => unknown) => sel({ bySceneId: {} })) as never}
      useNotifications={((sel: (s: unknown) => unknown) => sel(notifications.snapshot())) as never}
      useDag={((sel: (s: unknown) => unknown) => sel({ open: false })) as never}
      pushNotification={notifications.push}
      addWorkspace={vi.fn()} createTask={vi.fn()} renameTask={vi.fn()} setTaskPinned={vi.fn()}
      deleteTask={vi.fn()} createScene={vi.fn()} renameScene={vi.fn()} deleteScene={vi.fn()}
      newSession={vi.fn()} openSession={((id: string) => { opened.push(id) }) as never}
      clearSession={vi.fn()} pinSession={vi.fn()}
      unpinSession={vi.fn()} renameSession={vi.fn()} archiveSession={vi.fn()} navigate={vi.fn()}
      drillTo={vi.fn()} returnToParent={vi.fn()} forkChild={vi.fn()} forkSibling={vi.fn()}
      forkPeer={vi.fn()} removeCard={vi.fn()} commitInteractions={(async () => {}) as never} openDag={vi.fn()} closeDag={vi.fn()}
      SessionProvider={(({ children }: { children?: unknown }) => <>{children}</>) as never}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />,
  )
  return opened
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('AppFrame 把每一层的存档焦点喂给挑选规则', () => {
  it('存档记着 B 时，回到这一层聚焦 B，而不是本层第一张 A', () => {
    localStorage.setItem(geometryKey('sc-1', undefined), JSON.stringify({ scrollLeft: 0, focusedSessionId: 'B' }))
    expect(mount()).toContain('B')
  })

  /** 反例：没有存档时必须还是第一张——否则上面那条可能只是「总是挑 B」。 */
  it('没有存档时退回本层第一张 A', () => {
    expect(mount()).toContain('A')
  })

  /** 反例：存档指向一个已经不在本层的会话时，不能照着它开。 */
  it('存档指向已不在本层的会话时退回第一张', () => {
    localStorage.setItem(geometryKey('sc-1', undefined), JSON.stringify({ scrollLeft: 0, focusedSessionId: 'gone' }))
    const opened = mount()
    expect(opened).toContain('A')
    expect(opened).not.toContain('gone')
  })
})
