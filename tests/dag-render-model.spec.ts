/**
 * 码头 `dag/dag-render-model.ts` 的移植：把「整张布局」裁成「这一屏真正要画的
 * 东西」——近处的真实卡片 + 远层折叠成的聚合卡 + 两端都还在场的边。
 *
 * 三个最容易写错、在这里被单独钉死的地方：
 *
 * 1. **400 是真实节点与聚合卡的「合计」上限，不是各自 400**
 *    （`dag-render-model.ts:82-85`）。有远层时还要**先预留一个槽位给聚合卡**，
 *    所以 `maxItems = 3` + 有远层 ⇒ 真实节点最多 2 张。
 * 2. **守恒的是 `sessionCount`，不是三栏计数之和**（复核修正 2）。空闲会话计入
 *    `sessionCount` 却哪一栏都不进，所以断言只能写 `running + waiting + done
 *    ≤ sessionCount`；写等号必然失败。
 * 3. **聚合卡摆在 `chooseTarget` 选中的那个成员的位置上**（`:209-217`）——是
 *    「边界层里离视口纵向中心最近的那一个」，不是分支根、不是第一个成员。
 *
 * 几何期望值全部是硬数字，来自已经跑绿的 `dag/layout.ts`（列 x = 50 + depth ×
 * 370，行距 26，基线高 174，列在全图最高列里垂直居中）。写死而不是从 layout 反
 * 查，是为了让「聚合卡贴着哪张卡」这件事在测试里一眼可读。
 */
import { describe, expect, it } from 'vitest'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { DagEdgeView, DagGraphView, DagNodeView } from '../src/client/dag/graph.ts'
import { layoutGraph, type DagLayout } from '../src/client/dag/layout.ts'
import {
  buildDagRenderModel, type DagRenderModel, type DagWorldBounds,
} from '../src/client/dag/render-model.ts'

interface NodeOptions {
  parent?: string
  state?: StateDotState
}

/** 一个最小的 `DagNodeView`；标题取 id（纯 ASCII 短串 ⇒ 每张卡都是基线高 174）。 */
function node(sessionId: string, options: NodeOptions = {}): DagNodeView {
  return {
    sessionId,
    ...(options.parent === undefined ? {} : { parentSessionId: options.parent }),
    createdSeq: 0,
    title: sessionId,
    cwd: '',
    ...(options.state === undefined ? {} : { state: options.state }),
    childCount: 0,
    lastActivityAt: 0,
    preview: '',
    hasNotice: false,
    subagent: false,
  }
}

/** 边按节点上的 `parentSessionId` 顺推，顺序与节点顺序一致（`maxEdges` 的截断用例依赖这个顺序）。 */
function graphOf(nodes: readonly DagNodeView[]): DagGraphView {
  return {
    sceneId: 'scene:1',
    nodes,
    edges: nodes.flatMap((item): DagEdgeView[] => item.parentSessionId === undefined ? [] : [{
      parentSessionId: item.parentSessionId, childSessionId: item.sessionId, relationKind: 'forked-from',
    }]),
  }
}

/** 一条直链：第 i 个的父是第 i−1 个，于是 depth 就是下标。 */
function chain(specs: readonly { id: string; state?: StateDotState }[]): DagLayout {
  return layoutGraph(graphOf(specs.map(({ id, state }, index) => node(id, {
    ...(index === 0 ? {} : { parent: specs[index - 1]!.id }),
    ...(state === undefined ? {} : { state }),
  }))))
}

/** 根 r + `branches` 条「r → 子 → 孙」的分支。孙的 id 是子的 id 加 `1`。 */
function fan(branches: readonly string[]): DagLayout {
  return layoutGraph(graphOf([
    node('r'),
    ...branches.map((id) => node(id, { parent: 'r' })),
    ...branches.map((id) => node(`${id}1`, { parent: id })),
  ]))
}

/** 大到能装下本文件多数夹具的世界视口，用在「不测裁剪」的用例里。 */
const WIDE: DagWorldBounds = { left: -1_000, right: 5_000, top: -1_000, bottom: 5_000 }

/** 上百张卡的列会长到几万甚至几十万 px 高，测默认上限的两个用例得把视口开到全图。 */
const HUGE: DagWorldBounds = { left: -1e7, right: 1e7, top: -1e7, bottom: 1e7 }

function render(layout: DagLayout, options: {
  depths: readonly number[]
  preview: string
  centerWorldY?: number
  worldBounds?: DagWorldBounds
  maxItems?: number
  maxEdges?: number
}): DagRenderModel {
  return buildDagRenderModel({
    layout,
    fullDepths: new Set(options.depths),
    worldBounds: options.worldBounds ?? WIDE,
    centerWorldY: options.centerWorldY ?? 137,
    previewSessionId: options.preview,
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
    ...(options.maxEdges === undefined ? {} : { maxEdges: options.maxEdges }),
  })
}

function idsOf(model: DagRenderModel): string[] {
  return model.realNodes.map(({ sessionId }) => sessionId)
}

function edgePairsOf(model: DagRenderModel): string[][] {
  return model.edges.map(({ fromSessionId, toSessionId }) => [fromSessionId, toSessionId])
}

describe('buildDagRenderModel 的空模型', () => {
  it('没有可见层时三个数组都是空的', () => {
    const model = render(chain([{ id: 'r' }, { id: 'a' }]), { depths: [], preview: 'r' })
    expect(model).toEqual({ realNodes: [], aggregates: [], edges: [] })
  })

  it('maxItems ≤ 0 时即便有可见层也什么都不画', () => {
    const model = render(chain([{ id: 'r' }, { id: 'a' }]), { depths: [0, 1], preview: 'r', maxItems: 0 })
    expect(model).toEqual({ realNodes: [], aggregates: [], edges: [] })
  })
})

describe('远层折叠成聚合卡', () => {
  /** r → a → b → c，可见层 [0,1]，于是 b、c 是「后方」远层。 */
  const layout = chain([{ id: 'r' }, { id: 'a' }, { id: 'b' }, { id: 'c' }])

  it('后方整条后代分支折成一张卡，卡贴在离可见区最近的那一层的成员上', () => {
    const [aggregate, ...rest] = render(layout, { depths: [0, 1], preview: 'r' }).aggregates
    expect(rest).toEqual([])
    expect(aggregate).toMatchObject({
      key: 'aggregate:after:b',
      kind: 'branch',
      direction: 'after',
      branchRootId: 'b',
      targetSessionId: 'b',
      sessionIds: ['b', 'c'],
      sessionCount: 2,
      minimumDepth: 2,
      maximumDepth: 3,
    })
    // b 的几何：depth 2 ⇒ x = 50 + 2 × 370 = 790；单节点列 ⇒ y = 50。
    expect([aggregate?.x, aggregate?.y, aggregate?.width, aggregate?.height]).toEqual([790, 50, 260, 174])
  })

  it('可见层里的节点仍是真实卡，且聚合卡替被折叠的那一端保住了边', () => {
    const model = render(layout, { depths: [0, 1], preview: 'r' })
    expect(idsOf(model)).toEqual(['r', 'a'])
    // a→b 保留（b 由聚合卡站位），b→c 两端都不在场被丢弃。
    expect(edgePairsOf(model)).toEqual([['r', 'a'], ['a', 'b']])
  })

  it('前方远层按「根」归并，聚合卡落在边界层里离视口纵向中心最近的成员上', () => {
    // r(depth0) → p、q(depth1)；p → x(depth2)。可见层只有 [2]。
    const forked = layoutGraph(graphOf([node('r'), node('p', { parent: 'r' }), node('q', { parent: 'r' }), node('x', { parent: 'p' })]))
    // centerWorldY 300 离 q 的中心 337 更近（|337−300| = 37 < |137−300| = 163）。
    const [aggregate, ...rest] = render(forked, { depths: [2], preview: 'x', centerWorldY: 300 }).aggregates
    expect(rest).toEqual([])
    expect(aggregate).toMatchObject({
      key: 'aggregate:before:r',
      kind: 'branch',
      direction: 'before',
      branchRootId: 'r',
      targetSessionId: 'q',
      sessionIds: ['r', 'p', 'q'],
      sessionCount: 3,
      minimumDepth: 0,
      maximumDepth: 1,
    })
    // 贴的是 q（depth1 的第二张卡，y = 50 + 174 + 26 = 250），不是分支根 r（y = 150）。
    expect([aggregate?.x, aggregate?.y]).toEqual([420, 250])
  })

  it('聚合卡只认边界层的成员，哪怕别的层里有离视口中心更近的一张', () => {
    const forked = layoutGraph(graphOf([node('r'), node('p', { parent: 'r' }), node('q', { parent: 'r' }), node('x', { parent: 'p' })]))
    // centerWorldY 237 正好是 r 的中心（距 0），比边界层的 p、q（各距 100）都近。
    // 但 r 在 depth 0，不是 before 组的边界层（depth 1），所以卡必须落在 p 上。
    const [aggregate] = render(forked, { depths: [2], preview: 'x', centerWorldY: 237 }).aggregates
    expect(aggregate?.targetSessionId).toBe('p')
    expect([aggregate?.x, aggregate?.y]).toEqual([420, 50])
  })

  it('每条远层分支各一张卡，所有卡的 sessionCount 之和等于远层节点总数', () => {
    const model = render(fan(['p', 'q', 's']), { depths: [0], preview: 'r', centerWorldY: 337 })
    // 卡的顺序按「离视口纵向中心近」：q 的中心正好是 337，p 与 s 各差 200 后按 key 定序。
    expect(model.aggregates.map(({ branchRootId }) => branchRootId)).toEqual(['q', 'p', 's'])
    expect(model.aggregates.reduce((sum, { sessionCount }) => sum + sessionCount, 0)).toBe(6)
    expect(model.aggregates.every(({ kind }) => kind === 'branch')).toBe(true)
  })
})

describe('聚合卡的三栏计数', () => {
  /** r → a → b(运行中) → c(等待输入) → d(已完成) → e(空闲) → f(出错)。可见层 [0,1]。 */
  const layout = chain([
    { id: 'r' }, { id: 'a' },
    { id: 'b', state: 'ongoing' }, { id: 'c', state: 'warning' }, { id: 'd', state: 'done' },
    { id: 'e' }, { id: 'f', state: 'error' },
  ])

  it('running / waiting / done 三栏按 state 分别计数', () => {
    const [aggregate] = render(layout, { depths: [0, 1], preview: 'r' }).aggregates
    expect(aggregate?.counts).toEqual({ running: 1, waiting: 1, done: 1 })
  })

  it('空闲与「出错」都不进任何一栏：三栏之和 < sessionCount', () => {
    const [aggregate] = render(layout, { depths: [0, 1], preview: 'r' }).aggregates
    const counts = aggregate?.counts ?? { running: 0, waiting: 0, done: 0 }
    const total = counts.running + counts.waiting + counts.done
    expect(aggregate?.sessionCount).toBe(5)
    expect(total).toBe(3)
    expect(total).toBeLessThan(aggregate?.sessionCount ?? 0)
    expect(total).toBeLessThanOrEqual(aggregate?.sessionCount ?? 0)
  })

  it('全员都有状态时三栏之和才取到 sessionCount 这个上界', () => {
    const dense = chain([
      { id: 'r' }, { id: 'a' },
      { id: 'b', state: 'ongoing' }, { id: 'c', state: 'warning' }, { id: 'd', state: 'done' }, { id: 'e', state: 'done' },
    ])
    const [aggregate] = render(dense, { depths: [0, 1], preview: 'r' }).aggregates
    const counts = aggregate?.counts ?? { running: 0, waiting: 0, done: 0 }
    expect(counts).toEqual({ running: 1, waiting: 1, done: 2 })
    expect(counts.running + counts.waiting + counts.done).toBe(aggregate?.sessionCount)
  })

  it('合并成 layer-overflow 的卡把各分支的三栏逐项相加', () => {
    const layered = layoutGraph(graphOf([
      node('r'),
      node('p', { parent: 'r', state: 'ongoing' }), node('q', { parent: 'r', state: 'warning' }),
      node('p1', { parent: 'p', state: 'done' }), node('q1', { parent: 'q' }),
    ]))
    const [aggregate, ...rest] = render(layered, { depths: [0], preview: 'r', maxItems: 1 }).aggregates
    expect(rest).toEqual([])
    expect(aggregate?.counts).toEqual({ running: 1, waiting: 1, done: 1 })
    expect(aggregate?.sessionCount).toBe(4)
  })
})

describe('400 项上限是真实节点与聚合卡的合计', () => {
  it('maxItems 3 且有远层时，先给聚合卡留一格，真实节点只剩 2 张', () => {
    // r → a → b → c → d → e，可见层 [0,1,2] 有三个候选，远层 [3,4,5] 一条分支。
    const layout = chain([{ id: 'r' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])
    const model = render(layout, { depths: [0, 1, 2], preview: 'r', maxItems: 3 })
    expect(idsOf(model)).toEqual(['r', 'a'])
    expect(model.aggregates).toHaveLength(1)
    expect(model.realNodes.length + model.aggregates.length).toBe(3)
  })

  it('没有远层时不预留槽位，真实节点吃满整个 maxItems', () => {
    const layout = chain([{ id: 'r' }, { id: 'a' }, { id: 'b' }])
    const model = render(layout, { depths: [0, 1, 2], preview: 'r', maxItems: 3 })
    expect(idsOf(model)).toEqual(['r', 'a', 'b'])
    expect(model.aggregates).toEqual([])
  })

  it('maxItems 1 时全部聚合并成一张 layer-overflow，key 带上深度区间', () => {
    const model = render(fan(['p', 'q']), { depths: [0], preview: 'r', maxItems: 1 })
    // 预算被聚合卡占满，真实节点一张都排不上——包括 preview 那张。
    expect(model.realNodes).toEqual([])
    expect(model.aggregates).toHaveLength(1)
    expect(model.aggregates[0]).toMatchObject({
      key: 'aggregate:after:layer-overflow:1-2',
      kind: 'layer-overflow',
      direction: 'after',
      branchRootId: 'layer:1-2',
      targetSessionId: 'p',
      sessionIds: ['p', 'p1', 'q', 'q1'],
      sessionCount: 4,
      minimumDepth: 1,
      maximumDepth: 2,
    })
    // 合并后的卡贴在离视口中心最近的那张卡上：p（y = 50，中心 137）而不是 q（中心 337）。
    expect([model.aggregates[0]?.x, model.aggregates[0]?.y]).toEqual([420, 50])
  })

  it('聚合预算 2、分支 3 条时，保留最近的一张、其余并成 layer-overflow', () => {
    const model = render(fan(['p', 'q', 's']), { depths: [0], preview: 'r', centerWorldY: 337, maxItems: 3 })
    expect(idsOf(model)).toEqual(['r'])
    expect(model.aggregates.map(({ key }) => key)).toEqual([
      'aggregate:after:q',
      'aggregate:after:layer-overflow:1-2',
    ])
    expect(model.aggregates.map(({ sessionCount }) => sessionCount)).toEqual([2, 4])
    // 守恒：折叠前 6 个远层节点，折叠后仍然是 6。
    expect(model.aggregates.reduce((sum, { sessionCount }) => sum + sessionCount, 0)).toBe(6)
    expect(model.aggregates[1]?.sessionIds).toEqual(['p', 'p1', 's', 's1'])
  })

  it('默认上限就是 400 项', () => {
    const many = Array.from({ length: 405 }, (_, index) => node(`n${String(index).padStart(3, '0')}`))
    const model = render(layoutGraph(graphOf(many)), { depths: [0], preview: 'n000', centerWorldY: 0, worldBounds: HUGE })
    expect(model.aggregates).toEqual([])
    expect(model.realNodes).toHaveLength(400)
  })
})

describe('视口裁剪、排序与边预算', () => {
  const layout = fan(['p', 'q', 's'])

  it('视口外的真实节点被裁掉，但 previewSessionId 那张永远在，且永远排第一', () => {
    // 只留 depth 2 那一列（x 790…1050）在视口里；preview 是 depth 0 的 r（x 50…310）。
    const model = render(layout, {
      depths: [0, 1, 2], preview: 'r', worldBounds: { left: 700, right: 1_200, top: -1_000, bottom: 5_000 },
    })
    expect(idsOf(model)).toEqual(['r', 'p1', 'q1', 's1'])
    expect(idsOf(model)).not.toContain('p')
  })

  it('其余真实节点按「离视口纵向中心近」排序', () => {
    const model = render(layout, { depths: [1], preview: 'q', centerWorldY: 537 })
    // q 是 preview 恒排第一；随后 s（中心 537，距 0）、p（中心 137，距 400）。
    expect(idsOf(model)).toEqual(['q', 's', 'p'])
  })

  it('卡片与视口只是「贴边」也算相交', () => {
    const touching = render(layout, {
      depths: [1], preview: 'q', centerWorldY: 337, worldBounds: { left: -1_000, right: 5_000, top: 224, bottom: 5_000 },
    })
    // p 占 y 50…224，下沿正好压在 top = 224 上。
    expect(idsOf(touching)).toEqual(['q', 'p', 's'])
    const clear = render(layout, {
      depths: [1], preview: 'q', centerWorldY: 337, worldBounds: { left: -1_000, right: 5_000, top: 225, bottom: 5_000 },
    })
    expect(idsOf(clear)).toEqual(['q', 's'])
  })

  it('一端不在场的边被丢弃', () => {
    const model = render(layout, {
      depths: [0, 1, 2], preview: 'r', worldBounds: { left: 700, right: 1_200, top: -1_000, bottom: 5_000 },
    })
    // 画出来的是 r 和三个孙节点，中间那一层一张都没有，于是没有一条边两端俱全。
    expect(model.edges).toEqual([])
  })

  it('maxEdges 截断，且截的是过滤之后的那一批', () => {
    expect(edgePairsOf(render(layout, { depths: [0, 1, 2], preview: 'r' }))).toHaveLength(6)
    const capped = render(layout, { depths: [0, 1, 2], preview: 'r', maxEdges: 2 })
    expect(edgePairsOf(capped)).toEqual([['r', 'p'], ['r', 'q']])
  })

  it('默认边上限就是 800', () => {
    const children = Array.from({ length: 801 }, (_, index) => node(`c${String(index).padStart(3, '0')}`, { parent: 'r' }))
    const star = layoutGraph(graphOf([node('r'), ...children]))
    const model = render(star, { depths: [0, 1], preview: 'r', centerWorldY: 0, worldBounds: HUGE, maxItems: 2_000 })
    expect(model.realNodes).toHaveLength(802)
    expect(model.edges).toHaveLength(800)
  })
})
