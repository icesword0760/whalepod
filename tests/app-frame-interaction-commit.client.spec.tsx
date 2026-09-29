// @vitest-environment jsdom
/**
 * `AppFrame → interactionCommits` 这一跳的护栏（spec §7.1 第 5 条「正在操作的卡不跳位」）。
 *
 * 纯函数那 8 条测的是判定本身；这里只钉「AppFrame 真的把 live 值、已提交值和当前
 * 焦点凑对喂了进去，并把结果写回落位文档」。与 `app-frame-reveal.client.spec.tsx`
 * 同一套办法：把边界替身化，只断言它最终发出了什么。
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
 * 挂载一次，返回 `commitInteractions` 收到的调用（扁平化成一个数组）。
 * @param placements - 覆盖默认落位（用来给某些会话预置已提交排序键）。
 * @returns 发出的排序键提交。
 */
function mount(placements: OrgState['placements'] = ORG.placements): { sessionId: string, at: number }[] {
  const layout = createLayoutStore().create()
  const notifications = createNotificationStore({ now: () => 1_000 })
  const commits: { sessionId: string, at: number }[] = []
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
      useOrg={((sel: (s: unknown) => unknown) => sel({ phase: 'ready', revision: 0, org: { ...ORG, placements } })) as never}
      useNav={((sel: (s: unknown) => unknown) => sel(EMPTY_NAV)) as never}
      // 显式站在根层（三态里的 `null`），当前会话 Z 却在 A 的子层——正是本规则的适用条件。
      useLevel={((sel: (s: unknown) => unknown) => sel({ parentBySceneId: { 'sc-1': null } })) as never}
      useReveal={((sel: (s: unknown) => unknown) => sel({ bySceneId: {} })) as never}
      useNotifications={((sel: (s: unknown) => unknown) => sel(notifications.snapshot())) as never}
      useDag={((sel: (s: unknown) => unknown) => sel({ open: false })) as never}
      pushNotification={notifications.push}
      addWorkspace={vi.fn()} createTask={vi.fn()} renameTask={vi.fn()} setTaskPinned={vi.fn()}
      deleteTask={vi.fn()} createScene={vi.fn()} renameScene={vi.fn()} deleteScene={vi.fn()}
      newSession={vi.fn()} openSession={vi.fn()}
      clearSession={vi.fn()} pinSession={vi.fn()}
      unpinSession={vi.fn()} renameSession={vi.fn()} archiveSession={vi.fn()} navigate={vi.fn()}
      drillTo={vi.fn()} returnToParent={vi.fn()} forkChild={vi.fn()} forkSibling={vi.fn()}
      forkPeer={vi.fn()} removeCard={vi.fn()} commitInteractions={(async (list: { sessionId: string, at: number }[]) => { commits.push(...list) }) as never} openDag={vi.fn()} closeDag={vi.fn()}
      SessionProvider={(({ children }: { children?: unknown }) => <>{children}</>) as never}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />,
  )
  return commits
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub); localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('AppFrame 把排序键的提交判定接了出去', () => {
  /** 全部没有已提交值时，每一张都要当场钉一个下来（含正被聚焦的 Z）。 */
  it('落位还没有排序键时，本页签每张卡都提交一次 live 值', () => {
    const commits = mount()
    expect(commits).toEqual(expect.arrayContaining([
      { sessionId: 'A', at: 20 },
      { sessionId: 'B', at: 10 },
      { sessionId: 'Z', at: 30 },
    ]))
  })

  /**
   * 缺陷本体：**正被聚焦的那张（Z）即使 live 值已经跑在前面，也不许提交**。
   * 若这一跳没把 `current` 喂进去，Z 会跟着一起被提交——那正是走查里
   * 「一发消息卡片当场窜到第一位」的样子。
   */
  it('已有排序键时，聚焦中的那张不提交，其余照常', () => {
    const commits = mount(ORG.placements.map(p => ({ ...p, interactionAt: 1 })))
    expect(commits.map(c => c.sessionId)).toEqual(['A', 'B'])
    expect(commits.find(c => c.sessionId === 'Z')).toBeUndefined()
  })

  /** 反例：全都已是最新时一个字都不写，否则就是每次渲染都写一次存储。 */
  it('已提交值已经最新时不发任何提交', () => {
    const at: Record<string, number> = { A: 20, B: 10, Z: 30 }
    expect(mount(ORG.placements.map(p => ({ ...p, interactionAt: at[p.sessionId] })))).toEqual([])
  })
})
