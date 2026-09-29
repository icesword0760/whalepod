/**
 * S4 Task 5：DAG 搜索评分。
 *
 * 移植自码头 `dag-layout.ts:142-165`，但**少一档**：码头的 45 分是
 * `node.worktree?.branch`（`:161`），DSH 没有 worktree / git 维度，节点视图上
 * 根本没有这个字段可评（S4 计划 T-3）。20 分那一档也换了匹配面：码头数的是
 * 终端最后 4 行输出（`:163` 的 `latestLines`），DSH 数的是**卡片正文那段
 * 预览**（`DagNodeView.preview`，D-3）——搜索的匹配面必须与用户看得见的
 * 文字一致，否则会出现「搜到了但卡片上找不到这几个字」。
 */
import { describe, expect, it } from 'vitest'
import { buildDagGraph } from '../src/client/dag/graph.ts'
import type { DagNodeView } from '../src/client/dag/graph.ts'
import { searchGraph, searchScore } from '../src/client/dag/search.ts'

/** 一个最小节点；每个用例只覆写它要考的那几个字段。 */
function nodeOf(sessionId: string, overrides: Partial<DagNodeView> = {}): DagNodeView {
  return {
    sessionId,
    createdSeq: 1,
    title: '',
    cwd: '',
    childCount: 0,
    lastActivityAt: 0,
    preview: '',
    hasNotice: false,
    subagent: false,
    ...overrides,
  }
}

function idsOf(nodes: readonly DagNodeView[]): string[] {
  return nodes.map(node => node.sessionId)
}

describe('searchScore 的五个档位', () => {
  it('标题与查询完全相同 → 100', () => {
    expect(searchScore(nodeOf('a', { title: '数据库迁移' }), '数据库迁移')).toBe(100)
  })

  it('标题以查询开头（但不等于）→ 80，不是 60', () => {
    expect(searchScore(nodeOf('a', { title: '数据库迁移脚本' }), '数据库迁移')).toBe(80)
  })

  it('标题包含查询但不以它开头 → 60，不是 80', () => {
    expect(searchScore(nodeOf('a', { title: '修一下数据库迁移' }), '数据库迁移')).toBe(60)
  })

  it('标题不沾边、只有 cwd 命中 → 30', () => {
    expect(searchScore(nodeOf('a', { title: '会话 A', cwd: '/w/repo/migrations' }), 'migrations')).toBe(30)
  })

  it('标题与 cwd 都不沾边、只有卡片正文预览命中 → 20', () => {
    const node = nodeOf('a', { title: '会话 A', cwd: '/w/repo', preview: '已完成数据库迁移脚本的回滚分支' })
    expect(searchScore(node, '数据库迁移')).toBe(20)
  })

  it('哪一档都不命中 → 0', () => {
    const node = nodeOf('a', { title: '会话 A', cwd: '/w/repo', preview: '在跑测试' })
    expect(searchScore(node, '数据库迁移')).toBe(0)
  })

  it('三个字段全命中时只算最高的那一档（100，不是叠加也不是 20）', () => {
    const node = nodeOf('a', { title: '迁移', cwd: '/w/迁移', preview: '迁移完成' })
    expect(searchScore(node, '迁移')).toBe(100)
  })

  it('标题不命中而 cwd 与正文都命中时取 30，不是 20', () => {
    const node = nodeOf('a', { title: '会话 A', cwd: '/w/migrate', preview: 'migrate 完成' })
    expect(searchScore(node, 'migrate')).toBe(30)
  })

  it('大小写不敏感：节点一侧也要归一化（查询已由调用方归一化为小写）', () => {
    expect(searchScore(nodeOf('a', { title: 'MIGRATE' }), 'migrate')).toBe(100)
    expect(searchScore(nodeOf('b', { title: '会话', cwd: '/W/Repo/Migrate' }), 'migrate')).toBe(30)
    expect(searchScore(nodeOf('c', { title: '会话', preview: 'Migrate Done' }), 'migrate')).toBe(20)
  })

  it('空字符串的 cwd / preview 不会被当成命中', () => {
    expect(searchScore(nodeOf('a', { title: '会话 A' }), 'x')).toBe(0)
  })
})

describe('评分里没有任何分支 / worktree 维度（码头的 45 分档已删）', () => {
  /** 码头 `dag-layout.ts:161`：`node.worktree?.branch.toLocaleLowerCase().includes(query)` → 45。 */
  it('cwd 里的分支样字符串只值 30，不是 45', () => {
    const node = nodeOf('a', { title: '会话 A', cwd: '/w/repo-feature/login' })
    expect(searchScore(node, 'feature/login')).toBe(30)
  })

  it('节点对象上就算混进 branch / worktree 字段也不参与评分', () => {
    const smuggled = { ...nodeOf('a', { title: '会话 A' }), branch: 'feature/login', worktree: { branch: 'feature/login' } }
    expect(searchScore(smuggled as DagNodeView, 'feature/login')).toBe(0)
  })
})

describe('searchGraph', () => {
  it('空查询返回空数组，不是返回全图', () => {
    expect(searchGraph([nodeOf('a', { title: '迁移' })], '')).toEqual([])
  })

  it('纯空白查询同样返回空数组', () => {
    expect(searchGraph([nodeOf('a', { title: '迁移' })], '   \t\n ')).toEqual([])
  })

  it('查询两端的空白被裁掉后仍然命中', () => {
    expect(idsOf(searchGraph([nodeOf('a', { title: '迁移' })], '  迁移  '))).toEqual(['a'])
  })

  it('查询大写、标题小写也能命中（查询由 searchGraph 归一化）', () => {
    expect(idsOf(searchGraph([nodeOf('a', { title: 'migrate' })], 'MIGRATE'))).toEqual(['a'])
  })

  it('0 分的节点被丢掉，不出现在结果里', () => {
    const nodes = [nodeOf('hit', { title: '迁移' }), nodeOf('miss', { title: '别的' })]
    expect(idsOf(searchGraph(nodes, '迁移'))).toEqual(['hit'])
  })

  it('按分数从高到低排（100 → 80 → 60 → 30 → 20）', () => {
    const nodes = [
      nodeOf('preview20', { title: '别的', preview: '迁移完成' }),
      nodeOf('cwd30', { title: '别的', cwd: '/w/迁移' }),
      nodeOf('contains60', { title: '修一下迁移' }),
      nodeOf('exact100', { title: '迁移' }),
      nodeOf('prefix80', { title: '迁移脚本' }),
    ]
    expect(idsOf(searchGraph(nodes, '迁移'))).toEqual(['exact100', 'prefix80', 'contains60', 'cwd30', 'preview20'])
  })

  it('同分时按 createdSeq 升序，而不是按入参顺序', () => {
    const nodes = [
      nodeOf('late', { title: '迁移', createdSeq: 9 }),
      nodeOf('early', { title: '迁移', createdSeq: 2 }),
    ]
    expect(idsOf(searchGraph(nodes, '迁移'))).toEqual(['early', 'late'])
  })

  it('同分且 createdSeq 相同时按 sessionId 兜底全序', () => {
    const nodes = [
      nodeOf('b', { title: '迁移', createdSeq: 3 }),
      nodeOf('a', { title: '迁移', createdSeq: 3 }),
    ]
    expect(idsOf(searchGraph(nodes, '迁移'))).toEqual(['a', 'b'])
  })

  /** 子代理没有 placement 行，`createdSeq` 是 `Number.MAX_SAFE_INTEGER`（`graph.ts` 规则 5）。 */
  it('子代理（createdSeq = MAX_SAFE_INTEGER）同分时排在有序号的节点之后', () => {
    const nodes = [
      nodeOf('sub', { title: '迁移', createdSeq: Number.MAX_SAFE_INTEGER, subagent: true }),
      nodeOf('placed', { title: '迁移', createdSeq: 7 }),
    ]
    expect(idsOf(searchGraph(nodes, '迁移'))).toEqual(['placed', 'sub'])
  })

  it('不就地改动传入的数组', () => {
    const nodes = [nodeOf('late', { title: '迁移', createdSeq: 9 }), nodeOf('early', { title: '迁移', createdSeq: 2 })]
    searchGraph(nodes, '迁移')
    expect(idsOf(nodes)).toEqual(['late', 'early'])
  })

  it('空节点集合返回空数组', () => {
    expect(searchGraph([], '迁移')).toEqual([])
  })
})

describe('搜索的匹配面与卡片正文是同一段文字（D-3）', () => {
  /** 造一个只有 `turnOutline` 能提供正文的会话，让 `buildDagGraph` 自己算出 `preview`。 */
  function graphWithTurns(turns: readonly { prompt: string; response: string }[]) {
    return buildDagGraph({
      sceneId: 'scene:1',
      sceneSessionRefs: [{ sessionId: 'a', ordinal: 1 }],
      allSessionIds: ['a'],
      summaryOf: () => ({ running: false, displayTitle: '会话 A', cwd: '/w/repo', projectionValues: { turnOutline: turns } }),
      placementOf: () => undefined,
      untitledLabel: '未命名会话',
    })
  }

  it('20 分那一档命中的，正是卡片上看得见的那段正文', () => {
    const graph = graphWithTurns([{ prompt: '继续', response: '已完成数据库迁移脚本' }])
    const hits = searchGraph(graph.nodes, '数据库迁移')
    expect(idsOf(hits)).toEqual(['a'])
    // 命中的那段文字与卡片正文是同一个字段、同一份内容。
    expect(hits.map(node => node.preview)).toEqual(['已完成数据库迁移脚本'])
    expect(searchScore(hits[0] as DagNodeView, '数据库迁移')).toBe(20)
  })

  it('只出现在更早那一轮、卡片上看不见的文字搜不到（不是把所有轮次拼起来搜）', () => {
    const graph = graphWithTurns([
      { prompt: '先做迁移', response: '已完成数据库迁移脚本' },
      { prompt: '再跑测试', response: '测试全绿' },
    ])
    expect(graph.nodes.map(node => node.preview)).toEqual(['测试全绿'])
    expect(searchGraph(graph.nodes, '数据库迁移')).toEqual([])
    expect(idsOf(searchGraph(graph.nodes, '测试全绿'))).toEqual(['a'])
  })

  /**
   * 20 分档只许看 `preview` 一个字段。把标题 / cwd / 正文拼成一串再搜（一种很像
   * 对的写法：「反正都是这张卡上的字」）会让跨字段边界的查询命中一张正文里没有
   * 这几个字的卡片——正是 D-3 要避免的「搜到了但卡片上找不到」。
   */
  it('查询只在「标题 + cwd + 正文」拼起来时才出现的，不算命中', () => {
    const node = nodeOf('a', { title: '会话 A', cwd: '/w/repo', preview: '在跑测试' })
    expect(searchScore(node, '会话 a /w/repo')).toBe(0)
    expect(searchScore(node, '/w/repo 在跑测试')).toBe(0)
    expect(searchGraph([node], '会话 A /w/repo')).toEqual([])
  })

  it('宿主没装 turn-outline 插件（没有正文）时，正文档位安静地不命中', () => {
    const graph = buildDagGraph({
      sceneId: 'scene:1',
      sceneSessionRefs: [{ sessionId: 'a', ordinal: 1 }],
      allSessionIds: ['a'],
      summaryOf: () => ({ running: false, displayTitle: '会话 A', cwd: '/w/repo' }),
      placementOf: () => undefined,
      untitledLabel: '未命名会话',
    })
    expect(graph.nodes.map(node => node.preview)).toEqual([''])
    expect(searchGraph(graph.nodes, '数据库迁移')).toEqual([])
  })
})
