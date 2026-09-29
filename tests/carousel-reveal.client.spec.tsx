// @vitest-environment jsdom
/**
 * S4 Task 8（裁定 T-5）：**显式导航请求的强制重新居中**。
 *
 * 本仓 `useCarouselController.ts` 的居中副作用只在 `focusedSessionId`
 * **变化**时跑（`if (!changed) return`）。于是「点 DAG 里那个已经是当前会话
 * 的节点」「点通知中心里指向当前已聚焦会话的那一条」屏幕上都什么都不动 ——
 * 前者过不了 spec §7.3 第 6 条的「B 聚焦居中」，后者是 S5 一直存在的同一个
 * 坑。码头正是为此才有 `revealRequest.sequence`
 * （`session-canvas/SessionCarousel.tsx:349-387`，注释原文：“DAG and
 * notification navigation may select the already-focused Session. In that
 * case React has no focus-ID change to observe, so force the carousel
 * position from this explicit navigation request.”），入口在
 * `hierarchy/HierarchyShell.tsx:1040-1055` 的 `onRevealSession`，那里同样是
 * `sequence: (current[sceneId]?.sequence ?? 0) + 1`。
 *
 * 三段一起测，因为链路少一环用户就什么都看不到：store 递增 → `revealSession`
 * 写入 → 控制器强制居中 → `Carousel` 把 prop 转发下去。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { Carousel } from '../src/client/carousel/Carousel.tsx'
import type { CardModel } from '../src/client/carousel/CardShell.tsx'
import { createRevealStore } from '../src/client/carousel/reveal-store.ts'
import { writeLevelGeometry } from '../src/client/carousel/geometry-store.ts'
import { useCarouselController } from '../src/client/carousel/useCarouselController.ts'
import type { CarouselCardMeasure, CarouselViewport } from '../src/client/carousel/useCarouselController.ts'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'

afterEach(cleanup)

describe('carousel/reveal-store — 显式导航请求的序号（对齐码头 HierarchyShell.tsx:1047-1054）', () => {
  it('初始为空', () => {
    const store = createRevealStore().create()
    expect(store.getSnapshot().bySceneId).toEqual({})
  })

  it('同一页签重复请求同一个会话，序号仍逐次递增（"目标没变"正是必须支持的那种情形）', () => {
    const store = createRevealStore().create()
    store.actions.request('sc-1', 'B')
    expect(store.getSnapshot().bySceneId['sc-1']).toEqual({ sessionId: 'B', seq: 1 })
    store.actions.request('sc-1', 'B')
    expect(store.getSnapshot().bySceneId['sc-1']).toEqual({ sessionId: 'B', seq: 2 })
  })

  it('换会话再请求：序号继续递增，sessionId 更新', () => {
    const store = createRevealStore().create()
    store.actions.request('sc-1', 'B')
    store.actions.request('sc-1', 'C')
    expect(store.getSnapshot().bySceneId['sc-1']).toEqual({ sessionId: 'C', seq: 2 })
  })

  it('不同页签各记各的：另一个页签从 1 开始，且不动到前一个（键的粒度照抄码头：按页签）', () => {
    const store = createRevealStore().create()
    store.actions.request('sc-1', 'B')
    store.actions.request('sc-1', 'B')
    store.actions.request('sc-2', 'X')
    expect(store.getSnapshot().bySceneId['sc-1']).toEqual({ sessionId: 'B', seq: 2 })
    expect(store.getSnapshot().bySceneId['sc-2']).toEqual({ sessionId: 'X', seq: 1 })
  })

  it('订阅者在每次请求后被通知（"目标不变"也必须通知，否则整条链路对已聚焦会话失效）', () => {
    const store = createRevealStore().create()
    const seen = vi.fn()
    const off = store.subscribe(seen)
    store.actions.request('sc-1', 'B')
    store.actions.request('sc-1', 'B')
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })
})

/**
 * 控制器侧：与既有的 `useCarouselController — behavior` 一组同样的注入式测量
 * 替身（jsdom 没有真实布局，`offsetLeft`/`scrollWidth` 恒为 0），`now:
 * Date.now` 让跟随循环的截止时间随假时钟推进。
 */
describe('useCarouselController — revealRequest 强制重新居中', () => {
  function makeViewport(init: Partial<CarouselViewport> & { clientWidth: number; scrollWidth: number }): CarouselViewport {
    return {
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0, right: init.clientWidth }),
      ...init,
    }
  }

  function makeCards(entries: Record<string, CarouselCardMeasure>): Map<string, CarouselCardMeasure> {
    return new Map(Object.entries(entries))
  }

  interface HookProps {
    focusedSessionId: string | undefined
    revealRequest?: { sessionId: string; seq: number }
    parentId?: string | undefined
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(Date.now()) }, 16) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  /** `nodes` 固定为 ['a','b','c']，卡片测量固定；只有焦点/请求/层随用例变。 */
  function mount(
    sceneId: string,
    viewportRef: { current: CarouselViewport },
    cardRefs: { current: Map<string, CarouselCardMeasure> },
    initial: HookProps,
  ) {
    return renderHook(
      (props: HookProps) => useCarouselController({
        sceneId,
        parentId: props.parentId,
        nodes: ['a', 'b', 'c'],
        focusedSessionId: props.focusedSessionId,
        onFocus: () => {},
        onReturnToParent: undefined,
        viewportRef,
        cardRefs,
        now: Date.now,
        ...(props.revealRequest === undefined ? {} : { revealRequest: props.revealRequest }),
      }),
      { initialProps: initial },
    )
  }

  it('焦点一动不动、只有 seq 加一：仍然重新居中（这正是"点已经聚焦的那个会话"）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 600, offsetWidth: 280 }, c: { offsetLeft: 1200, offsetWidth: 280 },
    }) }
    const { rerender } = mount('scene-reveal-1', viewportRef, cardRefs, { focusedSessionId: 'b' })
    // 挂载不自动居中（既有约定：只对"变化"动画），焦点自始至终是 b。
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBe(0)

    act(() => { rerender({ focusedSessionId: 'b', revealRequest: { sessionId: 'b', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    // centeredCardScrollLeft(600, 280, 900, maxScrollLeft=1100) = 600 - (900-280)/2 = 290
    expect(viewportRef.current.scrollLeft).toBeCloseTo(290, 0)
  })

  it('seq 不变的重渲染（对象换了身份也一样）不重复居中', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 600, offsetWidth: 280 }, c: { offsetLeft: 1200, offsetWidth: 280 },
    }) }
    const { rerender } = mount('scene-reveal-2', viewportRef, cardRefs, { focusedSessionId: 'b' })
    act(() => { rerender({ focusedSessionId: 'b', revealRequest: { sessionId: 'b', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBeCloseTo(290, 0)

    // 用户自己滚开了；同一个 seq 的又一次重渲染不该把他拽回去。
    viewportRef.current.scrollLeft = 0
    act(() => { rerender({ focusedSessionId: 'b', revealRequest: { sessionId: 'b', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBe(0)
  })

  /**
   * 码头对这一条写得很直白：“The sequence is an explicit product navigation
   * request. It must override persisted geometry even when the target Session
   * ID did not change.”（`SessionCarousel.tsx:384-385`）本仓的持久化几何在
   * 恢复时会置 `skipNextFocusFollowRef`，reveal 必须跳过它。
   */
  /**
   * S4 审查 D-2：上面那条测的是 reveal 自己压过标志，但 `skipNextFocusFollowRef
   * = false` 那一行的作用其实是**二阶**的——删掉它，本文件其余用例全绿。
   *
   * 几何恢复会把「本次焦点变化别跟随」这面旗立起来（位置由持久化决定）。
   * reveal 自己不读这面旗，所以删掉不影响这一次居中；坏的是**下一次**：旗子
   * 一直举着，会把紧接着的一次真实焦点移动吃掉。
   *
   * 用户看到的现象：下钻到某层（几何恢复立旗）→ 点关系图里已经聚焦的那张卡
   *（reveal 居中）→ 再点另一张卡切焦点 → 轮播不跟过去。
   */
  it('reveal 之后紧接一次真实焦点变化，仍然跟随（reveal 必须把旗放倒）', () => {
    writeLevelGeometry('scene-reveal-d2', 'p2', { scrollLeft: 500 })
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 600, offsetWidth: 280 }, c: { offsetLeft: 1200, offsetWidth: 280 },
    }) }
    // 挂载即恢复几何 → 旗立起
    const { rerender } = mount('scene-reveal-d2', viewportRef, cardRefs, { focusedSessionId: 'a', parentId: 'p2' })
    act(() => { vi.advanceTimersByTime(600) })

    // reveal 到 c：这一次居中与旗无关，但它必须顺手把旗放倒
    act(() => { rerender({ focusedSessionId: 'a', parentId: 'p2', revealRequest: { sessionId: 'c', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    const afterReveal = viewportRef.current.scrollLeft

    // 紧接着一次真实的焦点变化：旗若还举着，这次就不跟随，位置会停在 afterReveal
    act(() => { rerender({ focusedSessionId: 'b', parentId: 'p2', revealRequest: { sessionId: 'c', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).not.toBe(afterReveal)
    // centeredCardScrollLeft(600, 280, 900, 1100) = 290
    expect(viewportRef.current.scrollLeft).toBeCloseTo(290, 0)
  })

  it('切层时刚恢复完持久化几何，reveal 仍然强制居中（压过 skipNextFocusFollow）', () => {
    writeLevelGeometry('scene-reveal-3', 'p2', { scrollLeft: 500 })
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 600, offsetWidth: 280 }, c: { offsetLeft: 1200, offsetWidth: 280 },
    }) }
    const { rerender } = mount('scene-reveal-3', viewportRef, cardRefs, { focusedSessionId: 'b', parentId: 'p1' })
    // revealSession 一次提交里同时改层（setLevel）和加 seq —— 恢复副作用先跑。
    act(() => { rerender({ focusedSessionId: 'b', parentId: 'p2', revealRequest: { sessionId: 'b', seq: 1 } }) })
    expect(viewportRef.current.scrollLeft).toBe(500) // 恢复确实发生了
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBeCloseTo(290, 0)
  })

  it('一次 reveal 清掉 hover 基线：离开带子不再回滚到悬停前的位置', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 500, scrollWidth: 1200 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 292, offsetWidth: 280 }, c: { offsetLeft: 584, offsetWidth: 280 },
    }) }
    const { result, rerender } = mount('scene-reveal-4', viewportRef, cardRefs, { focusedSessionId: 'a' })

    act(() => { result.current.onCardEnter('b') }) // 记下基线 0
    act(() => { vi.advanceTimersByTime(600) })
    // fullyVisibleCardScrollLeft(292, 280, 0, 500, max=700, 10) = 292+280-500+10 = 82
    expect(viewportRef.current.scrollLeft).toBeCloseTo(82, 0)

    act(() => { rerender({ focusedSessionId: 'a', revealRequest: { sessionId: 'c', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    // centeredCardScrollLeft(584, 280, 500, max=700) = 584 - (500-280)/2 = 474
    expect(viewportRef.current.scrollLeft).toBeCloseTo(474, 0)
    expect(result.current.hoveredSessionId).toBeUndefined()

    act(() => { result.current.onPointerLeave() })
    act(() => { vi.advanceTimersByTime(300) }) // 越过 HOVER_RESTORE_MS
    expect(viewportRef.current.scrollLeft).toBeCloseTo(474, 0) // 基线若还在，这里会变回 0
  })

  it('目标不在当前层：整条副作用是 no-op（不动视口，也不动 hover 基线）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 500, scrollWidth: 1200 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 292, offsetWidth: 280 }, c: { offsetLeft: 584, offsetWidth: 280 },
    }) }
    const { result, rerender } = mount('scene-reveal-5', viewportRef, cardRefs, { focusedSessionId: 'a' })

    act(() => { result.current.onCardEnter('b') })
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBeCloseTo(82, 0)

    act(() => { rerender({ focusedSessionId: 'a', revealRequest: { sessionId: 'zzz', seq: 1 } }) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBeCloseTo(82, 0)
    expect(result.current.hoveredSessionId).toBe('b') // 悬停状态没被一个够不着的请求清掉

    act(() => { result.current.onPointerLeave() })
    expect(viewportRef.current.scrollLeft).toBe(0) // 基线还在，正常回滚
  })
})

/**
 * `Carousel` 的转发：控制器测的是数学，这里测的是 prop 真的接上了。jsdom 没有
 * 布局，所以在真实节点上按需 `defineProperty` 出 `scrollLeft`/`clientWidth`/
 * `offsetLeft` —— 只有这一处需要，其余测量仍走既有的注入式替身。
 */
describe('Carousel — 把 revealRequest 转发给控制器', () => {
  const t = ((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))) as never

  const CARDS: CardModel[] = [
    { sessionId: 'a', title: 'A', hasNotice: false, hasRing: false, childCount: 0, focused: true, blank: false },
    { sessionId: 'b', title: 'B', hasNotice: false, hasRing: false, childCount: 0, focused: false, blank: false },
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(Date.now()) }, 16) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('seq 变化时，滚动容器真的滚到目标卡的居中位置', () => {
    const view = (revealRequest?: { sessionId: string; seq: number }) => (
      <Carousel
        cards={CARDS}
        sceneId="scene-forward"
        parentId={undefined}
        onFocus={() => {}}
        onReturnToParent={undefined}
        renderPane={() => <div />}
        {...(revealRequest === undefined ? {} : { revealRequest })}
        t={t}
      />
    )
    const { container, rerender } = render(view())
    const region = container.querySelector('[role="region"]') as HTMLElement
    let scrollLeft = 0
    Object.defineProperty(region, 'scrollLeft', {
      configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = value },
    })
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 900 })
    Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 2000 })
    const slotB = container.querySelector('[data-session-id="b"]') as HTMLElement
    Object.defineProperty(slotB, 'offsetLeft', { configurable: true, value: 600 })
    Object.defineProperty(slotB, 'offsetWidth', { configurable: true, value: 280 })

    act(() => { rerender(view({ sessionId: 'b', seq: 1 })) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(scrollLeft).toBeCloseTo(290, 0)
  })
})

