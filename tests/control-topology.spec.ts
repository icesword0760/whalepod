/**
 * S7 Task 2 — the control plane's topology projection.
 *
 * The load-bearing test in here is 「同源断言」: the host-side projection and
 * the carousel the user is looking at must produce the SAME in-level order,
 * because 设计稿 §「排序键是一等公民」 makes it a hard precondition that
 * 「AI 说『第 3 个会话』必须与用户看到的第 3 个一致」. The only way to keep
 * that true across future edits is to prove both sides run the same functions
 * — so the fixture below is deliberately built so that any hand-rolled sort
 * (raw `updatedAt DESC`, or placement order alone) produces a different answer.
 */
import { describe, expect, it } from 'vitest'
import { childrenOfLevel } from '../src/client/carousel/graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from '../src/client/carousel/nodes.ts'
import { deriveOrgView } from '../src/client/org/derive.ts'
import { selectKnownSessionIds } from '../src/client/workbench/known-sessions.ts'
import { defaultSceneId, defaultTaskId } from '../src/org/model.ts'
import type { MatouOrgState, MatouPlacement } from '../src/org/model.ts'
import { childrenOf, controlRefOf, levelOf, projectControlTargets } from '../src/control/topology.ts'
import type { ControlSessionFacts, ControlTarget } from '../src/control/topology.ts'

const WORKSPACE_ID = 'ws1'
const DEFAULT_TASK_ID = defaultTaskId(WORKSPACE_ID)
const DEFAULT_SCENE_ID = defaultSceneId(DEFAULT_TASK_ID)

/**
 * Every session the host's `SessionController.list()` would report, with only
 * the fields the projection reads. `updatedAt` and the placement sort keys are
 * chosen so the three sort keys disagree with each other:
 * - `gamma` carries the LARGEST `updatedAt` but is blank → must land rightmost;
 * - `orphan` and `alpha` tie on `updatedAt` → broken by placement order;
 * - `placedChild` sorts before `child1` on recency although it was placed later.
 */
const FACTS: Record<string, ControlSessionFacts> = {
  alpha: { updatedAt: 300, running: true, cwd: '/repo/alpha', title: 'Alpha' },
  beta: { updatedAt: 500, running: false, title: 'Beta' },
  orphan: { updatedAt: 300, parentId: 'archivedOne', title: 'Orphan' },
  peer: { updatedAt: 200, parentId: 'alpha', title: 'Peer' },
  gamma: { updatedAt: 900, blank: true, title: 'Gamma' },
  child1: { updatedAt: 100, parentId: 'alpha', title: 'Child One' },
  placedChild: { updatedAt: 400, title: 'Placed Child' },
  crossed: { updatedAt: 80, parentId: 'alpha', title: 'Crossed' },
  loose: { updatedAt: 50, title: 'Loose' },
  sub: { updatedAt: 700, origin: 'subagent', parentId: 'alpha', title: 'Sub' },
  archivedOne: { updatedAt: 600, title: 'Archived' },
  blankUnplaced: { updatedAt: 1000, blank: true, title: 'Blank Unplaced' },
}

const ARCHIVED: readonly string[] = ['archivedOne']

const WORKSPACES = [{
  workspaceId: WORKSPACE_ID,
  title: '工作区一',
  sessionIds: [
    'beta', 'orphan', 'alpha', 'peer', 'gamma', 'child1', 'placedChild',
    'crossed', 'loose', 'sub', 'archivedOne', 'blankUnplaced',
  ],
}]

function placement(row: Omit<MatouPlacement, 'taskId' | 'sceneId' | 'updatedAt'>): MatouPlacement {
  return { taskId: 't1', sceneId: 's1', updatedAt: 0, ...row }
}

const ORG: MatouOrgState = {
  tasks: [{
    id: 't1', workspaceId: WORKSPACE_ID, title: '事项一',
    status: 'active', isPinned: false, sortKey: 1, createdAt: 0, updatedAt: 0,
  }],
  scenes: [{ id: 's1', taskId: 't1', name: '页签一', titlePinned: false, sortKey: 1, createdAt: 0, updatedAt: 0 }],
  // 落位序刻意与近因序完全相反：根层落位序是 gamma → peer → orphan → alpha →
  // beta，而正确的层内顺序是 beta → orphan → alpha → peer → gamma。任何「照落位
  // 序排」的实现都会当场露馅。
  placements: [
    placement({ sessionId: 'gamma', sortKey: 1 }),
    placement({ sessionId: 'archivedOne', sortKey: 3 }),
    // 平级 Fork of a ROOT session: DSH records `parentId: 'alpha'` (the session
    // it copied state from) while the placement says 「就在根层」.
    placement({ sessionId: 'peer', explicitRoot: true, sortKey: 5 }),
    // orphan 与 alpha 近因相同（300），落位序在此分胜负。
    placement({ sessionId: 'orphan', sortKey: 8 }),
    placement({ sessionId: 'alpha', sortKey: 10 }),
    placement({ sessionId: 'beta', sortKey: 20 }),
    // No `parentSessionId` at all → falls back to DSH's own `parentId`.
    placement({ sessionId: 'child1', sortKey: 30 }),
    placement({ sessionId: 'placedChild', parentSessionId: 'alpha', sortKey: 40 }),
    // Placement parent OUTRANKS DSH's own parent link.
    placement({ sessionId: 'crossed', parentSessionId: 'beta', sortKey: 50 }),
    placement({ sessionId: 'sub', sortKey: 60 }),
  ],
}

function project(overrides: Partial<Parameters<typeof projectControlTargets>[0]> = {}): readonly ControlTarget[] {
  return projectControlTargets({
    workspaces: WORKSPACES,
    summaryOf: (id: string) => FACTS[id],
    archivedSessionIds: ARCHIVED,
    org: ORG,
    ...overrides,
  })
}

function idsOf(targets: readonly ControlTarget[]): string[] {
  return targets.map(target => target.sessionId)
}

function targetOf(targets: readonly ControlTarget[], sessionId: string): ControlTarget {
  const found = targets.find(target => target.sessionId === sessionId)
  if (found === undefined) throw new Error(`no target for ${sessionId}`)
  return found
}

/**
 * The CLIENT pipeline, wired exactly as `useWorkbenchView.ts:51-61` and
 * `AppFrame.tsx:216-226` wire it. Anything the host projection does differently
 * shows up as an order mismatch in the 同源断言 below.
 */
function clientNodesOfScene(sceneId: string) {
  const knownSessionIds = selectKnownSessionIds({
    ids: WORKSPACES.flatMap(workspace => workspace.sessionIds),
    summaryOf: (id: string) => {
      const facts = FACTS[id]
      return facts === undefined ? undefined : { blank: facts.blank === true, origin: facts.origin }
    },
    archivedIds: ARCHIVED,
    currentId: undefined,
    org: ORG,
  })
  const view = deriveOrgView({ workspaces: WORKSPACES, knownSessionIds, org: ORG })
  const scene = view.flatMap(workspace => workspace.tasks)
    .flatMap(task => task.scenes)
    .find(candidate => candidate.id === sceneId)
  if (scene === undefined) throw new Error(`no scene ${sceneId}`)
  const ordinals = new Map(scene.sessions.map(ref => [ref.sessionId, ref.ordinal]))
  return projectCarouselNodes({
    ids: scene.sessions.map(ref => ref.sessionId),
    summaryOf: (id: string) => FACTS[id],
    placementsBySession: placementsBySessionOf(ORG.placements),
    archivedIds: ARCHIVED,
    ordinalOf: (id: string) => ordinals.get(id) ?? 0,
  })
}

describe('projectControlTargets — 同源断言（与轮播共用同一份排序真相）', () => {
  it('根层顺序与客户端 childrenOfLevel(projectCarouselNodes(...), undefined) 逐 id 相等', () => {
    const clientOrder = childrenOfLevel(clientNodesOfScene('s1'), undefined).map(node => node.sessionId)
    expect(idsOf(levelOf(project(), 'alpha'))).toEqual(clientOrder)
    // 钉死具体顺序：任何「按 updatedAt 直接排」的实现都会把 gamma 排到最前。
    expect(clientOrder).toEqual(['beta', 'orphan', 'alpha', 'peer', 'gamma'])
  })

  it('子层顺序同样逐 id 相等（落位序更晚的 placedChild 因近因更新排在 child1 之前）', () => {
    const clientOrder = childrenOfLevel(clientNodesOfScene('s1'), 'alpha').map(node => node.sessionId)
    expect(idsOf(childrenOf(project(), 'alpha'))).toEqual(clientOrder)
    expect(clientOrder).toEqual(['placedChild', 'child1'])
  })
})

describe('projectControlTargets — 排序键', () => {
  it('空白会话记 0 次交互，落到本层最右（即便 updatedAt 最大）', () => {
    const level = idsOf(levelOf(project(), 'beta'))
    expect(level.at(-1)).toBe('gamma')
    expect(targetOf(project(), 'gamma').blank).toBe(true)
  })

  it('近因相同时按落位序 ASC 断（orphan 落位早于 alpha）', () => {
    const level = idsOf(levelOf(project(), 'alpha'))
    expect(level.indexOf('orphan')).toBeLessThan(level.indexOf('alpha'))
  })

  /**
   * `orderSiblings` 的第三把钥匙（sessionId ASC）在本投影里够不着——落位序对
   * 同一页签内的每个会话都是唯一的（`deriveOrgView` 逐一发号），所以第二把钥匙
   * 永远先分出胜负。这条用例钉的是「第二把钥匙确实是落位序、而不是 id、也不是
   * 工作区顺序」：同一对会话，只把落位序前后对调，结果就跟着翻，而 id 顺序始终
   * 不变。
   */
  it('近因相同时按落位序 ASC 断，两个方向都跟着落位序翻（不是 id、不是工作区顺序）', () => {
    const facts: Record<string, ControlSessionFacts> = {
      zeta: { updatedAt: 42, title: 'Z' }, aleph: { updatedAt: 42, title: 'A' },
    }
    const order = (zetaSortKey: number, alephSortKey: number): string[] => idsOf(projectControlTargets({
      // 工作区顺序固定为 zeta 在前，好让它无法解释结果的翻转。
      workspaces: [{ workspaceId: WORKSPACE_ID, title: 'w', sessionIds: ['zeta', 'aleph'] }],
      summaryOf: (id: string) => facts[id],
      archivedSessionIds: [],
      org: {
        tasks: ORG.tasks, scenes: ORG.scenes,
        placements: [
          placement({ sessionId: 'zeta', sortKey: zetaSortKey }),
          placement({ sessionId: 'aleph', sortKey: alephSortKey }),
        ],
      },
    }))
    expect(order(20, 10)).toEqual(['aleph', 'zeta'])
    expect(order(10, 20)).toEqual(['zeta', 'aleph'])
  })

  it('层内序号 levelOrdinal 是 1-based 且与层顺序一致', () => {
    const targets = project()
    expect(levelOf(targets, 'alpha').map(target => target.levelOrdinal)).toEqual([1, 2, 3, 4, 5])
    expect(targetOf(targets, 'beta').levelOrdinal).toBe(1)
    expect(targetOf(targets, 'gamma').levelOrdinal).toBe(5)
    expect(targetOf(targets, 'placedChild').levelOrdinal).toBe(1)
    expect(targetOf(targets, 'child1').levelOrdinal).toBe(2)
  })
})

describe('projectControlTargets — MatouPlacement.parentSessionId 的三态', () => {
  it('字段缺席 → 回落 DSH 自己的 summary.parentId', () => {
    expect(targetOf(project(), 'child1').parentRef).toBe(controlRefOf('alpha'))
  })

  it('显式父 → 压过 DSH 的 parentId（crossed 的 DSH 父是 alpha，落位父是 beta）', () => {
    expect(targetOf(project(), 'crossed').parentRef).toBe(controlRefOf('beta'))
    expect(idsOf(childrenOf(project(), 'beta'))).toEqual(['crossed'])
  })

  it('explicitRoot（内存里的 null 态）→ 强制根层，不回落 DSH 的 parentId', () => {
    const targets = project()
    expect(targetOf(targets, 'peer').parentRef).toBeUndefined()
    expect(targetOf(targets, 'peer').depth).toBe(0)
    expect(idsOf(childrenOf(targets, 'alpha'))).not.toContain('peer')
  })
})

describe('projectControlTargets — 谁不在投影里', () => {
  it('子代理会话不出现在任何目标里（哪怕它有落位行）', () => {
    expect(idsOf(project())).not.toContain('sub')
  })

  it('已归档会话不出现', () => {
    expect(idsOf(project())).not.toContain('archivedOne')
  })

  /**
   * D-S7-2 的刻意分歧，**不是 bug**：`selectKnownSessionIds` 的可见规则里
   * 「空白会话在被选中时仍然可见」依赖客户端的 `currentId`，宿主没有这个
   * 概念，因此一律传 `undefined`。后果是「空白且未落位」的会话在轮播里
   * （用户正选着它时）看得见，控制面却寻址不到。无害——它没有任何内容可读、
   * 没有轮次可中断——但必须是显式行为，不许当成缺陷「修掉」。
   */
  it('空白且未落位的会话寻址不到（宿主没有 currentId 概念，刻意为之）', () => {
    expect(idsOf(project())).not.toContain('blankUnplaced')
  })

  it('summary 缺失的 id 直接丢弃（会话列表与组织文档不同步的瞬间）', () => {
    const targets = project({ summaryOf: (id: string) => (id === 'alpha' ? undefined : FACTS[id]) })
    expect(idsOf(targets)).not.toContain('alpha')
  })
})

describe('projectControlTargets — 父不在投影里的节点退回根层', () => {
  it('orphan 的父已归档，它自己仍是可寻址的根节点', () => {
    const targets = project()
    expect(targetOf(targets, 'orphan').parentRef).toBeUndefined()
    expect(targetOf(targets, 'orphan').depth).toBe(0)
    expect(idsOf(levelOf(targets, 'orphan'))).toContain('orphan')
  })
})

describe('projectControlTargets — 目标的形状', () => {
  it('ref 是 session:<sessionId>', () => {
    expect(targetOf(project(), 'alpha').ref).toBe('session:alpha')
    expect(controlRefOf('alpha')).toBe('session:alpha')
  })

  it('title / running / blank 照 summary 取，title 缺席回落空串', () => {
    const targets = project({ summaryOf: (id: string) => (id === 'beta' ? { updatedAt: 500 } : FACTS[id]) })
    expect(targetOf(targets, 'beta').title).toBe('')
    const normal = project()
    expect(targetOf(normal, 'alpha').title).toBe('Alpha')
    expect(targetOf(normal, 'alpha').running).toBe(true)
    expect(targetOf(normal, 'beta').running).toBe(false)
    expect(targetOf(normal, 'beta').blank).toBe(false)
  })

  it('cwd 缺席时整个字段省略，不产生 undefined 值', () => {
    const targets = project()
    expect(targetOf(targets, 'alpha').cwd).toBe('/repo/alpha')
    expect('cwd' in targetOf(targets, 'beta')).toBe(false)
    expect('parentRef' in targetOf(targets, 'beta')).toBe(false)
  })

  it('depth 与 childRefs：childRefs 按层内顺序给 ref', () => {
    const targets = project()
    expect(targetOf(targets, 'alpha').depth).toBe(0)
    expect(targetOf(targets, 'child1').depth).toBe(1)
    expect(targetOf(targets, 'alpha').childRefs).toEqual([controlRefOf('placedChild'), controlRefOf('child1')])
    expect(targetOf(targets, 'child1').childRefs).toEqual([])
  })
})

describe('projectControlTargets — 三级序号与 deriveOrgView 一致', () => {
  it('虚拟默认事项/页签也有序号，且排在存储事项之前', () => {
    const loose = targetOf(project(), 'loose')
    expect(loose.workspace).toEqual({ id: WORKSPACE_ID, title: '工作区一', ordinal: 1 })
    expect(loose.task).toEqual({ id: DEFAULT_TASK_ID, title: '默认', ordinal: 1 })
    expect(loose.scene).toEqual({ id: DEFAULT_SCENE_ID, name: '默认', ordinal: 1 })
  })

  it('存储事项/页签的序号与名称照 deriveOrgView 取', () => {
    const alpha = targetOf(project(), 'alpha')
    expect(alpha.task).toEqual({ id: 't1', title: '事项一', ordinal: 2 })
    expect(alpha.scene).toEqual({ id: 's1', name: '页签一', ordinal: 1 })
  })

  it('层的边界是「同页签 + 同有效父」——另一个页签的根节点不进同一层', () => {
    const org: MatouOrgState = {
      ...ORG,
      scenes: [
        ...ORG.scenes,
        { id: 's2', taskId: 't1', name: '页签二', titlePinned: false, sortKey: 2, createdAt: 0, updatedAt: 0 },
      ],
      placements: ORG.placements.map(row => (row.sessionId === 'beta' ? { ...row, sceneId: 's2' } : row)),
    }
    const targets = project({ org })
    expect(idsOf(levelOf(targets, 'alpha'))).not.toContain('beta')
    expect(targetOf(targets, 'beta').scene.id).toBe('s2')
    // 跨页签的落位父边也随之失效：crossed 的父 beta 不在它自己的页签里。
    expect(targetOf(targets, 'crossed').parentRef).toBeUndefined()
  })
})

describe('projectControlTargets — 整体数组顺序是确定的', () => {
  it('工作区 → 事项 → 页签 → depth → 层内序号 → sessionId（DSH 没有窗口维度）', () => {
    expect(idsOf(project())).toEqual([
      'loose',
      'beta', 'orphan', 'alpha', 'peer', 'gamma',
      'crossed', 'placedChild', 'child1',
    ])
  })

  it('两次调用同一输入得到同一顺序', () => {
    expect(idsOf(project())).toEqual(idsOf(project()))
  })
})

describe('projectControlTargets — 一个会话只产生一个目标', () => {
  /**
   * `deriveOrgView` 是逐条遍历 `workspace.sessionIds` 发号的，同一个 id 出现两次
   * 就会在同一页签里落两次、拿到两个不同的层内序号——`sibling:N` 一旦继承这种
   * 歧义，「第 N 个」就没有唯一答案了。
   */
  it('workspace.sessionIds 里重复的 id 只投影出一个目标', () => {
    const targets = projectControlTargets({
      workspaces: [{ workspaceId: WORKSPACE_ID, title: 'w', sessionIds: ['dup', 'dup', 'other'] }],
      summaryOf: (id: string) => ({ updatedAt: 1, title: id }),
      archivedSessionIds: [],
      org: { tasks: [], scenes: [], placements: [] },
    })
    expect(idsOf(targets)).toEqual(['dup', 'other'])
    expect(targets.map(target => target.levelOrdinal)).toEqual([1, 2])
  })
})

describe('projectControlTargets — 环（placement/set 对父边零校验，数据层允许）', () => {
  it('自指父的会话不出现，且不会无限递归', () => {
    const facts: Record<string, ControlSessionFacts> = { loop: { updatedAt: 1 }, root: { updatedAt: 2 } }
    const org: MatouOrgState = {
      tasks: [], scenes: [],
      placements: [
        { sessionId: 'loop', taskId: 't', sceneId: 's', parentSessionId: 'loop', sortKey: 1, updatedAt: 0 },
        { sessionId: 'root', taskId: 't', sceneId: 's', sortKey: 2, updatedAt: 0 },
      ],
    }
    const targets = projectControlTargets({
      workspaces: [{ workspaceId: WORKSPACE_ID, title: 'w', sessionIds: ['loop', 'root'] }],
      summaryOf: (id: string) => facts[id],
      archivedSessionIds: [],
      org,
    })
    expect(idsOf(targets)).toEqual(['root'])
  })

  it('互指父的两个会话都不出现（轮播里同样看不到它们，口径一致）', () => {
    const facts: Record<string, ControlSessionFacts> = { a: { updatedAt: 1 }, b: { updatedAt: 2 } }
    const org: MatouOrgState = {
      tasks: [], scenes: [],
      placements: [
        { sessionId: 'a', taskId: 't', sceneId: 's', parentSessionId: 'b', sortKey: 1, updatedAt: 0 },
        { sessionId: 'b', taskId: 't', sceneId: 's', parentSessionId: 'a', sortKey: 2, updatedAt: 0 },
      ],
    }
    const targets = projectControlTargets({
      workspaces: [{ workspaceId: WORKSPACE_ID, title: 'w', sessionIds: ['a', 'b'] }],
      summaryOf: (id: string) => facts[id],
      archivedSessionIds: [],
      org,
    })
    expect(idsOf(targets)).toEqual([])
    const clientNodes = projectCarouselNodes({
      ids: ['a', 'b'],
      summaryOf: (id: string) => facts[id],
      placementsBySession: placementsBySessionOf(org.placements),
    })
    expect(childrenOfLevel(clientNodes, undefined)).toEqual([])
  })
})

describe('levelOf / childrenOf', () => {
  it('levelOf 含调用者自身，按层内顺序返回', () => {
    expect(idsOf(levelOf(project(), 'gamma'))).toEqual(['beta', 'orphan', 'alpha', 'peer', 'gamma'])
  })

  it('levelOf 对不在投影里的会话返回空数组', () => {
    expect(levelOf(project(), 'sub')).toEqual([])
    expect(levelOf(project(), 'nobody')).toEqual([])
  })

  it('childrenOf 只给直接子，不给孙代', () => {
    const targets = project()
    expect(idsOf(childrenOf(targets, 'alpha'))).toEqual(['placedChild', 'child1'])
    expect(idsOf(childrenOf(targets, 'child1'))).toEqual([])
    expect(childrenOf(targets, 'nobody')).toEqual([])
  })
})
