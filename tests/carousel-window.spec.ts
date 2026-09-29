import { describe, expect, it } from 'vitest'
import { computeRenderWindow, estimatedCardOffset, updateVisibleWindow } from '../src/client/carousel/window.ts'

describe('estimatedCardOffset', () => {
  it('用等分单位，宽 0 回落 292', () => {
    expect(estimatedCardOffset(2, 1200, 4)).toBe(10 + 2 * 300)
    expect(estimatedCardOffset(2, 0, 4)).toBe(10 + 2 * 292)
  })
})

describe('updateVisibleWindow', () => {
  it('由 scrollLeft 反推首个可见 index', () => {
    expect(updateVisibleWindow(0, 1200, 4, 10)).toBe(0)
    expect(updateVisibleWindow(600, 1200, 4, 10)).toBe(2)   // 600 / (1200/4=300) = 2
    expect(updateVisibleWindow(0, 1200, 4, 3)).toBe(0)      // total<=visible 强制 0
  })

  it('clientWidth<=0 时单位回落为 1（与 estimatedCardOffset 的 292 不同），锁死防误改', () => {
    // 与码头 SessionCarousel.tsx:395 逐字一致：unit 回落 1，不是 292。
    // round(1/1)=1；若误改成回落 292，round(1/292)=0，本断言会先炸。
    expect(updateVisibleWindow(1, 0, 4, 10)).toBe(1)
    expect(updateVisibleWindow(1, -100, 4, 10)).toBe(1) // 负宽同样回落 1
  })
})

describe('computeRenderWindow', () => {
  it('焦点变化时以焦点居中，clamp 到边界', () => {
    expect(computeRenderWindow(0, 4, 30, 0, false)).toEqual({ start: 0, count: 12 })
    const w = computeRenderWindow(0, 4, 30, 20, true)
    expect(w.count).toBe(12)
    expect(w.start).toBe(16) // focusedIndex(20) - visibleCount(4)
    expect(computeRenderWindow(0, 4, 5, 0, false)).toEqual({ start: 0, count: 5 }) // total<window
  })

  it('focusChanged 为真但 focusedIndex 未找到（-1，如焦点会话已归档/跨层瞬间）时回退 firstVisible 基准', () => {
    // 对照码头 SessionCarousel.tsx:102-104：renderStart 只在 focusChanged &&
    // focusedIndex>=0 时才以焦点为基准，否则退回 defaultRenderStart（firstVisible 基准）。
    const w = computeRenderWindow(5, 4, 30, -1, true)
    expect(w.start).toBe(1) // firstVisible(5) - visibleCount(4) = 1，不是 focusedIndex(-1)-4 被 clamp 出的 0
    expect(w.count).toBe(12)
  })
})
