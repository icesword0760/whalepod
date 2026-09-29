/**
 * 码头 `dag/DagCanvas.tsx` 里散落在组件体内的那几段变换数学，抽成纯函数后的对照
 * 测试。断言一律写死数字——这个文件的职责不是「变换大致对」，而是「和码头算出来
 * 的坐标一模一样」。
 *
 * 四处最容易写成「似是而非的正确」、在这里被单独钉住的地方：
 *
 * 1. **`zoomAt` 的不动点是指针，不是原点**（`DagCanvas.tsx:295-304`）。写成「只
 *    改 scale」在 scale = 1 → 2 时看着也会变大，但指针底下的那张卡会飞走。
 * 2. **`worldBoundsOf` 的 360/260 外扩是世界尺度的，加在除以 scale 之后**
 *    （`:40-45`）。写成「先加后除」在 scale = 1 时**完全等价**，只有非 1 缩放才
 *    露馅，所以每一条都配一个 scale ≠ 1 的用例。
 * 3. **`centerDepthOf` 的 centerWorldX 要除以 scale**（`:31-32`）。同上，scale = 1
 *    时看不出来。
 * 4. **「±1 层」不是静态的**（复核修正 4）：平移超过一列后，可见层跟**视口中心**走
 *    而不跟焦点走（`:34-36`）。漏掉这层，用户把画布拖出去之后满屏空白——所以这里
 *    专门有一个「preview 在第 4 列、视口停在第 0 列」的用例，正确实现必须给
 *    `[0, 1]`，跟着焦点走的实现会给 `[3, 4]`。
 */
import { describe, expect, it } from 'vitest'
import type { DagEdgeView, DagGraphView, DagNodeView } from '../src/client/dag/graph.ts'
import { layoutGraph } from '../src/client/dag/layout.ts'
import { centerWorldYOf,
  INITIAL_TRANSFORM,
  centerDepthOf,
  centerOnNode,
  clampDagScale,
  depthsAround,
  visibleDepthsFor,
  worldBoundsOf,
  zoomAt,
} from '../src/client/dag/viewport.ts'

/** 一个最小的 `DagNodeView`；这里只有布局用得上的字段是有意义的。 */
function node(sessionId: string, parent?: string): DagNodeView {
  return {
    sessionId,
    ...(parent === undefined ? {} : { parentSessionId: parent }),
    createdSeq: 0,
    title: sessionId,
    cwd: '',
    childCount: 0,
    lastActivityAt: 0,
    preview: '',
    hasNotice: false,
    subagent: false,
  }
}

/**
 * 一条 5 节点的链 → 5 列，每列一张 174 高的卡：
 * 列 x = 50 / 420 / 790 / 1160 / 1530，列心 x = 180 + 370 × depth。
 */
function chainLayout() {
  const nodes = ['n0', 'n1', 'n2', 'n3', 'n4'].map((id, index) => node(id, index === 0 ? undefined : `n${index - 1}`))
  const edges: DagEdgeView[] = nodes.flatMap((item) => item.parentSessionId === undefined ? [] : [{
    parentSessionId: item.parentSessionId, childSessionId: item.sessionId, relationKind: 'forked-from' as const,
  }])
  const graph: DagGraphView = { sceneId: 'scene:1', nodes, edges }
  return layoutGraph(graph)
}

/** 1000 宽的视口里，把世界坐标 `worldX` 摆到视口正中所需要的 `transform.x`（scale = 1）。 */
function panToWorldX(worldX: number): number {
  return 1000 / 2 - worldX
}

describe('clampDagScale', () => {
  it('把缩放夹在码头的 [0.4, 2] 里（DagCanvas.tsx:291-293）', () => {
    expect(clampDagScale(.3)).toBe(.4)
    expect(clampDagScale(2.5)).toBe(2)
    expect(clampDagScale(1)).toBe(1)
  })

  it('两个端点本身原样通过，不被夹进去一格', () => {
    expect(clampDagScale(.4)).toBe(.4)
    expect(clampDagScale(2)).toBe(2)
  })
})

describe('INITIAL_TRANSFORM', () => {
  it('是码头的 { x: 70, y: 40, scale: 1 }，不是原点（DagCanvas.tsx:23,106-111）', () => {
    expect(INITIAL_TRANSFORM).toEqual({ x: 70, y: 40, scale: 1 })
  })
})

describe('zoomAt', () => {
  const start = { x: 70, y: 40, scale: 1 }
  const pointer = { x: 500, y: 300 }

  it('以指针为不动点换算（DagCanvas.tsx:295-304）', () => {
    // worldX = (500 − 70) / 1 = 430，worldY = (300 − 40) / 1 = 260
    // x = 500 − 430 × 2 = −360，y = 300 − 260 × 2 = −220
    expect(zoomAt(start, 2, pointer)).toEqual({ x: -360, y: -220, scale: 2 })
  })

  it('指针底下的那个世界坐标缩放前后不变', () => {
    const next = zoomAt(start, 1.7, pointer)
    expect((pointer.x - next.x) / next.scale).toBeCloseTo((pointer.x - start.x) / start.scale, 10)
    expect((pointer.y - next.y) / next.scale).toBeCloseTo((pointer.y - start.y) / start.scale, 10)
  })

  it('先夹 scale 再换算：超范围的目标缩放等价于夹住后的那次缩放', () => {
    expect(zoomAt(start, 5, pointer)).toEqual(zoomAt(start, 2, pointer))
    expect(zoomAt(start, .1, pointer)).toEqual(zoomAt(start, .4, pointer))
    expect(zoomAt(start, 5, pointer).scale).toBe(2)
  })

  it('从非 1 的缩放继续缩放也对（不动点用的是旧 scale）', () => {
    // worldX = (500 − (−360)) / 2 = 430，回到 scale 1 应当正好还原成 x = 70
    expect(zoomAt({ x: -360, y: -220, scale: 2 }, 1, pointer)).toEqual({ x: 70, y: 40, scale: 1 })
  })
})

describe('centerOnNode', () => {
  const box = { x: 50, y: 159, width: 260, height: 174 }

  it('把节点中心放到视口中心（DagCanvas.tsx:99-100）', () => {
    // 中心 (180, 246)；x = 500 − 180 = 320，y = 350 − 246 = 104
    expect(centerOnNode({ x: 0, y: 0, scale: 1 }, box, 1000, 700)).toEqual({ x: 320, y: 104, scale: 1 })
  })

  it('scale ≠ 1 时按当前 scale 换算，且不改动 scale', () => {
    // x = 500 − 180 × 2 = 140，y = 350 − 246 × 2 = −142
    expect(centerOnNode({ x: 999, y: 999, scale: 2 }, box, 1000, 700)).toEqual({ x: 140, y: -142, scale: 2 })
  })

  it('居中之后，节点中心投影到屏幕上正好落在视口正中', () => {
    for (const scale of [.4, 1, 1.75, 2]) {
      const next = centerOnNode({ x: 12, y: -34, scale }, box, 1200, 800)
      expect((box.x + box.width / 2) * next.scale + next.x).toBeCloseTo(600, 10)
      expect((box.y + box.height / 2) * next.scale + next.y).toBeCloseTo(400, 10)
    }
  })
})

describe('worldBoundsOf', () => {
  it('四条边都含码头的外扩量：左右各 360、上下各 260（DagCanvas.tsx:40-45）', () => {
    expect(worldBoundsOf({ x: 70, y: 40, scale: 1 }, 1000, 700)).toEqual({
      left: -430, // −70 − 360
      right: 1290, // (1000 − 70) + 360
      top: -300, // −40 − 260
      bottom: 920, // (700 − 40) + 260
    })
  })

  it('外扩量是世界尺度的：先除以 scale 再加，不是先加再除', () => {
    // 若写成 (−70 − 360) / 2 = −215 就错了；正确是 −70 / 2 − 360 = −395
    expect(worldBoundsOf({ x: 70, y: 40, scale: 2 }, 1000, 700)).toEqual({
      left: -395,
      right: 825, // (1000 − 70) / 2 + 360
      top: -280, // −40 / 2 − 260
      bottom: 590, // (700 − 40) / 2 + 260
    })
  })

  it('缩小时可见世界更宽（外扩量不随 scale 放大）', () => {
    const bounds = worldBoundsOf({ x: 0, y: 0, scale: .5 }, 1000, 700)
    expect(bounds).toEqual({ left: -360, right: 2360, top: -260, bottom: 1660 })
  })
})

describe('centerDepthOf', () => {
  it('平移到第 3 列时给出 depth 2（DagCanvas.tsx:31-32）', () => {
    // 第 3 列（depth 2）列心世界 x = 180 + 740 = 920
    expect(centerDepthOf({ x: panToWorldX(920), y: 0, scale: 1 }, 1000, 5)).toBe(2)
  })

  it('每一列的列心都落在自己那一格上', () => {
    for (const depth of [0, 1, 2, 3, 4]) {
      expect(centerDepthOf({ x: panToWorldX(180 + 370 * depth), y: 0, scale: 1 }, 1000, 5)).toBe(depth)
    }
  })

  it('越界的结果被夹回 [0, depthCount − 1]', () => {
    expect(centerDepthOf({ x: panToWorldX(920), y: 0, scale: 1 }, 1000, 2)).toBe(1)
    expect(centerDepthOf({ x: 5000, y: 0, scale: 1 }, 1000, 5)).toBe(0)
    expect(centerDepthOf({ x: -99999, y: 0, scale: 1 }, 1000, 5)).toBe(4)
  })

  it('centerWorldX 要除以 scale：放大两倍后同样的 x 落在更靠左的列上', () => {
    // scale 2、x = 0 → centerWorldX = 500 / 2 = 250 → round((250 − 50) / 370) = 1
    expect(centerDepthOf({ x: 0, y: 0, scale: 2 }, 1000, 5)).toBe(1)
    // 同样的 x 在 scale 1 下 → centerWorldX = 500 → round(450 / 370) = 1... 用更大的视口拉开差距
    expect(centerDepthOf({ x: 0, y: 0, scale: 1 }, 2000, 5)).toBe(3)
    expect(centerDepthOf({ x: 0, y: 0, scale: 2 }, 2000, 5)).toBe(1)
  })
})

describe('depthsAround', () => {
  it('给出 [c − 1, c, c + 1] 并裁掉越界（DagCanvas.tsx:337-340）', () => {
    expect(depthsAround(2, 5)).toEqual([1, 2, 3])
  })

  it('depth 0 时只给 [0, 1]，末列时只给最后两列', () => {
    expect(depthsAround(0, 5)).toEqual([0, 1])
    expect(depthsAround(4, 5)).toEqual([3, 4])
  })

  it('只有一列时只给 [0]', () => {
    expect(depthsAround(0, 1)).toEqual([0])
  })
})

describe('visibleDepthsFor', () => {
  const layout = chainLayout()

  it('前提：这条链确实是 5 列', () => {
    expect(layout.depthCount).toBe(5)
    expect(layout.nodeById.get('n4')?.depth).toBe(4)
  })

  it('视口没走远时跟焦点走（DagCanvas.tsx:34-36 的 else 分支）', () => {
    // 视口中心停在 depth 0，preview 也在 depth 0 → visibleLayers 的 ±1 层
    expect(visibleDepthsFor(layout, 'n0', { x: panToWorldX(180), y: 0, scale: 1 }, 1000)).toEqual([0, 1])
    // 差一列仍然算「没走远」（判据是 > 1，不是 >= 1）
    expect(visibleDepthsFor(layout, 'n0', { x: panToWorldX(550), y: 0, scale: 1 }, 1000)).toEqual([0, 1])
  })

  it('平移超过一列后改跟视口中心走，而不是跟焦点走（复核修正 4）', () => {
    // preview 仍在 depth 0，但视口中心已经到了 depth 2 → 围绕 2 而不是围绕 0
    expect(visibleDepthsFor(layout, 'n0', { x: panToWorldX(920), y: 0, scale: 1 }, 1000)).toEqual([1, 2, 3])
    // 拖到最右一列 → [3, 4]；跟着焦点走的实现会给 [0, 1]，画面全空
    expect(visibleDepthsFor(layout, 'n0', { x: panToWorldX(1660), y: 0, scale: 1 }, 1000)).toEqual([3, 4])
  })

  it('反方向同样成立：焦点在末列而视口停在首列时，给的是首列附近', () => {
    expect(visibleDepthsFor(layout, 'n4', { x: panToWorldX(180), y: 0, scale: 1 }, 1000)).toEqual([0, 1])
  })

  it('焦点不在图里时退回 depth 0，与 visibleLayers 的兜底一致', () => {
    expect(visibleDepthsFor(layout, 'missing', { x: panToWorldX(180), y: 0, scale: 1 }, 1000)).toEqual([0, 1])
  })

  it('缩放参与判定：放大后视口中心落在 depth 1，焦点在 depth 4 → 围绕 1', () => {
    expect(visibleDepthsFor(layout, 'n4', { x: 0, y: 0, scale: 2 }, 1000)).toEqual([0, 1, 2])
  })

  it('返回的层号总是升序且都在 [0, depthCount) 内', () => {
    for (const x of [2000, 500, 0, -500, -2000, -5000]) {
      const depths = visibleDepthsFor(layout, 'n2', { x, y: 0, scale: 1 }, 1000)
      expect(depths).toEqual([...depths].sort((left, right) => left - right))
      expect(depths.every((depth) => depth >= 0 && depth < layout.depthCount)).toBe(true)
      expect(depths.length).toBeGreaterThan(0)
    }
  })
})


/**
 * S4 审查 D-1：这条算式此前内联在 `DagCanvas.tsx` 里，是本模块六个算式中
 * 唯一没有单测的一条——审查把它改成 `viewportHeight / 2`（丢掉平移与缩放
 * 两项），画布那 40 条用例一条都不响。jsdom 里视口高恒为回退值、测试也没
 * 纵向拖远过，所以变异抓不到。症状是纵向拖远后聚合卡借错成员的位置、预算
 * 紧张时真实卡排序偏掉——纯视觉，不报错。
 */
describe('centerWorldYOf', () => {
  it('未平移未缩放时就是视口高的一半', () => {
    expect(centerWorldYOf({ x: 0, y: 0, scale: 1 }, 700)).toBe(350)
  })

  it('平移要减掉：向下拖 100，世界中心相应上移', () => {
    expect(centerWorldYOf({ x: 0, y: 100, scale: 1 }, 700)).toBe(250)
  })

  it('缩放要除掉：放大 2 倍时同一块视口只覆盖一半的世界高度', () => {
    expect(centerWorldYOf({ x: 0, y: 0, scale: 2 }, 700)).toBe(175)
  })

  /**
   * 平移与缩放同时存在时才分得出「先减后除」和「先除后减」——这正是
   * `worldBoundsOf` 的 360/260 那条注释里点名的、在 100% 缩放下完全等价、
   * 只有缩放后才露馅的一类错误。
   */
  it('平移与缩放同时存在时，是先减平移再除缩放', () => {
    expect(centerWorldYOf({ x: 0, y: 100, scale: 2 }, 700)).toBe(125)
    // 先除后减会得到 250；先减后除得到 125
    expect(centerWorldYOf({ x: 0, y: 100, scale: 2 }, 700)).not.toBe(250)
  })

  it('横向平移不参与（它是 centerDepthOf 的事）', () => {
    expect(centerWorldYOf({ x: -9999, y: 40, scale: 1 }, 700)).toBe(310)
  })
})
