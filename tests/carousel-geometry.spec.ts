import { describe, expect, it } from 'vitest'
import {
  anchoredCardScrollLeft,
  centeredCardScrollLeft,
  fullyVisibleCardScrollLeft,
  visibleColumnsForWidth,
} from '../src/client/carousel/geometry.ts'

describe('visibleColumnsForWidth', () => {
  it('按 292 步进，封顶 4，宽 0 回落 4', () => {
    expect(visibleColumnsForWidth(9, 1440)).toBe(4)
    expect(visibleColumnsForWidth(9, 900)).toBe(3)
    expect(visibleColumnsForWidth(9, 700)).toBe(2)
    expect(visibleColumnsForWidth(9, 420)).toBe(1)
    expect(visibleColumnsForWidth(2, 1440)).toBe(4) // 少会话也不拉伸
    expect(visibleColumnsForWidth(9, 0)).toBe(4)
  })
})

describe('centeredCardScrollLeft', () => {
  it('居中并夹在 [0, max]', () => {
    expect(centeredCardScrollLeft(600, 400, 1000, 2000)).toBe(300) // 600 - (1000-400)/2
    expect(centeredCardScrollLeft(0, 400, 1000, 2000)).toBe(0)     // 夹底
    expect(centeredCardScrollLeft(5000, 400, 1000, 2000)).toBe(2000) // 夹顶
  })
})

describe('anchoredCardScrollLeft', () => {
  it('把卡片放在距视口左边缘固定偏移处，clamp 到 [0, max]', () => {
    expect(anchoredCardScrollLeft(600, 50, 2000)).toBe(550) // 600 - 50
    expect(anchoredCardScrollLeft(10, 50, 2000)).toBe(0)    // 夹底
    expect(anchoredCardScrollLeft(5000, 50, 2000)).toBe(2000) // 夹顶
  })
})

describe('fullyVisibleCardScrollLeft', () => {
  it('已可见则原样，越左/越右各自最小滚动', () => {
    // 已完全可见：返回当前 scrollLeft
    expect(fullyVisibleCardScrollLeft(200, 300, 100, 1000, 5000)).toBe(100)
    // 越左：滚到 offset - inset
    expect(fullyVisibleCardScrollLeft(50, 300, 100, 1000, 5000)).toBe(40)
    // 越右：滚到 cardRight - viewport + inset
    expect(fullyVisibleCardScrollLeft(900, 300, 100, 1000, 5000)).toBe(210)
  })
})


describe('wide-card hover stability', () => {
  it.each([980, 990, 1000, 1600])('keeps width %i stable over repeated hover frames', width => {
    for (const initial of [0, 100, 490, 800, 2000]) {
      const settled = fullyVisibleCardScrollLeft(500, width, initial, 1000, 3000)
      let next = settled
      for (let frame = 0; frame < 120; frame++) next = fullyVisibleCardScrollLeft(500, width, next, 1000, 3000)
      expect(next).toBe(settled)
    }
  })
  it('preserves manual scrolling inside an oversized card', () => {
    expect(fullyVisibleCardScrollLeft(500, 1600, 850, 1000, 3000)).toBe(850)
  })
})
