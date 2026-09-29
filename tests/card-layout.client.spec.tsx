// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PointerEvent, MouseEvent } from 'react'
import { useCardLayout } from '../src/client/carousel/useCardLayout.ts'
import { cardIndexAt, DEFAULT_CARD_WIDTH, moveCard, readCardWidths, saveCardWidths } from '../src/client/carousel/card-layout.ts'

beforeEach(() => { localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '' })
function setup() {
  const viewport = document.createElement('div')
  viewport.innerHTML = '<div data-session-id="a"><div data-card-header><span>Title</span><button>More</button></div><div data-card-resize></div><textarea></textarea></div>'
  document.body.append(viewport)
  viewport.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600 } as DOMRect)
  viewport.setPointerCapture = vi.fn()
  viewport.hasPointerCapture = () => false
  const onFocus = vi.fn()
  const onReorder = vi.fn(async (_ids: readonly string[]) => {})
  const hook = renderHook(({ scope }) => useCardLayout(['a', 'b', 'c'], scope, onFocus, onReorder), { initialProps: { scope: 'root' } })
  const event = (selector: string, x = 100, extra = {}) => ({
    target: viewport.querySelector(selector), currentTarget: viewport,
    button: 0, pointerId: 1, clientX: x, clientY: 10, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra,
  } as unknown as PointerEvent<HTMLDivElement>)
  return { ...hook, event, onFocus, onReorder }
}
describe('persistent card sizing and long-press sorting', () => {
  it('clamps to the default minimum and saves width only on release', () => {
    const h = setup()
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-resize]')))
    act(() => h.result.current.handlers.onPointerMoveCapture(h.event('[data-card-resize]', 300)))
    expect(h.result.current.widths.a).toBe(DEFAULT_CARD_WIDTH + 200)
    expect(readCardWidths().a).toBeUndefined()
    act(() => h.result.current.handlers.onPointerUpCapture(h.event('[data-card-resize]', 300)))
    expect(readCardWidths().a).toBe(670)
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-resize]')))
    act(() => h.result.current.handlers.onPointerMoveCapture(h.event('[data-card-resize]', -900)))
    act(() => h.result.current.handlers.onPointerUpCapture(h.event('[data-card-resize]', -900)))
    expect(readCardWidths().a).toBe(DEFAULT_CARD_WIDTH)
    expect(h.onFocus).not.toHaveBeenCalled()
  })
  it('restores persisted width on remount and resets by double-clicking the header', () => {
    saveCardWidths({ a: 800 })
    const h = setup()
    expect(h.result.current.widths.a).toBe(800)
    act(() => h.result.current.handlers.onDoubleClickCapture(h.event('[data-card-header]') as unknown as MouseEvent<HTMLDivElement>))
    expect(h.result.current.widths.a).toBeUndefined()
    expect(readCardWidths().a).toBeUndefined()
  })
  it('resets on two short header presses even when pointer capture retargets click', () => {
    saveCardWidths({ a: 800 })
    const h = setup()
    for (let i = 0; i < 2; i++) {
      act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-header]')))
      act(() => h.result.current.handlers.onPointerUpCapture(h.event('[data-card-header]')))
      act(() => vi.advanceTimersByTime(100))
    }
    expect(readCardWidths().a).toBeUndefined()
  })

  it('requires 400ms, previews reorder, then saves on release', async () => {
    const h = setup()
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-header]')))
    act(() => vi.advanceTimersByTime(399))
    expect(h.result.current.active?.kind).toBe('press')
    act(() => vi.advanceTimersByTime(1))
    expect(h.result.current.active?.kind).toBe('sort')
    act(() => h.result.current.handlers.onPointerMoveCapture(h.event('[data-card-header]', 1100)))
    expect(h.result.current.order).toEqual(['b', 'c', 'a'])
    expect(h.onReorder).not.toHaveBeenCalled()
    await act(async () => h.result.current.handlers.onPointerUpCapture(h.event('[data-card-header]', 1100)))
    expect(h.onReorder).toHaveBeenCalledWith(['b', 'c', 'a'])
    expect(h.onFocus).not.toHaveBeenCalled()
  })
  it('early movement, cancellation, and navigation cancel pending holds', () => {
    const h = setup()
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-header]')))
    act(() => h.result.current.handlers.onPointerMoveCapture(h.event('[data-card-header]', 107)))
    act(() => vi.advanceTimersByTime(400))
    expect(h.result.current.active).toBeNull()
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-header]')))
    h.rerender({ scope: 'child' })
    act(() => vi.advanceTimersByTime(400))
    expect(h.result.current.active).toBeNull()
    expect(h.onReorder).not.toHaveBeenCalled()
  })
  it('buttons and text editors keep their normal pointer behavior', () => {
    const h = setup()
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('button')))
    act(() => vi.advanceTimersByTime(400))
    expect(h.result.current.active).toBeNull()
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('textarea')))
    expect(h.result.current.active).toBeNull()
  })
  it('failed saving restores the old order and reports an error', async () => {
    const h = setup(); h.onReorder.mockRejectedValueOnce(new Error('保存失败'))
    act(() => h.result.current.handlers.onPointerDownCapture(h.event('[data-card-header]')))
    act(() => vi.advanceTimersByTime(400))
    act(() => h.result.current.handlers.onPointerMoveCapture(h.event('[data-card-header]', 1100)))
    await act(async () => h.result.current.handlers.onPointerUpCapture(h.event('[data-card-header]', 1100)))
    expect(h.result.current.order).toEqual(['a', 'b', 'c'])
    expect(h.result.current.error).toBe('保存失败')
  })
  it('uses actual variable widths when finding offscreen cards', () => {
    expect(cardIndexAt([470, 1200, 470], 1400)).toBe(1)
    expect(cardIndexAt([470, 1200, 470], 1800)).toBe(2)
    expect(moveCard(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })
  it('rejects corrupted saved dimensions', () => {
    localStorage.setItem('matou.card-widths.v1', '{bad')
    expect(readCardWidths()).toEqual({})
    localStorage.setItem('matou.card-widths.v1', '{"a":-1,"b":500,"c":"large"}')
    expect(readCardWidths()).toEqual({ b: 500 })
  })
})
