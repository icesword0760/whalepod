/**
 * 码头 `dag/dag-layout.ts` 的逐字移植（列宽 260 / 列间距 110 / 行距 26 / 基线高
 * 174 / 标题每行 18 个宽度单位）。每条断言都是硬数字：这个文件的职责不是"布局大
 * 致合理"，而是"和码头算出来的像素一模一样"，所以凡是能写死的坐标都写死。
 *
 * 三处最容易写错、在这里被单独钉住的地方：
 * 1. **卡片高度只由标题决定**，与正文预览、目录无关（`dag-layout.ts:122-126`）。
 * 2. **列内排序是纯创建序**，不是轮播那套「最近交互倒序」（`:151-154`）。
 * 3. **成环也要收敛**：历史数据里可能已经存在环，布局必须给出有限 depth 而不是
 *    转圈（`:49-52`）。
 */
import { describe, expect, it } from 'vitest'
import type { DagEdgeView, DagGraphView, DagNodeView } from '../src/client/dag/graph.ts'
import { layoutGraph, stableNodeOrder, visibleLayers } from '../src/client/dag/layout.ts'

interface NodeOptions {
  parent?: string
  createdSeq?: number
  title?: string
  preview?: string
  cwd?: string
  lastActivityAt?: number
}

/** 一个最小的 `DagNodeView`；每个用例只覆盖它关心的那几个字段。 */
function node(sessionId: string, options: NodeOptions = {}): DagNodeView {
  return {
    sessionId,
    ...(options.parent === undefined ? {} : { parentSessionId: options.parent }),
    createdSeq: options.createdSeq ?? 0,
    title: options.title ?? sessionId,
    cwd: options.cwd ?? '',
    childCount: 0,
    lastActivityAt: options.lastActivityAt ?? 0,
    preview: options.preview ?? '',
    hasNotice: false,
    subagent: false,
  }
}

/** 默认按节点上的 `parentSessionId` 顺推出边，需要指定种类或顺序时显式传 `edges`。 */
function graphOf(nodes: DagNodeView[], edges?: DagEdgeView[]): DagGraphView {
  return {
    sceneId: 'scene:1',
    nodes,
    edges: edges ?? nodes.flatMap((item): DagEdgeView[] => item.parentSessionId === undefined ? [] : [{
      parentSessionId: item.parentSessionId, childSessionId: item.sessionId, relationKind: 'forked-from',
    }]),
  }
}

/** 20 个 CJK 字 = 20 个宽度单位 → ceil(20 / 18) = 2 行 → 174 + 18 = 192。 */
const CJK_20 = '一二三四五六七八九十一二三四五六七八九十'

/**
 * 根 + 两个子会话。第一列 1 张卡（174），第二列两张（192 + 26 + 174 = 392），
 * 于是 `maxColumnHeight` = 392，第一列被垂直居中到 y = 50 + (392 − 174) / 2 = 159。
 */
function branchFixture(): DagGraphView {
  return graphOf([
    node('r', { title: 'R', createdSeq: 1 }),
    node('c2', { title: 'C2', parent: 'r', createdSeq: 2, lastActivityAt: 9_999 }),
    node('c1', { title: CJK_20, parent: 'r', createdSeq: 1, lastActivityAt: 1 }),
  ])
}

/** 一条 `length` 长的直链，depth 0…length−1，每张卡都是基线高 174。 */
function chainFixture(length: number): DagGraphView {
  return graphOf(Array.from({ length }, (_, index) => node(`d${index}`, {
    ...(index === 0 ? {} : { parent: `d${index - 1}` }), createdSeq: index + 1,
  })))
}

function heightOfTitle(title: string): number {
  return layoutGraph(graphOf([node('solo', { title })])).nodes[0]!.height
}

describe('layoutGraph 坐标与画布尺寸', () => {
  it('单节点落在 (50, 50)，尺寸 260 × 174，画布 360 × 274', () => {
    const layout = layoutGraph(graphOf([node('a', { title: 'A' })]))

    expect(layout.nodes).toHaveLength(1)
    expect(layout.nodes[0]).toMatchObject({ sessionId: 'a', depth: 0, x: 50, y: 50, width: 260, height: 174 })
    expect(layout.depthCount).toBe(1)
    expect(layout.width).toBe(360) // 100 + 1 × 260 + max(0, 0) × 110
    expect(layout.height).toBe(274) // 100 + 174
  })

  it('空图不抛错：depthCount 兜底 1，画布按基线高算', () => {
    const layout = layoutGraph(graphOf([]))

    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.depthCount).toBe(1)
    expect(layout.width).toBe(360)
    expect(layout.height).toBe(274)
  })

  it('列间距 370（260 + 110）：第 2 列 x = 420，第 5 列 x = 1530', () => {
    const layout = layoutGraph(chainFixture(5))

    expect(layout.nodes.map(({ x }) => x)).toEqual([50, 420, 790, 1160, 1530])
    expect(layout.nodes.map(({ depth }) => depth)).toEqual([0, 1, 2, 3, 4])
    expect(layout.depthCount).toBe(5)
    expect(layout.width).toBe(1840) // 100 + 5 × 260 + 4 × 110
    expect(layout.height).toBe(274) // 每列只有一张卡
  })

  it('同列相邻两张卡的 y 差 = 前一张的实际高 + 26（不是基线高 + 26）', () => {
    const layout = layoutGraph(branchFixture())
    const first = layout.nodeById.get('c1')!
    const second = layout.nodeById.get('c2')!

    expect(first.height).toBe(192)
    expect(first.y).toBe(50)
    expect(second.y).toBe(268)
    expect(second.y - first.y).toBe(first.height + 26)
  })

  it('短列在长列旁垂直居中：起始 y = 50 + (最高列高 − 本列高) / 2', () => {
    const layout = layoutGraph(branchFixture())

    // 第二列 192 + 26 + 174 = 392 是全图最高列；第一列只有 174。
    expect(layout.nodeById.get('r')!.y).toBe(159) // 50 + (392 − 174) / 2
    expect(layout.nodeById.get('c1')!.y).toBe(50) // 最高列自己不偏移
    expect(layout.height).toBe(492) // 100 + 392
    expect(layout.width).toBe(730) // 100 + 2 × 260 + 1 × 110
  })

  it('「最高列」是全图所有列一起比，不是只跟相邻列比', () => {
    // depth 0 一张卡（174），depth 1 一张卡（174），depth 2 三张卡（174 × 3 + 26 × 2 = 574）。
    const layout = layoutGraph(graphOf([
      node('a', { createdSeq: 1 }),
      node('b', { parent: 'a', createdSeq: 1 }),
      node('c1', { parent: 'b', createdSeq: 1 }),
      node('c2', { parent: 'b', createdSeq: 2 }),
      node('c3', { parent: 'b', createdSeq: 3 }),
    ]))

    expect(layout.height).toBe(674) // 100 + 574
    expect(layout.nodeById.get('a')!.y).toBe(250) // 50 + (574 − 174) / 2
    expect(layout.nodeById.get('b')!.y).toBe(250) // 中间那列同样按全图最高列居中
    expect(layout.nodeById.get('c1')!.y).toBe(50)
  })

  it('nodeById / nodesByDepth 与 nodes 是同一批对象，且按列分好组', () => {
    const layout = layoutGraph(branchFixture())

    expect(layout.nodeById.get('c1')).toBe(layout.nodes.find(({ sessionId }) => sessionId === 'c1'))
    expect(layout.nodesByDepth.get(0)!.map(({ sessionId }) => sessionId)).toEqual(['r'])
    expect(layout.nodesByDepth.get(1)!.map(({ sessionId }) => sessionId)).toEqual(['c1', 'c2'])
    expect(layout.nodesByDepth.get(2)).toBeUndefined()
  })

  it('原始 DagNodeView 原对象挂在 node 字段上，供渲染层取标题/状态/未读', () => {
    const original = node('a', { title: 'A' })
    const layout = layoutGraph(graphOf([original]))

    expect(layout.nodes[0]!.node).toBe(original)
  })
})

describe('nodeHeight：卡高只由标题宽度决定', () => {
  it('空标题也是 1 行（lines 至少为 1）', () => {
    expect(heightOfTitle('')).toBe(174)
  })

  it('ASCII 每字记 0.55：19 字 → 10.45 单位 → 1 行 → 174', () => {
    expect(heightOfTitle('a'.repeat(19))).toBe(174)
  })

  it('ASCII 的换行分界在 32/33 字之间（17.6 → 1 行，18.15 → 2 行）', () => {
    expect(heightOfTitle('a'.repeat(32))).toBe(174)
    expect(heightOfTitle('a'.repeat(33))).toBe(192)
  })

  it('CJK 每字记 1：18 字 → 1 行 → 174，19 字 → 2 行 → 192，20 字 → 192', () => {
    expect(heightOfTitle('中'.repeat(18))).toBe(174)
    expect(heightOfTitle('中'.repeat(19))).toBe(192)
    expect(heightOfTitle(CJK_20)).toBe(192)
  })

  it('每多一行加 18：37 个 CJK 字 → 3 行 → 210', () => {
    expect(heightOfTitle('中'.repeat(36))).toBe(192)
    expect(heightOfTitle('中'.repeat(37))).toBe(210)
  })

  it('中英混排按各自权重相加：17 中 + 1 英 = 17.55 → 1 行；18 中 + 1 英 = 18.55 → 2 行', () => {
    expect(heightOfTitle(`${'中'.repeat(17)}a`)).toBe(174)
    expect(heightOfTitle(`${'中'.repeat(18)}a`)).toBe(192)
  })

  it('全角标点与全角符号也算宽字符（\\uff01-\\uff60 与 \\uffe0-\\uffe6）', () => {
    expect(heightOfTitle('！'.repeat(19))).toBe(192)
    expect(heightOfTitle('￥'.repeat(19))).toBe(192)
    expect(heightOfTitle('\uf900'.repeat(19))).toBe(192) // \uf900 兼容汉字区首字
  })

  it('宽字符区间的下界是 \\u2e80：\\u2e7f 及以下按窄字符算', () => {
    expect(heightOfTitle('⺀'.repeat(19))).toBe(192)
    expect(heightOfTitle('⹿'.repeat(19))).toBe(174)
    expect(heightOfTitle('★'.repeat(19))).toBe(174) // ★，在下界之外
  })

  it('按码点而不是按 UTF-16 单元数：19 个 emoji 仍是 1 行', () => {
    expect(heightOfTitle('😀'.repeat(19))).toBe(174)
  })

  it('正文预览和目录再长也不改变卡高——高度只看标题', () => {
    const bare = node('a', { title: '短标题' })
    const stuffed = node('b', { title: '短标题', preview: 'x'.repeat(5_000), cwd: '/very/'.repeat(200) })
    const layout = layoutGraph(graphOf([bare, stuffed]))

    expect(layout.nodeById.get('a')!.height).toBe(174)
    expect(layout.nodeById.get('b')!.height).toBe(174)
  })
})

describe('layoutGraph 边端点', () => {
  it('从父卡右缘中点连到子卡左缘中点，并保留 graph.edges 的顺序与种类', () => {
    const layout = layoutGraph(branchFixture())

    expect(layout.edges).toEqual([
      {
        fromSessionId: 'r', toSessionId: 'c2', relationKind: 'forked-from',
        from: { x: 310, y: 246 }, // 50 + 260, 159 + 174 / 2
        to: { x: 420, y: 355 }, // 268 + 174 / 2
      },
      {
        fromSessionId: 'r', toSessionId: 'c1', relationKind: 'forked-from',
        from: { x: 310, y: 246 },
        to: { x: 420, y: 146 }, // 50 + 192 / 2
      },
    ])
  })

  it('derived-from 原样带出，布局不改写关系种类', () => {
    const layout = layoutGraph(graphOf(
      [node('a', { title: 'A' }), node('b', { title: 'B', parent: 'a' })],
      [{ parentSessionId: 'a', childSessionId: 'b', relationKind: 'derived-from' }],
    ))

    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0]!.relationKind).toBe('derived-from')
  })

  it('端点有一头不在节点集合里的边被丢掉，而不是画到 NaN 坐标', () => {
    const layout = layoutGraph(graphOf(
      [node('a', { title: 'A' }), node('b', { title: 'B', parent: 'a' })],
      [
        { parentSessionId: 'a', childSessionId: 'b', relationKind: 'forked-from' },
        { parentSessionId: 'a', childSessionId: 'ghost', relationKind: 'forked-from' },
        { parentSessionId: 'ghost', childSessionId: 'b', relationKind: 'forked-from' },
      ],
    ))

    expect(layout.edges.map(({ toSessionId }) => toSessionId)).toEqual(['b'])
  })
})

describe('depthFor：深度计算', () => {
  it('父不在图里时该节点自己就是根（depth 0），不被藏起来', () => {
    const layout = layoutGraph(graphOf([
      node('root', { createdSeq: 1 }),
      node('orphan', { parent: 'not-in-graph', createdSeq: 2 }),
      node('kid', { parent: 'orphan', createdSeq: 3 }),
    ]))

    expect(layout.nodeById.get('orphan')!.depth).toBe(0)
    expect(layout.nodeById.get('root')!.depth).toBe(0)
    expect(layout.nodeById.get('kid')!.depth).toBe(1)
  })

  it('两个互相指认的节点不死循环，都拿到有限 depth（历史数据里可能已有环）', () => {
    const layout = layoutGraph(graphOf([
      node('a', { parent: 'b', createdSeq: 1 }),
      node('b', { parent: 'a', createdSeq: 2 }),
    ]))

    const depths = layout.nodes.map(({ depth }) => depth)
    expect(depths.every(Number.isInteger)).toBe(true)
    // 码头的环处理：撞到 visiting 时把 baseDepth 归 0，再沿路径栈自底向上编号。
    expect(layout.nodeById.get('a')!.depth).toBe(2)
    expect(layout.nodeById.get('b')!.depth).toBe(1)
    expect(layout.depthCount).toBe(3)
  })

  it('3000 层的深链靠迭代 + 记忆化算完，不爆栈', () => {
    const layout = layoutGraph(chainFixture(3_000))

    expect(layout.nodes).toHaveLength(3_000)
    expect(layout.depthCount).toBe(3_000)
    expect(layout.nodeById.get('d2999')!.depth).toBe(2_999)
    expect(layout.nodeById.get('d2999')!.x).toBe(50 + 2_999 * 370)
  })
})

describe('stableNodeOrder：列内排序是纯创建序', () => {
  it('createdSeq 升序，与「最近交互倒序」和字典序都不一样', () => {
    // zz 建得早但很久没动，aa 建得晚却刚刚活跃；轮播的 orderSiblings 会把 aa 排前面。
    const stale = node('zz', { createdSeq: 1, lastActivityAt: 1 })
    const fresh = node('aa', { createdSeq: 2, lastActivityAt: 9_999 })

    expect([fresh, stale].sort(stableNodeOrder).map(({ sessionId }) => sessionId)).toEqual(['zz', 'aa'])
  })

  it('createdSeq 相等时按 sessionId 定序，保证同一份数据每次结果一样', () => {
    const later = node('b', { createdSeq: 5 })
    const earlier = node('a', { createdSeq: 5 })

    expect([later, earlier].sort(stableNodeOrder).map(({ sessionId }) => sessionId)).toEqual(['a', 'b'])
  })

  it('子代理的 MAX_SAFE_INTEGER 兜底把它沉到列尾，哪怕 id 排在前面', () => {
    const subagent = node('aaa-sub', { createdSeq: Number.MAX_SAFE_INTEGER })
    const placed = node('zzz', { createdSeq: 9_000_000 })

    expect([subagent, placed].sort(stableNodeOrder).map(({ sessionId }) => sessionId)).toEqual(['zzz', 'aaa-sub'])
  })

  it('列内摆放按同一把尺子，与 graph.nodes 的输入顺序无关', () => {
    const layout = layoutGraph(branchFixture())

    // 输入顺序是 c2、c1；createdSeq 是 c1 = 1、c2 = 2。
    expect(layout.nodesByDepth.get(1)!.map(({ sessionId }) => sessionId)).toEqual(['c1', 'c2'])
    expect(layout.nodeById.get('c1')!.y).toBeLessThan(layout.nodeById.get('c2')!.y)
  })
})

describe('visibleLayers：焦点前后各一层', () => {
  it('焦点在 depth 2 时给出 [1, 2, 3]，且不再返回码头那个没人消费的 ghostDepths', () => {
    const layout = layoutGraph(chainFixture(5))

    expect(visibleLayers(layout, 'd2')).toEqual({ fullDepths: [1, 2, 3] })
  })

  it('越界的一侧被裁掉：最后一列只剩 [3, 4]，第一列只剩 [0, 1]', () => {
    const layout = layoutGraph(chainFixture(5))

    expect(visibleLayers(layout, 'd4')).toEqual({ fullDepths: [3, 4] })
    expect(visibleLayers(layout, 'd0')).toEqual({ fullDepths: [0, 1] })
  })

  it('radius 可调：0 只留焦点那一列，大到超出层数就是全图', () => {
    const layout = layoutGraph(chainFixture(5))

    expect(visibleLayers(layout, 'd2', 0)).toEqual({ fullDepths: [2] })
    expect(visibleLayers(layout, 'd2', 2)).toEqual({ fullDepths: [0, 1, 2, 3, 4] })
    expect(visibleLayers(layout, 'd2', 10)).toEqual({ fullDepths: [0, 1, 2, 3, 4] })
  })

  it('焦点会话不在图里时按 depth 0 处理（浮层刚打开、焦点还没落位）', () => {
    const layout = layoutGraph(chainFixture(5))

    expect(visibleLayers(layout, 'not-here')).toEqual({ fullDepths: [0, 1] })
  })
})
