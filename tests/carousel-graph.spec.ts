import { describe, expect, it } from 'vitest'
import { childrenOfLevel, effectiveParentOf, orderSiblings } from '../src/client/carousel/graph.ts'
import type { CarouselNode } from '../src/client/carousel/graph.ts'

const N = (id: string, p: Partial<CarouselNode> = {}): CarouselNode =>
  ({ sessionId: id, lastInteractionAt: 0, createdAt: 0, ...p })

describe('effectiveParentOf', () => {
  it('优先用 placement 的父，否则回落 DSH parentId', () => {
    const placements = new Map([['a', 'P'], ['b', undefined as string | undefined]])
    const dsh = (id: string) => (id === 'b' ? 'Q' : undefined)
    expect(effectiveParentOf('a', placements, dsh)).toBe('P') // placement 覆盖
    expect(effectiveParentOf('b', placements, dsh)).toBe('Q') // 回落 DSH
    expect(effectiveParentOf('c', placements, dsh)).toBeUndefined() // 根
  })

  /**
   * S3c Task 3：落位的父有**三**态，不是两态。
   *
   * - 键缺席      = 这个会话还没被落位过 → 回落 DSH 的父
   * - 值为 undefined = 落位过但没对父表态 → 仍然回落 DSH 的父
   * - 值为 null   = 落位时**显式说了「就在根层」** → 不回落
   *
   * 第三态是平级 Fork 的正确性所系：在一个根会话 A 上「⑂ Fork 会话」，
   * 新会话 E 应与 A 并排，但 DSH 记的 E.parentId 正是它复制状态的那个 A。
   * 没有第三态，E 会被画成 A 的子会话。
   */
  it('值为 null 表示「显式在根层」，阻断 DSH 回落', () => {
    const placements = new Map<string, string | null | undefined>([['e', null]])
    const dsh = (id: string) => (id === 'e' ? 'A' : undefined)
    expect(effectiveParentOf('e', placements, dsh)).toBeUndefined()
  })

  it('键缺席与值为 undefined 都仍然回落 DSH（第三态不许波及前两态）', () => {
    const placements = new Map<string, string | null | undefined>([['b', undefined]])
    const dsh = () => 'Q'
    expect(effectiveParentOf('b', placements, dsh)).toBe('Q')
    expect(effectiveParentOf('never-placed', placements, dsh)).toBe('Q')
  })
})

describe('orderSiblings', () => {
  it('按最近交互倒序 → 创建序 → id', () => {
    const out = orderSiblings([
      N('x', { lastInteractionAt: 5, createdAt: 1 }),
      N('y', { lastInteractionAt: 9, createdAt: 2 }),
      N('z', { lastInteractionAt: 5, createdAt: 0 }),
    ]).map(n => n.sessionId)
    expect(out).toEqual(['y', 'z', 'x']) // y 最近；z、x 同 lastInteraction 时 z 创建更早
  })

  it('前两键都相同时按 sessionId 升序（真正触发第三键 tiebreak）', () => {
    const out = orderSiblings([
      N('b', { lastInteractionAt: 3, createdAt: 1 }),
      N('a', { lastInteractionAt: 3, createdAt: 1 }),
    ]).map(n => n.sessionId)
    expect(out).toEqual(['a', 'b'])
  })
})

describe('childrenOfLevel', () => {
  it('只取有效父为 parentId 的节点并排序', () => {
    const nodes = [
      N('a', { parentId: 'P', lastInteractionAt: 1 }),
      N('b', { parentId: 'P', lastInteractionAt: 2 }),
      N('c', { parentId: 'Q' }),
    ]
    expect(childrenOfLevel(nodes, 'P').map(n => n.sessionId)).toEqual(['b', 'a'])
    expect(childrenOfLevel(nodes, undefined).map(n => n.sessionId)).toEqual([]) // 无根节点
  })

  it('排除 origin 为 subagent 的节点——子代理会话不进轮播', () => {
    const nodes = [
      N('a', { parentId: 'P' }),
      N('sub', { parentId: 'P', origin: 'subagent' }),
    ]
    expect(childrenOfLevel(nodes, 'P').map(n => n.sessionId)).toEqual(['a'])
  })
})
