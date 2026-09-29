import { describe, expect, it } from 'vitest'
import { advanceEdge, edgeDirectionAt, nearestHiddenCard } from '../src/client/carousel/edge-browse.ts'

describe('edgeDirectionAt', () => {
  it('只在 84px 边缘带内判方向', () => {
    expect(edgeDirectionAt(10, 1000)).toBe('left')
    expect(edgeDirectionAt(995, 1000)).toBe('right')
    expect(edgeDirectionAt(500, 1000)).toBe('none')
  })
})

describe('advanceEdge', () => {
  it('停留 180ms 后从 confirming 进入 cruising，反向即取消', () => {
    const s0 = { phase: 'idle' as const, direction: 'none' as const, since: 0 }
    const s1 = advanceEdge(s0, 'right', 1000, false)
    expect(s1.phase).toBe('confirming')
    const s2 = advanceEdge(s1, 'right', 1179, false)
    expect(s2.phase).toBe('confirming') // 未满 180ms
    const s3 = advanceEdge(s1, 'right', 1180, false)
    expect(s3.phase).toBe('cruising')
    const s4 = advanceEdge(s3, 'none', 1200, false)
    expect(s4.phase).toBe('idle') // 离开边缘带
    expect(advanceEdge(s3, 'right', 1300, true).phase).toBe('idle') // 手势期间阻断
  })

  it('cruising 中方向反转（right→left）立即取消回 idle', () => {
    const cruisingRight = { phase: 'cruising' as const, direction: 'right' as const, since: 1180 }
    expect(advanceEdge(cruisingRight, 'left', 1300, false).phase).toBe('idle')
  })
})

describe('nearestHiddenCard', () => {
  it('找视口右侧第一张隐藏卡', () => {
    const cards = [{ offsetLeft: 0, offsetWidth: 300 }, { offsetLeft: 312, offsetWidth: 300 }, { offsetLeft: 624, offsetWidth: 300 }]
    expect(nearestHiddenCard(cards, 'right', 0, 700)).toBe(2) // 前两张可见，第三张隐藏
    expect(nearestHiddenCard(cards, 'left', 300, 700)).toBe(0)
    expect(nearestHiddenCard(cards, 'right', 0, 2000)).toBe(-1) // 全可见
  })
})


describe('edge browsing past viewport-filling cards', () => {
  it.each([980, 990, 1000, 1600])('skips the settled %ipx card and reaches its next sibling', width => {
    const cards = [{ offsetLeft: 0, offsetWidth: width }, { offsetLeft: width + 12, offsetWidth: 470 }]
    expect(nearestHiddenCard(cards, 'right', 0, 1000)).toBe(1)
    expect(nearestHiddenCard(cards, 'left', 0, 1000)).toBe(-1)
  })

  it('also moves left past a viewport-filling card, including an interior manual scroll', () => {
    const cards = [{ offsetLeft: 0, offsetWidth: 470 }, { offsetLeft: 482, offsetWidth: 1600 }, { offsetLeft: 2094, offsetWidth: 470 }]
    for (const scroll of [472, 700, 1092]) {
      expect(nearestHiddenCard(cards, 'left', scroll, 1000)).toBe(0)
      expect(nearestHiddenCard(cards, 'right', scroll, 1000)).toBe(2)
    }
  })

  it('stops at the scroll limit instead of repeatedly selecting the last card', () => {
    const cards = [{ offsetLeft: 0, offsetWidth: 1000 }, { offsetLeft: 1012, offsetWidth: 470 }]
    expect(nearestHiddenCard(cards, 'right', 482, 1000, 482)).toBe(-1)
    expect(nearestHiddenCard([{ offsetLeft: 0, offsetWidth: 1000 }], 'right', 0, 1000, 0)).toBe(-1)
    expect(nearestHiddenCard([], 'right', 0, 1000, 0)).toBe(-1)
  })
})
