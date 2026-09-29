// @vitest-environment jsdom
/**
 * S4 审查 I-1：`AppFrame → Carousel` 这一跳此前**完全没有测试**。
 *
 * 审查用一个探针证明了这件事：把 `AppFrame.tsx` 里
 * `revealByScene[sceneId]` 改成恒为 `undefined`，全量 818 条**一条都不响**。
 * 原因是 `app-frame.client.spec.tsx` 把 `useReveal` 桩成永远返回空表，那行
 * 索引从未被求值过。
 *
 * 这一跳是 Task 8 唯一的用户可见产出（spec §7.3 ⑥「点已经聚焦的那张卡，
 * 轮播仍然重新居中」，也是 S5 那个「点通知中心里指向当前会话的条目没反应」
 * 的老坑）。链上另外四段都各有护栏——store、`revealSession`、控制器、
 * `Carousel → 控制器`——唯独中间这段没有。
 *
 * jsdom 里没有布局，滚动观测不到，所以这里不去看"滚没滚"，而是把 `Carousel`
 * 换成一个只记录收到什么的替身：真正要钉住的语义就是**按当前页签取键**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

/** 捕获 `Carousel` 每次渲染收到的 props（模块替身，必须在 import AppFrame 之前声明）。 */
const carouselProps: Record<string, unknown>[] = []
vi.mock('dsh-plugin-matou-layout/src/client/carousel/Carousel.tsx', () => ({
  Carousel: (props: Record<string, unknown>) => {
    carouselProps.push(props)
    return <div data-testid="carousel-stub" />
  },
}))

const { AppFrame } = await import('dsh-plugin-matou-layout/src/client/AppFrame.tsx')
const { createLayoutStore } = await import('dsh-plugin-matou-layout/src/client/stores.ts')
const { createNotificationStore } = await import('dsh-plugin-matou-layout/src/client/notifications/store.ts')
const { EMPTY_NAV } = await import('dsh-plugin-matou-layout/src/client/nav/navigation.ts')
const { zh } = await import('dsh-plugin-matou-layout/src/client/locales.ts')
const { EMPTY_ORG_STATE } = await import('dsh-plugin-matou-layout/src/org/model.ts')
type OrgState = typeof EMPTY_ORG_STATE

/** 一个工作区、一个页签、两个根会话 —— 够 `active.scene` 解析出来。 */
const ORG: OrgState = {
  tasks: [{ id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
  placements: [
    { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
  ],
}

const fixture = { reveal: {} as Record<string, { sessionId: string, seq: number }> }

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function mount() {
  const layout = createLayoutStore().create()
  const notifications = createNotificationStore({ now: () => 1_000 })
  const byId: Record<string, unknown> = {
    A: { sessionId: 'A', displayTitle: 'A', running: false, blank: false, updatedAt: 20 },
    B: { sessionId: 'B', displayTitle: 'B', running: false, blank: false, updatedAt: 10 },
  }
  render(
    <AppFrame
      useStore={(sel => sel(layout.getSnapshot())) as never}
      actions={layout.actions}
      renderSlot={(() => null) as never}
      useSessions={((sel: (s: unknown) => unknown) =>
        sel({ ids: ['A', 'B'], byId, current: 'A', staged: [] })) as never}
      useSessionPendingInteraction={(sel => sel(new Map())) as never}
      useSessionLifecycle={(() => undefined) as never}
      useWorkspaces={((sel: (s: unknown) => unknown) =>
        sel({ items: [{ workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B'] }], ready: true, archivedSessionIds: [] })) as never}
      useOrg={((sel: (s: unknown) => unknown) => sel({ phase: 'ready', revision: 0, org: ORG })) as never}
      useNav={((sel: (s: unknown) => unknown) => sel(EMPTY_NAV)) as never}
      useLevel={((sel: (s: unknown) => unknown) => sel({ parentBySceneId: {} })) as never}
      useReveal={((sel: (s: unknown) => unknown) => sel({ bySceneId: fixture.reveal })) as never}
      useNotifications={((sel: (s: unknown) => unknown) => sel(notifications.snapshot())) as never}
      useDag={((sel: (s: unknown) => unknown) => sel({ open: false })) as never}
      pushNotification={notifications.push}
      addWorkspace={vi.fn()} createTask={vi.fn()} renameTask={vi.fn()} setTaskPinned={vi.fn()}
      deleteTask={vi.fn()} createScene={vi.fn()} renameScene={vi.fn()} deleteScene={vi.fn()}
      newSession={vi.fn()} openSession={vi.fn()} clearSession={vi.fn()} pinSession={vi.fn()}
      unpinSession={vi.fn()} renameSession={vi.fn()} archiveSession={vi.fn()} navigate={vi.fn()}
      drillTo={vi.fn()} returnToParent={vi.fn()} forkChild={vi.fn()} forkSibling={vi.fn()}
      forkPeer={vi.fn()} removeCard={vi.fn()} commitInteractions={(async () => {}) as never} openDag={vi.fn()} closeDag={vi.fn()}
      SessionProvider={(({ children }: { children?: unknown }) => <>{children}</>) as never}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />,
  )
}

/** 最后一次渲染时轮播收到的 reveal 请求。 */
const lastReveal = () => carouselProps.at(-1)?.['revealRequest'] as { sessionId: string, seq: number } | undefined

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  carouselProps.length = 0
  fixture.reveal = {}
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AppFrame → Carousel 的 reveal 接线（S4 审查 I-1）', () => {
  it('当前页签有请求时，原样传给轮播', () => {
    fixture.reveal = { 'sc-1': { sessionId: 'B', seq: 3 } }
    mount()
    expect(lastReveal()).toEqual({ sessionId: 'B', seq: 3 })
  })

  /**
   * 反例，钉住的是「按**当前页签**取键」这半个语义：把键写成别的页签、或者
   * 重构时换成 `[parentId]` 之类，上面那条照样绿，只有这条会红。
   */
  it('请求属于别的页签时，什么都不传（别的页签的事不归这条带子管）', () => {
    fixture.reveal = { 'sc-OTHER': { sessionId: 'B', seq: 3 } }
    mount()
    expect(lastReveal()).toBeUndefined()
  })

  it('没有任何请求时不传（未表态与"传了个空请求"是两回事）', () => {
    mount()
    expect(carouselProps.length).toBeGreaterThan(0)
    expect(lastReveal()).toBeUndefined()
  })

  it('seq 递增时新值跟着传下去（同一会话再次被点也要重新居中）', () => {
    fixture.reveal = { 'sc-1': { sessionId: 'A', seq: 1 } }
    mount()
    expect(lastReveal()).toEqual({ sessionId: 'A', seq: 1 })
    const before = carouselProps.length
    act(() => { fixture.reveal = { 'sc-1': { sessionId: 'A', seq: 2 } } })
    cleanup()
    carouselProps.length = 0
    mount()
    expect(carouselProps.length).toBeGreaterThan(0)
    expect(before).toBeGreaterThan(0)
    expect(lastReveal()).toEqual({ sessionId: 'A', seq: 2 })
  })
})
