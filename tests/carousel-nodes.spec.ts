/**
 * The one shared session→{@link CarouselNode} projection (Ruling-20). Before
 * it there were three: AppFrame's (scene refs, archived already filtered
 * upstream), `header-seats.tsx`'s `directChildrenOf` (whole list, subagents
 * only), and `actions.ts`'s `nodesOf` (whole list, subagents only) — so the
 * same card could show 「子会话 1」on its official header and no badge at all
 * on its compact one, and a badge could drill into an archived session that
 * exists in no layer.
 */
import { describe, expect, it } from 'vitest'
import { childrenOfLevel } from '../src/client/carousel/graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from '../src/client/carousel/nodes.ts'
import type { NodeSessionFacts } from '../src/client/carousel/nodes.ts'

/** A session-list stand-in: ids in order plus their facts. */
function listOf(entries: Record<string, NodeSessionFacts>) {
  return {
    ids: Object.keys(entries),
    summaryOf: (id: string): NodeSessionFacts | undefined => entries[id],
  }
}

describe('projectCarouselNodes', () => {
  it('过滤子代理与已归档会话（两处口径此前各缺一半）', () => {
    const { ids, summaryOf } = listOf({
      a: {}, sub: { origin: 'subagent' }, gone: {}, b: {},
    })
    const nodes = projectCarouselNodes({
      ids, summaryOf, placementsBySession: new Map(), archivedIds: ['gone'],
    })
    expect(nodes.map(node => node.sessionId)).toEqual(['a', 'b'])
  })

  it('没有 summary 的 id 直接丢弃（列表与组织文档不同步的瞬间）', () => {
    const { ids, summaryOf } = listOf({ a: {} })
    const nodes = projectCarouselNodes({ ids: [...ids, 'ghost'], summaryOf, placementsBySession: new Map() })
    expect(nodes.map(node => node.sessionId)).toEqual(['a'])
  })

  it('placement 的父级压过 DSH 自己的 parentId', () => {
    const { ids, summaryOf } = listOf({ p: {}, q: {}, c: { parentId: 'p' } })
    const nodes = projectCarouselNodes({
      ids, summaryOf, placementsBySession: placementsBySessionOf([{ sessionId: 'c', parentSessionId: 'q' }]),
    })
    expect(nodes.find(node => node.sessionId === 'c')?.parentId).toBe('q')
  })

  it('父级不在本投影内（已归档/子代理/跨场景）时该节点退回根层，而不是从所有层里消失', () => {
    const { ids, summaryOf } = listOf({ gone: {}, orphan: { parentId: 'gone' } })
    const nodes = projectCarouselNodes({ ids, summaryOf, placementsBySession: new Map(), archivedIds: ['gone'] })
    expect(nodes.find(node => node.sessionId === 'orphan')?.parentId).toBeUndefined()
    expect(childrenOfLevel(nodes, undefined).map(node => node.sessionId)).toEqual(['orphan'])
  })

  it('lastInteractionAt：空白（从未有过一轮对话）会话取 0，其余取 updatedAt（I1）', () => {
    const { ids, summaryOf } = listOf({
      old: { updatedAt: 100 }, fresh: { updatedAt: 900, blank: true },
    })
    const nodes = projectCarouselNodes({ ids, summaryOf, placementsBySession: new Map() })
    expect(nodes.find(node => node.sessionId === 'fresh')?.lastInteractionAt).toBe(0)
    expect(nodes.find(node => node.sessionId === 'old')?.lastInteractionAt).toBe(100)
    // ...so a brand-new blank card sorts LAST among siblings, i.e. rightmost.
    expect(childrenOfLevel(nodes, undefined).map(node => node.sessionId)).toEqual(['old', 'fresh'])
  })

  it('createdAt 来自调用方的 ordinalOf，缺省为 0', () => {
    const { ids, summaryOf } = listOf({ a: {}, b: {} })
    const ordered = projectCarouselNodes({
      ids, summaryOf, placementsBySession: new Map(), ordinalOf: id => (id === 'a' ? 2 : 1),
    })
    expect(childrenOfLevel(ordered, undefined).map(node => node.sessionId)).toEqual(['b', 'a'])
    const flat = projectCarouselNodes({ ids, summaryOf, placementsBySession: new Map() })
    expect(flat.every(node => node.createdAt === 0)).toBe(true)
  })
})

describe('placementsBySessionOf', () => {
  it('折叠 placement 行为 sessionId -> parentSessionId 查找表', () => {
    const map = placementsBySessionOf([
      { sessionId: 'a', parentSessionId: 'p' },
      { sessionId: 'b' },
    ])
    expect(map.get('a')).toBe('p')
    expect(map.get('b')).toBeUndefined()
    expect(map.has('b')).toBe(true)
  })
})


/**
 * S3c Task 5: 关系图要显示子代理会话，轮播不要。
 *
 * 码头的 DAG 画子代理，而本插件的轮播刻意排除它们（决策记录 §4）。这里给
 * 同一份投影加一个开关，而**不是**另写一份——另写必然要重复实现「父不在
 * 集合内 → 提升为根」这条修复规则，两份实现迟早漂移（S3b 的 I2 就是同一
 * 类问题：官方头与紧凑头对已归档子会话口径不同）。
 */
describe('projectCarouselNodes — includeSubagents 开关（S3c Task 5）', () => {
  const input = {
    ids: ['A', 'sub'],
    summaryOf: (id: string) => (id === 'sub'
      ? { origin: 'subagent' as const, parentId: 'A' }
      : { origin: undefined, parentId: undefined }),
    placementsBySession: new Map<string, string | null | undefined>(),
  }

  it('默认仍然过滤掉子代理（轮播的现状不变）', () => {
    expect(projectCarouselNodes(input).map(n => n.sessionId)).toEqual(['A'])
  })

  it('开关打开后子代理在场，且父边正常解析', () => {
    const nodes = projectCarouselNodes({ ...input, includeSubagents: true })
    expect(nodes.map(n => n.sessionId)).toEqual(['A', 'sub'])
    expect(nodes.find(n => n.sessionId === 'sub')!.parentId).toBe('A')
  })

  /**
   * S3c 审查 I2：开关打开后必须把 `origin` 一并发出。
   *
   * `childrenOfLevel`（以及靠它的 `directChildrenOf` / `descendantsOf`——后者
   * 供级联归档用）是靠 `node.origin !== 'subagent'` 兜底把子代理挡在轮播层级
   * 之外的。投影若不发这个字段，那道守卫在开关打开后直接失效，子代理会混进
   * 轮播的层级、甚至混进级联归档的集合。
   */
  it('开关打开后节点带上 origin，childrenOfLevel 的守卫仍然生效', () => {
    const nodes = projectCarouselNodes({ ...input, includeSubagents: true })
    expect(nodes.find(n => n.sessionId === 'sub')!.origin).toBe('subagent')
    expect(childrenOfLevel(nodes, 'A').map(n => n.sessionId)).toEqual([])
  })

  it('开关关闭时不发 origin（普通会话本来就没有这个字段）', () => {
    const nodes = projectCarouselNodes(input)
    expect('origin' in nodes[0]!).toBe(false)
  })

  it('开关打开也不影响已归档的排除（两个过滤条件互不相干）', () => {
    const nodes = projectCarouselNodes({ ...input, includeSubagents: true, archivedIds: ['sub'] })
    expect(nodes.map(n => n.sessionId)).toEqual(['A'])
  })
})
