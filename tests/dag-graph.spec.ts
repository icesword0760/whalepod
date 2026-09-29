/**
 * The S4 DAG's one original adaptation: 码头 receives a ready-made
 * `SessionGraphView` from its Runtime, DSH has no such thing, and the obvious
 * substitute is wrong — `MatouSceneView.sessions` can NEVER contain a subagent
 * because `known-sessions.ts:24` drops `origin === 'subagent'` upstream of the
 * whole org derivation. So every rule that makes the graph a graph (which
 * sessions are nodes, which edge is which kind, what the card's body text is)
 * is asserted here rather than inherited from a port.
 */
import { describe, expect, it } from 'vitest'
import { buildDagGraph, lastTurnPreview, relationKindOf } from '../src/client/dag/graph.ts'
import type { DagGraphInput, DagPlacementFacts, DagSessionFacts } from '../src/client/dag/graph.ts'
import type { AgentNotification } from '../src/client/notifications/store.ts'

/** A DSH session list stand-in: ids in declaration order plus their narrowed facts. */
function listOf(entries: Record<string, DagSessionFacts>) {
  return {
    allSessionIds: Object.keys(entries),
    summaryOf: (id: string): DagSessionFacts | undefined => entries[id],
  }
}

/** `{ sessionId, ordinal }` refs the way `deriveOrgView` hands them over, 1-based like the real thing. */
function refs(...sessionIds: string[]) {
  return sessionIds.map((sessionId, index) => ({ sessionId, ordinal: index + 1 }))
}

function placementsOf(rows: Record<string, DagPlacementFacts>) {
  return (id: string): DagPlacementFacts | undefined => rows[id]
}

const RUNNING: DagSessionFacts = { running: true }
const IDLE: DagSessionFacts = { running: false }

/** Minimal input; every test overrides only what it is about. */
function inputOf(overrides: Partial<DagGraphInput> & Pick<DagGraphInput, 'sceneSessionRefs'>): DagGraphInput {
  return {
    sceneId: 'scene:1',
    allSessionIds: [],
    summaryOf: () => undefined,
    placementOf: () => undefined,
    untitledLabel: '未命名会话',
    ...overrides,
  }
}

function idsOf(graph: { nodes: readonly { sessionId: string }[] }): string[] {
  return graph.nodes.map(node => node.sessionId)
}

describe('buildDagGraph 节点集合', () => {
  it('空页签产出空图而不是抛错（冷启动、刚建的页签）', () => {
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: [] }))
    expect(graph).toEqual({ sceneId: 'scene:1', nodes: [], edges: [] })
  })

  it('种子集合排除已归档与查不到 summary 的引用', () => {
    const { allSessionIds, summaryOf } = listOf({ a: IDLE, gone: IDLE, b: IDLE })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a', 'gone', 'ghost', 'b'), allSessionIds, summaryOf, archivedIds: ['gone'],
    }))
    expect(idsOf(graph)).toEqual(['a', 'b'])
  })

  it('子代理不在页签的 sessions 里（known-sessions.ts:24 上游就剔了），必须从全量列表按血缘回捞', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE, sub: { running: false, origin: 'subagent', parentId: 'a' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['a', 'sub'])
    expect(graph.nodes.find(node => node.sessionId === 'sub')?.subagent).toBe(true)
    expect(graph.nodes.find(node => node.sessionId === 'a')?.subagent).toBe(false)
  })

  it('子代理的子代理（多级）整条链都进图，深链不止一跳', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE,
      sub1: { running: false, origin: 'subagent', parentId: 'a' },
      sub2: { running: false, origin: 'subagent', parentId: 'sub1' },
      sub3: { running: false, origin: 'subagent', parentId: 'sub2' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['a', 'sub1', 'sub2', 'sub3'])
    expect(graph.nodes.find(node => node.sessionId === 'sub3')?.parentSessionId).toBe('sub2')
  })

  it('别的页签的子代理不进本图（血缘走不到本页签的种子）', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE, other: IDLE, foreign: { running: false, origin: 'subagent', parentId: 'other' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['a'])
  })

  it('别的页签那个会话即使是从本页签 Fork 出去的，它的子代理也不算本图的（链上必须一路是子代理）', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE,
      // 另一个页签里的会话，DSH 记的 parentId 正是它复制状态的 a——但它本人不在本页签。
      other: { running: false, parentId: 'a' },
      foreign: { running: false, origin: 'subagent', parentId: 'other' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['a'])
  })

  it('链中间那一环查不到 summary 时整条链都不进图', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE, sub2: { running: false, origin: 'subagent', parentId: 'missing' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['a'])
  })

  it('链中间那一环已归档时整条链都不进图（归档会话本身就不在图里）', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE,
      sub1: { running: false, origin: 'subagent', parentId: 'a' },
      sub2: { running: false, origin: 'subagent', parentId: 'sub1' },
    })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a'), allSessionIds, summaryOf, archivedIds: ['sub1'],
    }))
    expect(idsOf(graph)).toEqual(['a'])
  })

  it('血缘成环时不死循环，且成环的那条链不进图', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE,
      loop1: { running: false, origin: 'subagent', parentId: 'loop2' },
      loop2: { running: false, origin: 'subagent', parentId: 'loop1' },
      selfLoop: { running: false, origin: 'subagent', parentId: 'selfLoop' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['a'])
  })

  it('已归档的子代理自己也不进图', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE, sub: { running: false, origin: 'subagent', parentId: 'a' },
    })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a'), allSessionIds, summaryOf, archivedIds: ['sub'],
    }))
    expect(idsOf(graph)).toEqual(['a'])
  })
})

describe('buildDagGraph 父边解析', () => {
  it('placement 的父压过 DSH 自己的 parentId（与 carousel/graph.ts:47-49 同序）', () => {
    const { allSessionIds, summaryOf } = listOf({ p: IDLE, q: IDLE, c: { running: false, parentId: 'p' } })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('p', 'q', 'c'),
      allSessionIds,
      summaryOf,
      placementOf: placementsOf({ c: { parentSessionId: 'q' } }),
    }))
    expect(graph.nodes.find(node => node.sessionId === 'c')?.parentSessionId).toBe('q')
  })

  it('placement 显式说「就在根层」时不回落 DSH parentId（平级 Fork 的正确性所系）', () => {
    const { allSessionIds, summaryOf } = listOf({ a: IDLE, peer: { running: false, parentId: 'a' } })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a', 'peer'),
      allSessionIds,
      summaryOf,
      placementOf: placementsOf({ peer: { explicitRoot: true } }),
    }))
    expect(graph.nodes.find(node => node.sessionId === 'peer')?.parentSessionId).toBeUndefined()
    expect(graph.edges).toEqual([])
  })

  it('解析出的父不在本图节点集合里时该节点当作根节点，而不是挂一条断边', () => {
    const { allSessionIds, summaryOf } = listOf({ orphan: { running: false, parentId: 'outside' }, outside: IDLE })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('orphan'), allSessionIds, summaryOf }))
    expect(idsOf(graph)).toEqual(['orphan'])
    expect(graph.nodes[0]?.parentSessionId).toBeUndefined()
    expect(graph.edges).toEqual([])
  })

  it('每条有父的边都出现在 edges 里，带种类', () => {
    const { allSessionIds, summaryOf } = listOf({ a: IDLE, b: { running: false, parentId: 'a' } })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a', 'b'), allSessionIds, summaryOf }))
    expect(graph.edges).toEqual([{ parentSessionId: 'a', childSessionId: 'b', relationKind: 'forked-from' }])
  })

  it('自指的父（placement/set 今天不拒自指）不画成自环，该节点当根', () => {
    const { allSessionIds, summaryOf } = listOf({ a: IDLE })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a'), allSessionIds, summaryOf, placementOf: placementsOf({ a: { parentSessionId: 'a' } }),
    }))
    expect(graph.nodes[0]?.parentSessionId).toBeUndefined()
    expect(graph.nodes[0]?.childCount).toBe(0)
    expect(graph.edges).toEqual([])
  })

  it('placement 数据成环（数据层今天不拦）也只是两条边，不死循环', () => {
    const { allSessionIds, summaryOf } = listOf({ a: IDLE, b: IDLE })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a', 'b'),
      allSessionIds,
      summaryOf,
      placementOf: placementsOf({ a: { parentSessionId: 'b' }, b: { parentSessionId: 'a' } }),
    }))
    expect(graph.edges).toHaveLength(2)
  })
})

describe('relationKindOf 是全函数（无论前置切片有没有写过这个字段）', () => {
  it('placement 显式 relationKind 压过一切派生规则（子代理也听它的）', () => {
    expect(relationKindOf({ relationKind: 'forked-from', parentSessionId: 'a' }, { running: false, origin: 'subagent', parentId: 'a' }))
      .toBe('forked-from')
    expect(relationKindOf({ relationKind: 'derived-from', parentSessionId: 'a' }, { running: false, parentId: 'a' }))
      .toBe('derived-from')
  })

  it('没有显式值时子代理恒为 derived-from', () => {
    expect(relationKindOf(undefined, { running: false, origin: 'subagent', parentId: 'a' })).toBe('derived-from')
    expect(relationKindOf({ parentSessionId: 'a' }, { running: false, origin: 'subagent', parentId: 'a' })).toBe('derived-from')
  })

  it('边只来自 DSH 自己的 parentSession（placement 没写父）时是 forked-from', () => {
    expect(relationKindOf(undefined, { running: false, parentId: 'a' })).toBe('forked-from')
    expect(relationKindOf({}, { running: false, parentId: 'a' })).toBe('forked-from')
  })

  it('placement 父 == DSH parentId 时 forked-from；不同则 derived-from', () => {
    expect(relationKindOf({ parentSessionId: 'a' }, { running: false, parentId: 'a' })).toBe('forked-from')
    expect(relationKindOf({ parentSessionId: 'a' }, { running: false, parentId: 'b' })).toBe('derived-from')
    expect(relationKindOf({ parentSessionId: 'a' }, { running: false })).toBe('derived-from')
  })

  it('summary 整个缺失也答得出（全函数，不抛不返回 undefined）', () => {
    expect(relationKindOf(undefined, undefined)).toBe('forked-from')
    expect(relationKindOf({ parentSessionId: 'a' }, undefined)).toBe('derived-from')
  })
})

describe('buildDagGraph 边种类落到 edges 上', () => {
  it('子代理的边是 derived-from，页签内 Fork 出来的边是 forked-from', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE,
      child: { running: false, parentId: 'a' },
      sub: { running: false, origin: 'subagent', parentId: 'a' },
    })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('a', 'child'),
      allSessionIds,
      summaryOf,
      placementOf: placementsOf({ child: { parentSessionId: 'a' } }),
    }))
    expect(graph.edges).toEqual([
      { parentSessionId: 'a', childSessionId: 'child', relationKind: 'forked-from' },
      { parentSessionId: 'a', childSessionId: 'sub', relationKind: 'derived-from' },
    ])
  })
})

describe('buildDagGraph 节点展示事实', () => {
  it('createdSeq：种子取页签内 ordinal，子代理没有 placement 行故取 MAX_SAFE_INTEGER', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE, b: IDLE, sub: { running: false, origin: 'subagent', parentId: 'a' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a', 'b'), allSessionIds, summaryOf }))
    expect(graph.nodes.map(node => [node.sessionId, node.createdSeq])).toEqual([
      ['a', 1], ['b', 2], ['sub', Number.MAX_SAFE_INTEGER],
    ])
  })

  it('childCount 数的是本图里画出来的直接子级，含子代理（与卡片头部那颗徽标口径不同）', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: IDLE,
      child: { running: false, parentId: 'a' },
      sub: { running: false, origin: 'subagent', parentId: 'a' },
      grandchild: { running: false, parentId: 'child' },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a', 'child', 'grandchild'), allSessionIds, summaryOf }))
    const byId = new Map(graph.nodes.map(node => [node.sessionId, node]))
    expect(byId.get('a')?.childCount).toBe(2)
    expect(byId.get('child')?.childCount).toBe(1)
    expect(byId.get('grandchild')?.childCount).toBe(0)
    expect(byId.get('sub')?.childCount).toBe(0)
  })

  it('state 走 sessionDotState 的三态，空闲为 undefined', () => {
    const { allSessionIds, summaryOf } = listOf({
      run: RUNNING,
      wait: { running: true },
      done: { running: false, completed: true },
      idle: IDLE,
    })
    const graph = buildDagGraph(inputOf({
      sceneSessionRefs: refs('run', 'wait', 'done', 'idle'),
      allSessionIds,
      summaryOf,
      pendingSessionIds: new Set(['wait']),
    }))
    expect(graph.nodes.map(node => [node.sessionId, node.state])).toEqual([
      ['run', 'ongoing'], ['wait', 'warning'], ['done', 'done'], ['idle', undefined],
    ])
  })

  it('title/cwd/lastActivityAt 全部有缺失分支（冷会话什么都可能没有）', () => {
    const { allSessionIds, summaryOf } = listOf({
      full: { running: false, displayTitle: '写文档', cwd: '/repo', updatedAt: 42 },
      bare: IDLE,
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('full', 'bare'), allSessionIds, summaryOf, untitledLabel: '未命名会话' }))
    expect(graph.nodes[0]).toMatchObject({ title: '写文档', cwd: '/repo', lastActivityAt: 42 })
    expect(graph.nodes[1]).toMatchObject({ title: '未命名会话', cwd: '', lastActivityAt: 0, preview: '' })
  })

  it('hasNotice 复用 S5 的未读位：只有未读且同会话的记录算数', () => {
    const notifications = [
      { sessionId: 'a', read: true } as AgentNotification,
      { sessionId: 'b', read: false } as AgentNotification,
    ]
    const { allSessionIds, summaryOf } = listOf({ a: IDLE, b: IDLE })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a', 'b'), allSessionIds, summaryOf, notifications }))
    expect(graph.nodes.map(node => node.hasNotice)).toEqual([false, true])
  })

  it('preview 取 turnOutline 的最后一轮回复，装到节点上', () => {
    const { allSessionIds, summaryOf } = listOf({
      a: { running: false, projectionValues: { turnOutline: [{ prompt: '旧', response: '旧答' }, { prompt: '新', response: '新答' }] } },
    })
    const graph = buildDagGraph(inputOf({ sceneSessionRefs: refs('a'), allSessionIds, summaryOf }))
    expect(graph.nodes[0]?.preview).toBe('新答')
  })
})

describe('lastTurnPreview（D-3：卡片正文的唯一取数口径）', () => {
  it('取最后一项的 response，不是第一项', () => {
    expect(lastTurnPreview({ turnOutline: [{ prompt: 'p1', response: 'r1' }, { prompt: 'p2', response: 'r2' }] })).toBe('r2')
  })

  it('response 为空串时退化用同一轮的 prompt', () => {
    expect(lastTurnPreview({ turnOutline: [{ prompt: '还没答完的问题', response: '' }] })).toBe('还没答完的问题')
  })

  it('两者都空时给空串', () => {
    expect(lastTurnPreview({ turnOutline: [{ prompt: '', response: '' }] })).toBe('')
  })

  it('宿主 bundle 没装 turn-outline 插件时这个键根本不存在，必须安静返回空串', () => {
    expect(lastTurnPreview({})).toBe('')
    expect(lastTurnPreview(undefined)).toBe('')
    expect(lastTurnPreview(null)).toBe('')
  })

  it('值不是数组 / 数组为空 / 末项不是对象 / 字段不是字符串，一律安静返回空串', () => {
    expect(lastTurnPreview({ turnOutline: 'oops' })).toBe('')
    expect(lastTurnPreview({ turnOutline: [] })).toBe('')
    expect(lastTurnPreview({ turnOutline: [null] })).toBe('')
    expect(lastTurnPreview({ turnOutline: ['plain string'] })).toBe('')
    expect(lastTurnPreview({ turnOutline: [{ prompt: 7, response: 9 }] })).toBe('')
  })
})
