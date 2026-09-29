// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { Carousel } from '../src/client/carousel/Carousel.tsx'
import type { CardModel } from '../src/client/carousel/CardShell.tsx'
import { useCarouselController } from '../src/client/carousel/useCarouselController.ts'
import type { CarouselCardMeasure, CarouselViewport } from '../src/client/carousel/useCarouselController.ts'
import { geometryKey, readLevelGeometry } from '../src/client/carousel/geometry-store.ts'

afterEach(cleanup)

/** A spy wrapping the real zh dictionary: proves cards call `t(key, params)` (not a hardcoded literal) while still rendering the real product copy. */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

/**
 * Shared no-op behavior props: sceneId/parentId key geometry persistence,
 * onFocus/onReturnToParent back the keyboard shortcuts (Task 9's behavior
 * wiring, exercised separately in "useCarouselController — behavior" below).
 */
const BEHAVIOR_PROPS = { sceneId: 'scene-test', parentId: undefined, onFocus: () => {}, onReturnToParent: undefined }

const CARDS: CardModel[] = [
  {
    sessionId: 'd', title: '重构 Session 存储', state: 'done', hasNotice: false, hasRing: false,
    childCount: 0, focused: false, blank: false,
  },
  {
    sessionId: 'a', title: '登录流程修复', state: 'ongoing', hasNotice: false, hasRing: false,
    childCount: 2, childState: 'ongoing', focused: true, blank: false,
  },
  {
    sessionId: 'c', title: '补单测：登录接口', state: 'warning', hasNotice: true, hasRing: true,
    childCount: 0, focused: false, blank: false,
  },
  {
    sessionId: 'e', title: '整理 API 文档', state: 'warning', hasNotice: false, hasRing: false,
    childCount: 0, focused: false, blank: false,
  },
  {
    sessionId: 'f', title: '回归检查', state: 'done', hasNotice: false, hasRing: false,
    childCount: 3, childState: 'done', focused: false, blank: false,
  },
]

describe('Carousel', () => {
  it('把 visibleCount 写进 --session-visible-columns（jsdom 无布局，回落 4 列），并给每张卡一个 slot', () => {
    const { container } = render(<Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <div />} t={spyT()} />)
    const strip = container.querySelector('[role="region"]') as HTMLElement
    expect(strip.style.getPropertyValue('--session-visible-columns')).toBe('4')
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(5)
  })

  it('aria-label 经 t 取（M1：本分支最后一处硬编码用户可见文案）', () => {
    const t = spyT()
    const { container } = render(<Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <div />} t={t} />)
    const region = container.querySelector('[role="region"]') as HTMLElement
    expect(t).toHaveBeenCalledWith('carousel.list')
    expect(region.getAttribute('aria-label')).toBe(zh['carousel.list'])
  })

  it('对齐码头 DOM：.carousel[role=region][aria-label] > .slot[data-session-id] > .card[aria-current]', () => {
    const { container } = render(<Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <div />} t={spyT()} />)
    const region = container.querySelector('[role="region"]') as HTMLElement
    expect(region.getAttribute('aria-label')).toBe(zh['carousel.list'])
    const slots = Array.from(region.children) as HTMLElement[]
    expect(slots).toHaveLength(5)
    for (const slot of slots) {
      expect(slot.dataset.sessionId).toBeTruthy()
      const card = slot.firstElementChild as HTMLElement
      expect(card.getAttribute('aria-current')).toMatch(/^(true|false)$/)
    }
    const focusedSlot = slots.find(slot => slot.dataset.sessionId === 'a')!
    const focusedCard = focusedSlot.firstElementChild as HTMLElement
    expect(focusedCard.getAttribute('aria-current')).toBe('true')
  })

  it('把 sessionKey 与 focused 转发给 renderPane', () => {
    const calls: Array<[string, boolean]> = []
    render(
      <Carousel
        cards={CARDS}
        {...BEHAVIOR_PROPS}
        renderPane={(sessionKey, focused) => { calls.push([sessionKey, focused]); return <div /> }}
        t={spyT()}
      />,
    )
    expect(calls).toContainEqual(['a', true])
    expect(calls).toContainEqual(['d', false])
  })

  it('把 t 透传给每张卡：子会话徽标与新通知文案经 t 取得', () => {
    const t = spyT()
    render(<Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <div />} t={t} />)
    expect(t).toHaveBeenCalledWith('card.children', { n: 3 })
    expect(t).toHaveBeenCalledWith('card.notice')
  })
})

/**
 * C1 (final review): the render window is what actually MOUNTS, not merely
 * what gets pinned. 码头 slices `nodes` by `renderStart..renderEnd` and pads
 * the omitted head/tail with `.session-card-virtual-spacer`
 * (`SessionCarousel.tsx:108-110, 910-911, 966-967`); a card outside the
 * window must have no DOM at all, because an unpinned-but-rendered pane
 * falls back through DSH's `keyed ?? adapter.resolve(sessionKey) ?? current`
 * chain and would show the FOCUSED session's transcript under a foreign
 * card's title.
 *
 * jsdom reports `clientWidth === 0`, so `visibleColumnsForWidth` falls back
 * to 4 columns and the window is `4 * 3 = 12` cards wide — 14 cards is the
 * smallest fixture that exercises virtualization at all.
 */
describe('Carousel — 渲染窗口即挂载集合（C1，对齐码头 renderStart/renderEnd + 虚拟占位）', () => {
  /** `total` cards, `focusedIndex` focused; ids are `s0`..`s{total-1}` in order. */
  function manyCards(total: number, focusedIndex: number): CardModel[] {
    return Array.from({ length: total }, (_, index) => ({
      sessionId: `s${index}`, title: `会话 ${index}`, hasNotice: false, hasRing: false,
      childCount: 0, focused: index === focusedIndex, blank: false,
    }))
  }

  it('total 超过 visibleCount*3 时，窗口外的卡片完全不渲染，并在尾部补虚拟占位', () => {
    const windowIds: string[][] = []
    const { container } = render(
      <Carousel
        cards={manyCards(14, 0)}
        {...BEHAVIOR_PROPS}
        renderPane={() => <div />}
        onRenderWindowChange={ids => { windowIds.push([...ids]) }}
        t={spyT()}
      />,
    )
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toHaveLength(12)
    expect(rendered[0]).toBe('s0')
    expect(rendered.at(-1)).toBe('s11')
    // The two cards past the window have NO DOM — this is the assertion the
    // "pin only" implementation could never satisfy.
    expect(container.querySelector('[data-session-id="s12"]')).toBeNull()
    expect(container.querySelector('[data-session-id="s13"]')).toBeNull()
    // Pinned set === mounted set, by construction.
    expect(windowIds.at(-1)).toEqual(rendered)

    const spacers = Array.from(container.querySelectorAll('[aria-hidden="true"][style*="--virtual-count"]'))
    expect(spacers).toHaveLength(1) // trailing only: the window starts at 0
    expect((spacers[0] as HTMLElement).style.getPropertyValue('--virtual-count')).toBe('2')
  })

  it('窗口从中间开始时在头部补虚拟占位（滚动条长度与位置不因虚拟化改变）', () => {
    const { container } = render(
      <Carousel cards={manyCards(14, 13)} {...BEHAVIOR_PROPS} renderPane={() => <div />} t={spyT()} />,
    )
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    // initialFocusedIndex 13 seeds firstVisible = 12; start = clamp(12 - 4) to maxStart (14 - 12) = 2.
    expect(rendered[0]).toBe('s2')
    expect(rendered).toHaveLength(12)
    expect(container.querySelector('[data-session-id="s0"]')).toBeNull()
    const region = container.querySelector('[role="region"]') as HTMLElement
    const first = region.firstElementChild as HTMLElement
    expect(first.getAttribute('aria-hidden')).toBe('true')
    expect(first.style.getPropertyValue('--virtual-count')).toBe('2')
    expect(region.lastElementChild!.getAttribute('data-session-id')).toBe('s13') // no trailing spacer
  })

  it('total 未超过窗口时既不切片也不补占位（非虚拟化路径与码头一致）', () => {
    const { container } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <div />} t={spyT()} />,
    )
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(5)
    expect(container.querySelectorAll('[style*="--virtual-count"]')).toHaveLength(0)
  })

  it('窗口外的卡片不调用 renderPane（不会有第二份官方会话订阅未上台的会话）', () => {
    const keys: string[] = []
    render(
      <Carousel
        cards={manyCards(14, 0)}
        {...BEHAVIOR_PROPS}
        renderPane={(sessionKey) => { keys.push(sessionKey); return <div /> }}
        t={spyT()}
      />,
    )
    expect(keys).toContain('s0')
    expect(keys).not.toContain('s12')
    expect(keys).not.toContain('s13')
  })
})

/**
 * Click-to-focus (spec §7.1 step 2, review fix round 2): 码头's own
 * `SessionCard.tsx:19-34` activates a non-focused card on pointerdown
 * (capture phase) or on a descendant receiving focus (focus capture),
 * excluding `button,[role="menuitem"]` so the card's own header/menu
 * controls keep their normal click behavior instead of being swallowed by
 * re-activation. Ported 1:1 onto the carousel's per-card slot wrapper.
 */
describe('Carousel — click/focus-capture activation (对齐码头 SessionCard.tsx:19-34)', () => {
  it('pointerdown 落在非聚焦卡的 slot 上触发 onFocus(sessionId)', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={() => <div />} t={spyT()} />,
    )
    const slot = container.querySelector('[data-session-id="d"]') as HTMLElement
    fireEvent.pointerDown(slot)
    expect(onFocus).toHaveBeenCalledWith('d')
  })

  it('pointerdown 落在已聚焦卡上不重复触发 onFocus（码头 !focused 守卫）', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={() => <div />} t={spyT()} />,
    )
    const slot = container.querySelector('[data-session-id="a"]') as HTMLElement // 'a' is already focused
    fireEvent.pointerDown(slot)
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('pointerdown 落在卡内 button 上不触发 onFocus，且不吞掉该按钮自身的点击行为', () => {
    const onFocus = vi.fn()
    const drillTo = vi.fn()
    const cardMenu = () => ({
      actions: {
        drillTo, forkChild: vi.fn(async () => undefined), forkSibling: vi.fn(async () => undefined),
        forkPeer: vi.fn(async () => undefined), removeCard: vi.fn(async () => undefined),
      },
      renameSession: vi.fn(async () => undefined),
      canForkSibling: false, selfRunning: false, parentRunning: false,
      selfForkReady: true, parentForkReady: true, childTitles: [], siblingTitles: [],
    })
    const { container } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={() => <div />} cardMenu={cardMenu} t={spyT()} />,
    )
    // Card 'f' (childCount 3, not focused) renders a real <button> child badge in its compact header.
    const slot = container.querySelector('[data-session-id="f"]') as HTMLElement
    const badge = within(slot).getByRole('button', { name: /子会话 3/ })
    fireEvent.pointerDown(badge)
    fireEvent.click(badge)
    expect(onFocus).not.toHaveBeenCalled()
    expect(drillTo).toHaveBeenCalledWith('f') // the button's own click handler still ran, unaffected
  })

  it('"⋯" 更多按钮上的 pointerdown+click 同样不触发 onFocus，菜单正常打开（同款排除，覆盖此前唯二漏测的按钮）', () => {
    const onFocus = vi.fn()
    const cardMenu = () => ({
      actions: {
        drillTo: vi.fn(), forkChild: vi.fn(async () => undefined), forkSibling: vi.fn(async () => undefined),
        forkPeer: vi.fn(async () => undefined), removeCard: vi.fn(async () => undefined),
      },
      renameSession: vi.fn(async () => undefined),
      canForkSibling: false, selfRunning: false, parentRunning: false,
      selfForkReady: true, parentForkReady: true, childTitles: [], siblingTitles: [],
    })
    const { container, getByRole } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={() => <div />} cardMenu={cardMenu} t={spyT()} />,
    )
    const slot = container.querySelector('[data-session-id="f"]') as HTMLElement
    const moreButton = within(slot).getByRole('button', { name: '更多操作' })
    fireEvent.pointerDown(moreButton)
    fireEvent.click(moreButton)
    expect(onFocus).not.toHaveBeenCalled()
    expect(getByRole('menuitem', { name: '重命名…' })).toBeTruthy() // the button's own click handler still ran
  })

  it('焦点落入非聚焦卡子树（如卡内输入框获得焦点）时该卡成为焦点（码头 onFocusCapture，覆盖"点进输入框"路径）', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <Carousel
        cards={CARDS}
        {...BEHAVIOR_PROPS}
        onFocus={onFocus}
        renderPane={sessionKey => <input data-testid={`composer-${sessionKey}`} />}
        t={spyT()}
      />,
    )
    const input = container.querySelector('[data-testid="composer-d"]') as HTMLElement
    fireEvent.focusIn(input)
    expect(onFocus).toHaveBeenCalledWith('d')
  })

  it('从卡片 slot 发起的拖拽仍正常滚动（capture 激活钩子不吞掉冒泡，兼容 Task 9 的 3px 拖拽阈值）', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={() => <div />} t={spyT()} />,
    )
    const region = container.querySelector('[role="region"]') as HTMLElement
    Object.defineProperty(region, 'scrollWidth', { value: 2000, configurable: true })
    Object.defineProperty(region, 'clientWidth', { value: 900, configurable: true })
    const slot = container.querySelector('[data-session-id="d"]') as HTMLElement
    fireEvent.pointerDown(slot, { pointerId: 1, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(slot, { pointerId: 1, clientX: 480, clientY: 100 }) // 20px, past the 3px drag threshold
    fireEvent.pointerUp(slot, { pointerId: 1, clientX: 480, clientY: 100 })
    expect(region.scrollLeft).toBeGreaterThan(0) // the bubble-phase drag handler still ran
    expect(onFocus).toHaveBeenCalledWith('d') // ...and the capture-phase activation still ran too, independently
  })

  it('焦点落入已聚焦卡子树不重复触发 onFocus', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <Carousel
        cards={CARDS}
        {...BEHAVIOR_PROPS}
        onFocus={onFocus}
        renderPane={sessionKey => <input data-testid={`composer-${sessionKey}`} />}
        t={spyT()}
      />,
    )
    const input = container.querySelector('[data-testid="composer-a"]') as HTMLElement // 'a' is already focused
    fireEvent.focusIn(input)
    expect(onFocus).not.toHaveBeenCalled()
  })

  /**
   * Guards the most frequent chat-card interaction: clicking into a card's
   * composer must not knock the caret out of the input it just landed in.
   * The activation hooks (`onPointerDownCapture`/`onFocusCapture`) call
   * `onFocus` without `preventDefault`/`stopPropagation`, and this codebase
   * has no programmatic `.focus()` that would steal it back — but the real
   * risk is the *rerender* that follows: the parent flips `card.focused` in
   * response to `onFocus` and re-renders `<Carousel>` with new props. This
   * proves that rerender (with `renderPane` still returning a live
   * `<input>`, same as production) leaves the already-focused input alone
   * and still editable, rather than remounting the pane subtree and
   * dropping focus/keystrokes.
   */
  it('点击卡内输入框后该元素仍可聚焦、仍可输入（激活触发的 rerender 不会打断已有焦点）', () => {
    const onFocus = vi.fn()
    const renderPane = (sessionKey: string) => <input data-testid={`composer-${sessionKey}`} />
    const { container, rerender } = render(
      <Carousel cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={renderPane} t={spyT()} />,
    )
    const input = container.querySelector('[data-testid="composer-d"]') as HTMLInputElement // 'd' starts unfocused
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.pointerDown(input) // capture-phase activation fires synchronously
    expect(onFocus).toHaveBeenCalledWith('d')

    // Simulate the parent's response to onFocus: flip card 'd' to focused
    // and re-render the whole strip, exactly as AppFrame does in production.
    const nextCards = CARDS.map(card => ({ ...card, focused: card.sessionId === 'd' }))
    rerender(<Carousel cards={nextCards} {...BEHAVIOR_PROPS} onFocus={onFocus} renderPane={renderPane} t={spyT()} />)

    expect(document.activeElement).toBe(input) // the rerender did not steal focus
    fireEvent.change(input, { target: { value: '你好' } })
    expect(input.value).toBe('你好') // ...and the input is still live/editable afterward
  })
})

/**
 * `useCarouselController` behavior: jsdom has no real layout
 * (`offsetLeft`/`offsetWidth`/`scrollWidth` are permanently 0), so these
 * tests exercise the hook directly through injected measurement stand-ins —
 * plain `{offsetLeft, offsetWidth}` records for `cardRefs`, and a plain
 * object (not a DOM node) satisfying `CarouselViewport` — instead of
 * rendering `<Carousel>` and patching prototypes. `now: Date.now` makes the
 * follow-loop deadlines advance in lockstep with `vi.useFakeTimers()`; a
 * `requestAnimationFrame` stub (mirroring `tests/app-frame.client.spec.tsx`)
 * routes rAF through the same fake clock via `setTimeout`.
 */
describe('useCarouselController — behavior', () => {
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

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(Date.now()) }, 16) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  })

  afterEach(() => {
    // Unmount (which cancels any in-flight rAF/timeout) while the fake
    // clock and the rAF/cAF stubs are still installed — the top-level
    // `afterEach(cleanup)` runs after this hook, by which point real
    // timers would be back and a still-pending fake handle would be
    // canceled through the wrong (real) `cancelAnimationFrame`.
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  /**
   * 2026-09-14 桌面端走查抓到的崩溃级缺陷（同层 17 张卡，开机即渲染进程 120% CPU、
   * 内存 6 GB、整个应用白屏）的三条回归闸门。根因是一条自激回路：渲染窗口一变，
   * 挂载的卡片就换一批，虚拟占位与真实卡片的宽度对不上，浏览器随即调整 `scrollLeft`
   * 并再发 scroll 事件——于是又算出一个新窗口。码头不会踩到，因为它的
   * `onScroll` 只 `markScrolling()`（`SessionCarousel.tsx:897`），窗口更新一律发生在
   * 它自己写完 `scrollLeft` 之后、以及卡片宽度过渡结束时。
   *
   * 只有同层卡片数超过 `visibleCount × 3` 才进得去这条回路：不超窗时切片恒等于全集、
   * 永不变化。前五轮走查最多摆 5 张卡，所以一直没撞见。
   */
  it('DOM 滚动事件本身不改渲染窗口（否则与虚拟化互相激励），停歇 150ms 后才补算一次', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 6000 }) }
    const cardRefs = { current: makeCards({}) }
    const nodes = Array.from({ length: 17 }, (_, i) => `s${i}`)
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-loop', parentId: undefined, nodes, focusedSessionId: 's0',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))
    const before = { ...result.current.renderWindow }

    // 浏览器因为切片变化而调整了滚动位置，并发来一个 scroll 事件。
    viewportRef.current.scrollLeft = 3000
    act(() => { result.current.onScroll() })
    expect(result.current.renderWindow).toEqual(before) // 当场不动，回路不闭合

    act(() => { vi.advanceTimersByTime(150) })
    expect(result.current.renderWindow.start).toBeGreaterThan(before.start) // 停歇后才跟上
  })

  it('滚动没停就再滚，补算被推迟（防抖只在真正停下来时开一枪）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 6000 }) }
    const cardRefs = { current: makeCards({}) }
    const nodes = Array.from({ length: 17 }, (_, i) => `s${i}`)
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-loop-2', parentId: undefined, nodes, focusedSessionId: 's0',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))
    const before = { ...result.current.renderWindow }
    viewportRef.current.scrollLeft = 3000
    act(() => { result.current.onScroll() })
    act(() => { vi.advanceTimersByTime(100) })
    act(() => { result.current.onScroll() })
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.renderWindow).toEqual(before) // 两次 onScroll 之间不足 150ms
    act(() => { vi.advanceTimersByTime(50) })
    expect(result.current.renderWindow.start).toBeGreaterThan(before.start)
  })

  /**
   * 追踪动画在飞时窗口必须钉在目标卡上。放开的话每帧都会换一批挂载的卡片，目标卡
   * 的 DOM 随之重建、`offsetLeft` 每帧不同，`delta` 永远收敛不了——动画就成了
   * 「每帧重新挂载九张会话面板」的死循环，这正是走查里那 120% CPU 的去向。
   */
  it('聚焦追踪动画期间，渲染窗口钉在目标卡上不随滚动漂移，落定后才重算', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 6000 }) }
    const nodes = Array.from({ length: 17 }, (_, i) => `s${i}`)
    const cardRefs = {
      current: makeCards({ s0: { offsetLeft: 0, offsetWidth: 280 }, s16: { offsetLeft: 5000, offsetWidth: 280 } }),
    }
    const { result, rerender } = renderHook(
      (focusedSessionId: string) => useCarouselController({
        sceneId: 'scene-follow', parentId: undefined, nodes, focusedSessionId,
        onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
      }),
      { initialProps: 's0' },
    )

    act(() => { rerender('s16') })
    act(() => { vi.advanceTimersByTime(48) }) // 动画跑了几帧，scrollLeft 已经在动
    expect(viewportRef.current.scrollLeft).toBeGreaterThan(0)
    const midFlight = { ...result.current.renderWindow }
    // 窗口以目标卡（索引 16）为中心，因此目标卡必须落在窗口内——否则它的 DOM 会在
    // 动画途中被卸载，`offsetLeft` 失效，追踪永远收敛不了。
    expect(midFlight.start).toBeLessThanOrEqual(16)
    expect(midFlight.start + midFlight.count).toBeGreaterThan(16)

    act(() => { vi.advanceTimersByTime(48) })
    expect(result.current.renderWindow).toEqual(midFlight) // 飞行途中一动不动

    act(() => { vi.advanceTimersByTime(1200) }) // 动画落定
    expect(viewportRef.current.scrollLeft).toBeGreaterThan(0)
  })

  it('聚焦切换后，容器 scrollLeft 趋向 centeredCardScrollLeft 的目标值', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 600, offsetWidth: 280 } }) }
    const { rerender } = renderHook(
      (focusedSessionId: string) => useCarouselController({
        sceneId: 'scene-1', parentId: undefined, nodes: ['a', 'b'], focusedSessionId,
        onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
      }),
      { initialProps: 'a' },
    )
    expect(viewportRef.current.scrollLeft).toBe(0) // no auto-center on mount, only on a real change

    act(() => { rerender('b') })
    // centeredCardScrollLeft(600, 280, 900, maxScrollLeft=1100) = 600 - (900-280)/2 = 290
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBeCloseTo(290, 0)
  })

  it('悬停非聚焦卡展开（fullyVisibleCardScrollLeft），鼠标离开带子后立即回滚到基线', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 500, scrollWidth: 900 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 400 }, b: { offsetLeft: 420, offsetWidth: 280 } }) }
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-2', parentId: undefined, nodes: ['a', 'b'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))

    act(() => { result.current.onCardEnter('b') })
    expect(result.current.hoveredSessionId).toBe('b')
    // fullyVisibleCardScrollLeft(420, 280, 0, 500, maxScrollLeft=400, 10): card right (700) clips the
    // 490px visible-right edge -> target = 700 - 500 + 10 = 210.
    act(() => { vi.advanceTimersByTime(600) })
    expect(viewportRef.current.scrollLeft).toBeCloseTo(210, 0)

    act(() => { result.current.onCardLeave() })
    // The rollback to the pre-hover baseline (0) is synchronous, not animated.
    expect(viewportRef.current.scrollLeft).toBe(0)
    expect(result.current.hoveredSessionId).toBeUndefined()

    act(() => { vi.advanceTimersByTime(300) }) // past HOVER_RESTORE_MS: the final re-check stays put
    expect(viewportRef.current.scrollLeft).toBe(0)
  })

  it.each([900, 1500])('铺满视口的 %ipx 卡片：鼠标停在右边缘可带出下一张，离开不回滚', width => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: width + 482 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: width },
      b: { offsetLeft: width + 12, offsetWidth: 470 },
    }) }
    const { result } = renderHook(() => useCarouselController({
      sceneId: `edge-wide-${width}`, parentId: undefined, nodes: ['a', 'b'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))
    act(() => { result.current.onPointerEnter({ pointerId: 1, clientX: 890, clientY: 50, button: 0, target: null, currentTarget: null }) })
    act(() => { vi.advanceTimersByTime(180) })
    expect(result.current.hoveredSessionId).toBe('b')
    act(() => { vi.advanceTimersByTime(2500) })
    expect(viewportRef.current.scrollLeft).toBe(width + 482 - 900)
    expect(result.current.edgePhase).toBe('idle')
    const settled = viewportRef.current.scrollLeft
    act(() => { result.current.onPointerLeave(); vi.advanceTimersByTime(500) })
    expect(viewportRef.current.scrollLeft).toBe(settled)
  })

  it('边缘浏览：dwell 后进入 cruising，随后每隔一段时间用 nearestHiddenCard 逐张推进', () => {
    const cards = makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 },
      b: { offsetLeft: 292, offsetWidth: 280 },
      c: { offsetLeft: 584, offsetWidth: 280 },
      d: { offsetLeft: 876, offsetWidth: 280 },
      e: { offsetLeft: 1168, offsetWidth: 280 },
    })
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 1448 }) }
    const cardRefs = { current: cards }
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-3', parentId: undefined, nodes: ['a', 'b', 'c', 'd', 'e'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))

    // Pointer parked in the right 84px hot zone (viewport [0,900]): x=890.
    act(() => { result.current.onPointerEnter({ pointerId: 1, clientX: 890, clientY: 50, button: 0, target: null, currentTarget: null }) })
    expect(result.current.edgePhase).toBe('confirming')
    // Dwell hasn't elapsed yet: nothing has advanced (a clean 0ms fixture
    // would pass even without the dwell gate — this is the assertion that
    // actually distinguishes "waited for the dwell" from "advanced immediately").
    expect(result.current.hoveredSessionId).toBeUndefined()
    expect(viewportRef.current.scrollLeft).toBe(0)

    act(() => { vi.advanceTimersByTime(180) }) // EDGE_INTENT_DWELL_MS
    expect(result.current.edgePhase).toBe('cruising')
    expect(result.current.hoveredSessionId).toBe('d') // nearest hidden card to the right

    // Let the hover-follow settle on d, then cross the EDGE_BROWSE_INTERVAL_MS
    // tick: d is now fully visible, so the next nearest hidden card is e.
    act(() => { vi.advanceTimersByTime(1200) }) // > FOLLOW_MS settle + EDGE_BROWSE_INTERVAL_MS
    expect(result.current.hoveredSessionId).toBe('e')
    expect(viewportRef.current.scrollLeft).toBeCloseTo(548, 0) // clamped to maxScrollLeft (1448-900)

    act(() => { result.current.onPointerLeave() })
    expect(result.current.edgePhase).toBe('idle')
  })

  /**
   * I3 (final review): 「激活、滚轮、拖拽或边缘浏览会丢弃基线」(spec §3), and
   * `advanceOneHiddenCard` says so in its own comment — but it discarded the
   * baseline and then called `enterHover`, which re-recorded one on the spot
   * because it saw `undefined`. Leaving the strip therefore rolled the
   * viewport back to where browsing STARTED, undoing the last advance. 码头
   * bypasses its `hover()` entry entirely here (`SessionCarousel.tsx:513-522`:
   * clear the baseline, then `setHoveredSessionId` +
   * `keepHoveredCardFullyVisible` directly).
   */
  it('边缘浏览推进后离开带子，滚动位置保持在推进后的位置（不回滚一步）', () => {
    const cards = makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 },
      b: { offsetLeft: 292, offsetWidth: 280 },
      c: { offsetLeft: 584, offsetWidth: 280 },
      d: { offsetLeft: 876, offsetWidth: 280 },
    })
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 1156 }) }
    const cardRefs = { current: cards }
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-13', parentId: undefined, nodes: ['a', 'b', 'c', 'd'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))

    act(() => { result.current.onPointerEnter({ pointerId: 1, clientX: 890, clientY: 50, button: 0, target: null, currentTarget: null }) })
    act(() => { vi.advanceTimersByTime(180) }) // dwell -> cruising, advances onto 'd'
    act(() => { vi.advanceTimersByTime(600) }) // let the follow settle
    const advanced = viewportRef.current.scrollLeft
    expect(advanced).toBeGreaterThan(0)

    act(() => { result.current.onPointerLeave() })
    expect(viewportRef.current.scrollLeft).toBe(advanced) // no immediate rollback
    act(() => { vi.advanceTimersByTime(300) }) // past HOVER_RESTORE_MS: no delayed rollback either
    expect(viewportRef.current.scrollLeft).toBe(advanced)
  })

  it('滚轮阻塞边缘浏览后，指针回中间即解除阻塞，之后贴边仍可再进 confirming（I1）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 } }) }
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-7', parentId: undefined, nodes: ['a'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))

    act(() => {
      result.current.onWheel({ deltaX: 40, deltaY: 0, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} })
    })
    // Right after the wheel, the pointer landing in the edge zone must stay blocked.
    act(() => {
      result.current.onPointerMove({ pointerId: 1, clientX: 890, clientY: 50, button: 0, target: null, currentTarget: null })
    })
    expect(result.current.edgePhase).toBe('idle')

    // Pointer returns to the middle of the strip: this must release the block
    // (mirrors 码头 updateEdgeBrowseIntent's direction===0 branch), not leave
    // edge-browse (and hover-follow, which gates on the same ref) disabled
    // until the pointer fully exits and re-enters the viewport.
    act(() => {
      result.current.onPointerMove({ pointerId: 1, clientX: 450, clientY: 50, button: 0, target: null, currentTarget: null })
    })
    act(() => {
      result.current.onPointerMove({ pointerId: 1, clientX: 890, clientY: 50, button: 0, target: null, currentTarget: null })
    })
    expect(result.current.edgePhase).toBe('confirming')
  })

  /** A keydown-like event with every field defaulted to "nothing pressed"; pass only what a case cares about. */
  function key(overrides: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
    target?: unknown
    preventDefault?: () => void
  }) {
    return {
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, preventDefault: vi.fn(),
      ...overrides,
    }
  }

  it('Cmd+]/[ 循环切卡（wrap-around，Mac 修饰键），ArrowLeft 触发 onReturnToParent，且不吞输入框内的按键', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 900 }) }
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 300, offsetWidth: 280 }, c: { offsetLeft: 600, offsetWidth: 280 },
    }) }
    const onFocus = vi.fn()
    const onReturnToParent = vi.fn()
    const { result, rerender } = renderHook(
      (focusedSessionId: string) => useCarouselController({
        sceneId: 'scene-4', parentId: undefined, nodes: ['a', 'b', 'c'], focusedSessionId,
        onFocus, onReturnToParent, viewportRef, cardRefs, now: Date.now, isMac: true,
      }),
      { initialProps: 'b' },
    )

    const preventDefault = vi.fn()
    act(() => { result.current.onKeyDown(key({ key: ']', metaKey: true, preventDefault })) })
    expect(onFocus).toHaveBeenLastCalledWith('c')
    expect(preventDefault).toHaveBeenCalledTimes(1)

    act(() => { result.current.onKeyDown(key({ key: '[', metaKey: true })) })
    expect(onFocus).toHaveBeenLastCalledWith('a')

    // Wrap-around: focused on the last card, Cmd+] wraps to the first.
    act(() => { rerender('c') })
    act(() => { result.current.onKeyDown(key({ key: ']', metaKey: true })) })
    expect(onFocus).toHaveBeenLastCalledWith('a')

    // Cmd+Shift+] is a different shortcut (码头 reserves it for tab-switching)
    // and must not be mistaken for the plain Cmd+] pane-cycle.
    act(() => { result.current.onKeyDown(key({ key: ']', metaKey: true, shiftKey: true })) })
    expect(onFocus).toHaveBeenCalledTimes(3) // unchanged: the Shift+] press above did not fire a 4th call

    act(() => { result.current.onKeyDown(key({ key: 'ArrowLeft' })) })
    expect(onReturnToParent).toHaveBeenCalledTimes(1)
    expect(onFocus).toHaveBeenCalledTimes(3) // ArrowLeft must not also cycle focus

    // A plain ArrowLeft/ArrowUp originating inside an editable field must not be swallowed.
    const editablePreventDefault = vi.fn()
    const editableTarget = { closest: (selector: string) => (selector.includes('input') ? {} : null) }
    act(() => {
      result.current.onKeyDown(key({ key: 'ArrowLeft', target: editableTarget, preventDefault: editablePreventDefault }))
    })
    expect(onReturnToParent).toHaveBeenCalledTimes(1) // unchanged
    expect(editablePreventDefault).not.toHaveBeenCalled()
  })

  it('修饰键按平台限定：非 Mac 认 Ctrl 不认 Cmd，Mac 认 Cmd 不认 Ctrl（Task 9 审查 I3）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 900 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 300, offsetWidth: 280 } }) }
    const onFocus = vi.fn()
    const { result: nonMac } = renderHook(() => useCarouselController({
      sceneId: 'scene-10', parentId: undefined, nodes: ['a', 'b'], focusedSessionId: 'a',
      onFocus, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now, isMac: false,
    }))
    act(() => { nonMac.current.onKeyDown(key({ key: ']', metaKey: true })) }) // Cmd on non-Mac: ignored
    expect(onFocus).not.toHaveBeenCalled()
    act(() => { nonMac.current.onKeyDown(key({ key: ']', ctrlKey: true })) }) // Ctrl on non-Mac: cycles
    expect(onFocus).toHaveBeenCalledWith('b')

    const onFocusMac = vi.fn()
    const { result: mac } = renderHook(() => useCarouselController({
      sceneId: 'scene-11', parentId: undefined, nodes: ['a', 'b'], focusedSessionId: 'a',
      onFocus: onFocusMac, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now, isMac: true,
    }))
    act(() => { mac.current.onKeyDown(key({ key: ']', ctrlKey: true })) }) // Ctrl on Mac: ignored
    expect(onFocusMac).not.toHaveBeenCalled()
    act(() => { mac.current.onKeyDown(key({ key: ']', metaKey: true })) }) // Cmd on Mac: cycles
    expect(onFocusMac).toHaveBeenCalledWith('b')
  })

  it('同级只有 1 张卡时，Cmd+]/[ 不触发 onFocus（对齐码头 HierarchyShell.focusPane 的 length<=1 守卫）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 900 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 } }) }
    const onFocus = vi.fn()
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-12', parentId: undefined, nodes: ['a'], focusedSessionId: 'a',
      onFocus, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now, isMac: true,
    }))
    act(() => { result.current.onKeyDown(key({ key: ']', metaKey: true })) })
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('几何持久化：滚动改变位置后防抖 180ms 写回 localStorage，随后可用 readLevelGeometry 读回', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 } }) }
    const { result } = renderHook(() => useCarouselController({
      sceneId: 'scene-5', parentId: 'parent-x', nodes: ['a'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))

    act(() => {
      result.current.onWheel({ deltaX: 40, deltaY: 0, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} })
    })
    expect(readLevelGeometry('scene-5', 'parent-x')).toBeUndefined() // not yet debounced

    act(() => { vi.advanceTimersByTime(180) })
    const stored = readLevelGeometry('scene-5', 'parent-x')
    expect(stored?.scrollLeft).toBe(40)
    expect(localStorage.getItem(geometryKey('scene-5', 'parent-x'))).toBeTruthy()
  })

  /**
   * I6 (final review): the debounce read `sceneIdRef.current`/`parentIdRef.current`
   * at FLUSH time, so switching tabs or drilling within the 180ms window
   * redirected the pending write onto the NEW level's key — and unmounting
   * dropped it entirely (the cleanup only cleared the timer). Either way the
   * level the user actually scrolled kept its previous checkpoint, breaking
   * spec §7.1 step 6 (切走再切回位置不变). 码头 flushes on unmount for the same
   * reason (`SessionCanvas.tsx:68-72`).
   */
  it('切层时先冲刷待写几何：写回旧层的键与旧层的位置，不串到新层（I6）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 } }) }
    const { result, rerender } = renderHook(
      (parentId: string) => useCarouselController({
        sceneId: 'scene-14', parentId, nodes: ['a'], focusedSessionId: 'a',
        onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
      }),
      { initialProps: 'parent-x' },
    )
    act(() => {
      result.current.onWheel({ deltaX: 40, deltaY: 0, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} })
    })
    expect(readLevelGeometry('scene-14', 'parent-x')).toBeUndefined() // still inside the debounce

    act(() => { rerender('parent-y') }) // drill / tab-switch before the 180ms elapses
    expect(readLevelGeometry('scene-14', 'parent-x')?.scrollLeft).toBe(40)
    act(() => { vi.advanceTimersByTime(300) })
    expect(readLevelGeometry('scene-14', 'parent-y')).toBeUndefined() // never redirected onto the new key
  })

  it('卸载时冲刷待写几何，而不是连同定时器一起丢弃（I6，对齐码头 SessionCanvas.tsx:68-72）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 } }) }
    const { result, unmount } = renderHook(() => useCarouselController({
      sceneId: 'scene-15', parentId: undefined, nodes: ['a'], focusedSessionId: 'a',
      onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
    }))
    act(() => {
      result.current.onWheel({ deltaX: 55, deltaY: 0, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} })
    })
    act(() => { unmount() })
    expect(readLevelGeometry('scene-15', undefined)?.scrollLeft).toBe(55)
  })

  it('FLIP 重排：同级顺序变化后，对移动过的卡片发起位移动画（Task 9 审查 I2）', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const animateA = vi.fn()
    const animateB = vi.fn()
    const cardRefs = { current: makeCards({
      a: { offsetLeft: 0, offsetWidth: 280, animate: animateA, getAnimations: () => [] },
      b: { offsetLeft: 300, offsetWidth: 280, animate: animateB, getAnimations: () => [] },
    }) }
    const { rerender } = renderHook(
      (nodes: readonly string[]) => useCarouselController({
        sceneId: 'scene-8', parentId: undefined, nodes, focusedSessionId: undefined,
        onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
      }),
      { initialProps: ['a', 'b'] },
    )
    // First paint just seeds the previous-offset baseline: nothing has moved yet.
    expect(animateA).not.toHaveBeenCalled()
    expect(animateB).not.toHaveBeenCalled()

    // Simulate a reorder: 'b' now renders first (layout would put it at x=0),
    // 'a' second (x=300) — the swap a real `orderSiblings` re-sort produces.
    cardRefs.current.set('a', { offsetLeft: 300, offsetWidth: 280, animate: animateA, getAnimations: () => [] })
    cardRefs.current.set('b', { offsetLeft: 0, offsetWidth: 280, animate: animateB, getAnimations: () => [] })
    act(() => { rerender(['b', 'a']) })

    // a moved 0 -> 300 (deltaX = previous - offset = 0 - 300 = -300): animate
    // FROM translateX(-300px) TO translateX(0), so it visually stays put and
    // eases into its new position — the FLIP illusion, ported from 码头
    // SessionCarousel.tsx:232-257.
    expect(animateA).toHaveBeenCalledTimes(1)
    expect(animateA.mock.calls[0]?.[0]).toEqual([{ transform: 'translateX(-300px)' }, { transform: 'translateX(0)' }])
    expect(animateA.mock.calls[0]?.[1]).toEqual({ duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
    // b moved 300 -> 0 (deltaX = 300 - 0 = 300).
    expect(animateB).toHaveBeenCalledTimes(1)
    expect(animateB.mock.calls[0]?.[0]).toEqual([{ transform: 'translateX(300px)' }, { transform: 'translateX(0)' }])
  })

  it('FLIP 重排在没有 animate/getAnimations 的测量替身（真实 jsdom 节点）上是特性检测的，不报错', () => {
    const viewportRef = { current: makeViewport({ clientWidth: 900, scrollWidth: 2000 }) }
    const cardRefs = { current: makeCards({ a: { offsetLeft: 0, offsetWidth: 280 }, b: { offsetLeft: 300, offsetWidth: 280 } }) }
    const { rerender } = renderHook(
      (nodes: readonly string[]) => useCarouselController({
        sceneId: 'scene-9', parentId: undefined, nodes, focusedSessionId: undefined,
        onFocus: () => {}, onReturnToParent: undefined, viewportRef, cardRefs, now: Date.now,
      }),
      { initialProps: ['a', 'b'] },
    )
    cardRefs.current.set('a', { offsetLeft: 300, offsetWidth: 280 })
    cardRefs.current.set('b', { offsetLeft: 0, offsetWidth: 280 })
    expect(() => { act(() => { rerender(['b', 'a']) }) }).not.toThrow()
  })
})

/**
 * S5 Task 8: 「点击卡片任意处删除该会话全部通知」(spec §5 已读规则).
 *
 * Ported from 码头 `hierarchy/TerminalPane.tsx:312-316`, whose pointerdown
 * handler is three statements in this exact order:
 *
 * ```tsx
 * if ((event.target as HTMLElement).closest('button,[role="menuitem"]')) return
 * notificationStore.dismissSessionIndicator(session.id)
 * if (!active) onActivate(session.id)
 * ```
 *
 * The load-bearing detail these tests pin down is that `!active` (this
 * plugin's `card.focused`) gates ONLY the activation — the dismiss is
 * unconditional once the exclusion list has been cleared. Clicking the card
 * that already has focus is the single most common way a user acts on a ring
 * they can see, so folding `!focused` into the dismiss condition would make
 * the feature miss its main path.
 */
describe('Carousel — 点卡片清该会话通知（S5 Task 8，码头 TerminalPane.tsx:312-316）', () => {
  /** One focused card (`a`) and one unfocused card (`c`), each rendering a pane-owned button. */
  function mountPair(over: { onFocus?: () => void; onDismissNotifications?: (id: string) => void } = {}) {
    const onFocus = vi.fn()
    const onDismissNotifications = vi.fn()
    const { container } = render(
      <Carousel
        cards={CARDS.filter(card => card.sessionId === 'a' || card.sessionId === 'c')}
        {...BEHAVIOR_PROPS}
        onFocus={over.onFocus ?? onFocus}
        onDismissNotifications={over.onDismissNotifications ?? onDismissNotifications}
        renderPane={sessionKey => (
          <>
            <button type="button" data-testid={`pane-btn-${sessionKey}`}>发送</button>
            <input data-testid={`pane-input-${sessionKey}`} />
          </>
        )}
        t={spyT()}
      />,
    )
    const slotOf = (id: string) => container.querySelector(`[data-session-id="${id}"]`) as HTMLElement
    return { container, onFocus, onDismissNotifications, slotOf }
  }

  /**
   * One press-and-release with no movement in between — a click. The release
   * is what fires the dismiss (see `Carousel.tsx`'s `onCardPointerDown`);
   * focus still moves on the press, as 码头 and S3b both have it.
   */
  function clickCard(slot: HTMLElement, pointerId = 1): void {
    fireEvent.pointerDown(slot, { button: 0, pointerId, clientX: 100, clientY: 10 })
    fireEvent.pointerUp(slot, { pointerId, clientX: 100, clientY: 10 })
  }

  it('在未聚焦卡的空白处点一下：先聚焦它，松手时清该会话通知', () => {
    const h = mountPair()
    clickCard(h.slotOf('c'))
    expect(h.onDismissNotifications).toHaveBeenCalledWith('c')
    expect(h.onFocus).toHaveBeenCalledWith('c')
  })

  /**
   * The gesture 码头 never had to disambiguate: this carousel scrolls by
   * dragging the strip, and that drag begins as a press on whichever card sits
   * under the pointer. `dismissSessionIndicator` DELETES a session's records
   * rather than marking them read, so dismissing on the press would make
   * scrolling the strip silently destroy the unread state of a card the user
   * only passed over.
   */
  it('按住卡片拖动横条：不清任何通知（拖动不是点击）', () => {
    const h = mountPair()
    fireEvent.pointerDown(h.slotOf('c'), { button: 0, pointerId: 1, clientX: 100, clientY: 10 })
    fireEvent.pointerMove(h.slotOf('c'), { pointerId: 1, clientX: 40, clientY: 10 })
    fireEvent.pointerUp(h.slotOf('c'), { pointerId: 1, clientX: 40, clientY: 10 })
    expect(h.onDismissNotifications).not.toHaveBeenCalled()
    // The press still moved focus — that half is unchanged from S3b.
    expect(h.onFocus).toHaveBeenCalledWith('c')
  })

  it('按下后手势被取消（pointercancel）：不清通知', () => {
    const h = mountPair()
    fireEvent.pointerDown(h.slotOf('c'), { button: 0, pointerId: 1, clientX: 100, clientY: 10 })
    fireEvent.pointerCancel(h.slotOf('c'), { pointerId: 1, clientX: 100, clientY: 10 })
    expect(h.onDismissNotifications).not.toHaveBeenCalled()
  })

  /**
   * The discriminating case for 码头's statement order: an ALREADY focused
   * card still dismisses (only `onFocus` is skipped). An implementation that
   * keeps `!card.focused` in front of both calls passes the test above and
   * fails this one.
   */
  it('点已聚焦的卡：仍然清掉该会话通知，但不重复聚焦', () => {
    const h = mountPair()
    clickCard(h.slotOf('a'))
    expect(h.onDismissNotifications).toHaveBeenCalledWith('a')
    expect(h.onFocus).not.toHaveBeenCalled()
  })

  it('点卡内 button：排除列表命中，既不清通知也不聚焦', () => {
    const h = mountPair()
    clickCard(within(h.slotOf('c')).getByTestId('pane-btn-c'))
    expect(h.onDismissNotifications).not.toHaveBeenCalled()
    expect(h.onFocus).not.toHaveBeenCalled()
  })

  /**
   * 码头 hangs nothing on focus at all (its only handler is `onPointerDown`),
   * so the焦点 path keeps this plugin's own pre-S5 activation semantics and
   * gains NO dismiss: tabbing across a strip of cards must not silently erase
   * unread state the user never looked at. The first assertion is what keeps
   * this test honest — it fails outright if the focus event never reaches
   * React, instead of passing vacuously.
   */
  it('键盘焦点落到卡片上：照旧聚焦，但不清通知（码头对 focus 没有对应物）', () => {
    const h = mountPair()
    // The composer INPUT, not the button: `CARD_ACTIVATE_EXCLUDE_SELECTOR`
    // deliberately excludes buttons from activation too (pre-S5 behavior),
    // so focusing one would prove nothing about the dismiss rule.
    fireEvent.focusIn(within(h.slotOf('c')).getByTestId('pane-input-c'))
    expect(h.onFocus).toHaveBeenCalledWith('c')
    expect(h.onDismissNotifications).not.toHaveBeenCalled()
  })

  it('未接线 onDismissNotifications 时，按下卡片仍照旧聚焦（S5 之前的调用方不受影响）', () => {
    const onFocus = vi.fn()
    const { container } = render(
      <Carousel
        cards={CARDS} {...BEHAVIOR_PROPS} onFocus={onFocus}
        renderPane={() => <div />} t={spyT()}
      />,
    )
    const slot = container.querySelector('[data-session-id="c"]') as HTMLElement
    fireEvent.pointerDown(slot, { button: 0, pointerId: 1, clientX: 100, clientY: 10 })
    fireEvent.pointerUp(slot, { pointerId: 1, clientX: 100, clientY: 10 })
    expect(onFocus).toHaveBeenCalledWith('c')
  })
})


describe('transcript navigation keeps pointer ownership', () => {
  it('does not capture a normal click; captures only a confirmed horizontal pan', () => {
    const { container } = render(<Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <div data-testid="plain">text</div>} t={spyT()} />)
    const region = container.querySelector('[role="region"]') as HTMLElement
    const capture = vi.fn(), release = vi.fn()
    region.setPointerCapture = capture
    region.releasePointerCapture = release
    const target = container.querySelector('[data-testid="plain"]')!
    fireEvent.pointerDown(target, { button: 0, pointerId: 7, clientX: 200, clientY: 100 })
    expect(capture).not.toHaveBeenCalled()
    fireEvent.pointerUp(target, { pointerId: 7 })
    expect(release).not.toHaveBeenCalled()
    fireEvent.pointerDown(target, { button: 0, pointerId: 8, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(target, { pointerId: 8, clientX: 180, clientY: 100 })
    expect(capture).toHaveBeenCalledWith(8)
    fireEvent.pointerUp(target, { pointerId: 8 })
    expect(release).toHaveBeenCalledWith(8)
  })
  it('never captures the navigation rail, even if pointer moves horizontally', () => {
    const navigate = vi.fn()
    const { container } = render(<Carousel cards={CARDS} {...BEHAVIOR_PROPS} renderPane={() => <nav onClick={navigate}><div data-testid="rail">tick</div></nav>} t={spyT()} />)
    const region = container.querySelector('[role="region"]') as HTMLElement
    const capture = vi.fn()
    region.setPointerCapture = capture
    const target = container.querySelector('[data-testid="rail"]')!
    fireEvent.pointerDown(target, { button: 0, pointerId: 9, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(target, { pointerId: 9, clientX: 180, clientY: 100 })
    fireEvent.pointerUp(target, { pointerId: 9 })
    fireEvent.click(target)
    expect(capture).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})
