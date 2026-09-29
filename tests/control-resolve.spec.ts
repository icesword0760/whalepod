/**
 * S7 Task 4 —— 选择器求解与错误形状。
 *
 * 这一组测试钉三件事：
 *
 * 1. **序号指向的就是用户看到的那一张。** 层数组来自 `levelOf`、子数组来自
 *    `childrenOf`，两者都是 Task 2 那份「与轮播同源」的投影。所以 fixture 里
 *    落位序被刻意排成与近因序完全相反——任何「照落位序数」的实现当场露馅。
 * 2. **`sibling:N` 含自己在内。** 对齐码头 `host-topology-projector.ts:92-94`
 *    的 `siblings[ordinal - 1]`（`siblings` 由 `parentRef` 相同者构成，调用者
 *    本人也在里面）。这条最容易被实现成「不含自己」，所以单独钉一条。
 * 3. **错误是一句英文人话，不是错误码缩写。** 模型拿到失败后要能照着自我纠正：
 *    句子必须说清「哪儿不对」和「下一步做什么」。下面对七个码逐条查形状，并对
 *    计划里逐字给定的三句做逐字断言。
 *
 * 版本号那一组的关键在于：期望值是用 Task 3 的 `topologyRevision` 现算的，且
 * 「两个数组对调」必须被拒——这证明求解用的正是「调用者所在层 + 调用者的子会话」
 * 这两个集合，而不是别的什么。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTROL_ERROR_CODES,
  CONTROL_ERROR_SENTENCE,
  controlError,
  isControlError,
} from '../src/control/errors.ts'
import type { ControlErrorCode } from '../src/control/errors.ts'
import { resolveTarget } from '../src/control/resolve.ts'
import { topologyRevision } from '../src/control/revision.ts'
import type { ControlSelector } from '../src/control/selector.ts'
import { childrenOf, controlRefOf, levelOf, projectControlTargets } from '../src/control/topology.ts'
import type { ControlSessionFacts, ControlTarget } from '../src/control/topology.ts'
import type { MatouOrgState, MatouPlacement } from '../src/org/model.ts'

const WORKSPACE_ID = 'ws1'

/**
 * 近因（`updatedAt`）决定层内顺序：
 * - 根层 s1：north(900) → middle(500) → south(300)
 * - middle 的子层：kidA(200) → kidB(100)
 * - 另一个页签 s2 只有 faraway，用来验证 `session:<id>` 能打到层外目标。
 */
const FACTS: Record<string, ControlSessionFacts> = {
  north: { updatedAt: 900, title: 'North' },
  middle: { updatedAt: 500, title: 'Middle' },
  south: { updatedAt: 300, title: 'South' },
  kidA: { updatedAt: 200, title: 'Kid A' },
  kidB: { updatedAt: 100, title: 'Kid B' },
  faraway: { updatedAt: 400, title: 'Faraway' },
  helper: { updatedAt: 800, origin: 'subagent', parentId: 'middle', title: 'Helper' },
}

const WORKSPACES = [{
  workspaceId: WORKSPACE_ID,
  title: '工作区一',
  sessionIds: ['north', 'middle', 'south', 'kidA', 'kidB', 'faraway', 'helper'],
}]

function placement(row: Omit<MatouPlacement, 'updatedAt'>): MatouPlacement {
  return { updatedAt: 0, ...row }
}

const ORG: MatouOrgState = {
  tasks: [{
    id: 't1', workspaceId: WORKSPACE_ID, title: '事项一',
    status: 'active', isPinned: false, sortKey: 1, createdAt: 0, updatedAt: 0,
  }],
  scenes: [
    { id: 's1', taskId: 't1', name: '页签一', titlePinned: false, sortKey: 1, createdAt: 0, updatedAt: 0 },
    { id: 's2', taskId: 't1', name: '页签二', titlePinned: false, sortKey: 2, createdAt: 0, updatedAt: 0 },
  ],
  // 落位序刻意与近因序相反（根层 south → middle → north，子层 kidB → kidA），
  // 这样「照落位序数第 N 个」的实现与正确实现给出的答案处处不同。
  placements: [
    placement({ sessionId: 'south', taskId: 't1', sceneId: 's1', sortKey: 10 }),
    placement({ sessionId: 'middle', taskId: 't1', sceneId: 's1', sortKey: 20 }),
    placement({ sessionId: 'north', taskId: 't1', sceneId: 's1', sortKey: 30 }),
    placement({ sessionId: 'kidB', taskId: 't1', sceneId: 's1', parentSessionId: 'middle', sortKey: 40 }),
    placement({ sessionId: 'kidA', taskId: 't1', sceneId: 's1', parentSessionId: 'middle', sortKey: 50 }),
    placement({ sessionId: 'faraway', taskId: 't1', sceneId: 's2', sortKey: 60 }),
    placement({ sessionId: 'helper', taskId: 't1', sceneId: 's1', parentSessionId: 'middle', sortKey: 70 }),
  ],
}

const TARGETS: readonly ControlTarget[] = projectControlTargets({
  workspaces: WORKSPACES,
  summaryOf: (id: string) => FACTS[id],
  archivedSessionIds: [],
  org: ORG,
})

const refsOf = (targets: readonly ControlTarget[]): readonly string[] => targets.map(target => target.ref)

/** 当前正确的版本号：调用者所在层 + 调用者的子会话，按 Task 3 的算式现算。 */
function revisionFor(callerSessionId: string): string {
  return topologyRevision(
    refsOf(levelOf(TARGETS, callerSessionId)),
    refsOf(childrenOf(TARGETS, callerSessionId)),
  )
}

interface ResolveOptions {
  readonly targets?: readonly ControlTarget[]
  readonly revision?: string
  readonly subagentSessionIds?: ReadonlySet<string>
}

function resolve(callerSessionId: string, selector: ControlSelector, options: ResolveOptions = {}): string {
  return resolveTarget({
    callerSessionId,
    selector,
    targets: options.targets ?? TARGETS,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(options.subagentSessionIds === undefined ? {} : { subagentSessionIds: options.subagentSessionIds }),
  }).sessionId
}

/**
 * 把一次预期失败的求解转成可断言的值。
 * @param run - 应当抛出的调用。
 * @returns 抛出的错误码与完整 message。
 */
function failure(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    if (!isControlError(error)) throw new Error(`expected a control error, got ${String(error)}`)
    return { code: error.code, message: error.message }
  }
  throw new Error('expected resolveTarget to throw, but it returned')
}

describe('fixture 前提（后面每条断言都靠它）', () => {
  it('层内顺序按近因排，且与落位序相反', () => {
    expect(levelOf(TARGETS, 'middle').map(target => target.sessionId)).toEqual(['north', 'middle', 'south'])
    expect(childrenOf(TARGETS, 'middle').map(target => target.sessionId)).toEqual(['kidA', 'kidB'])
  })

  it('子代理不在投影里（所以只能被裸 session id 撞上）', () => {
    expect(TARGETS.some(target => target.sessionId === 'helper')).toBe(false)
  })
})

describe('resolveTarget — self 与调用者身份', () => {
  it('self 回自己', () => {
    expect(resolve('middle', { kind: 'self' })).toBe('middle')
  })

  it('调用者不在投影里 → NOT_IN_WORKBENCH，句子说清「你不是工作台里的卡片」', () => {
    const { code, message } = failure(() => resolve('ghost', { kind: 'self' }))
    expect(code).toBe('NOT_IN_WORKBENCH')
    expect(message.startsWith('NOT_IN_WORKBENCH: ')).toBe(true)
    expect(message).toContain('you are not a card in this workbench')
  })

  it('调用者不在投影里时，任何选择器都先撞这一条（不会先报越界）', () => {
    expect(failure(() => resolve('ghost', { kind: 'relative', direction: 'left' })).code).toBe('NOT_IN_WORKBENCH')
    expect(failure(() => resolve('ghost', { kind: 'session', sessionId: 'north' })).code).toBe('NOT_IN_WORKBENCH')
  })
})

describe('resolveTarget — left / right', () => {
  /** 位置型选择器现在也吃版本号闸门，所以这一组每次都要带当前版本号。 */
  const at = (caller: string, direction: 'left' | 'right'): string =>
    resolve(caller, { kind: 'relative', direction }, { revision: revisionFor(caller) })

  it('在层数组里 ∓1', () => {
    expect(at('middle', 'left')).toBe('north')
    expect(at('middle', 'right')).toBe('south')
  })

  it('最左侧再往左 → NO_SUCH_NEIGHBOUR，句子说的是「左边」', () => {
    const { code, message } = failure(() => at('north', 'left'))
    expect(code).toBe('NO_SUCH_NEIGHBOUR')
    expect(message).toContain('to your left')
    expect(message).not.toContain('to your right')
  })

  it('最右侧再往右 → NO_SUCH_NEIGHBOUR，句子说的是「右边」，且与左边那句不同', () => {
    const left = failure(() => at('north', 'left')).message
    const { code, message } = failure(() => at('south', 'right'))
    expect(code).toBe('NO_SUCH_NEIGHBOUR')
    expect(message).toContain('to your right')
    expect(message).not.toBe(left)
  })

  /**
   * 第二轮活体走查带回来的那条：模型在同一轮里先让 `right` 干活、再停掉 `right`，
   * 两次打到了不同的卡——第一条消息把目标顶到本层最前，调用者退了一位。位置型选
   * 择器因此和序号型一样吃版本号闸门；这三条钉的就是这道闸门本身。
   */
  it('不带版本号的 right → STALE_TOPOLOGY，而不是照着当前顺序闷头求解', () => {
    const { code } = failure(() => resolve('middle', { kind: 'relative', direction: 'right' }))
    expect(code).toBe('STALE_TOPOLOGY')
  })

  it('版本号过期的 left 同样 STALE_TOPOLOGY', () => {
    const { code } = failure(() =>
      resolve('middle', { kind: 'relative', direction: 'left' }, { revision: 'nonsense' }))
    expect(code).toBe('STALE_TOPOLOGY')
  })

  /**
   * 反例：闸门只该拦位置型。若实现改成「一律要版本号」，上面两条照样绿，只有这条会红
   * ——而它正是走查里模型本该改用的那条退路（回执里就有 session id）。
   */
  it('身份型不受影响：session:<id> 不带版本号照样求解', () => {
    expect(resolve('middle', { kind: 'session', sessionId: 'south' })).toBe('south')
  })
})

describe('resolveTarget — parent', () => {
  it('子会话的 parent 回父会话', () => {
    expect(resolve('kidA', { kind: 'relation', relation: 'parent' })).toBe('middle')
  })

  it('根层会话没有父 → NO_SUCH_NEIGHBOUR，句子说清「你已经在顶层」', () => {
    const { code, message } = failure(() => resolve('middle', { kind: 'relation', relation: 'parent' }))
    expect(code).toBe('NO_SUCH_NEIGHBOUR')
    expect(message).toContain('no parent session')
  })

  it('父边悬空（父已不在投影里）→ NOT_IN_WORKBENCH，而不是假装没有父', () => {
    const dangling: readonly ControlTarget[] = [{
      ref: controlRefOf('lonely'),
      sessionId: 'lonely',
      title: 'Lonely',
      running: false,
      blank: false,
      workspace: { id: WORKSPACE_ID, title: 'w', ordinal: 1 },
      task: { id: 't1', title: '事项一', ordinal: 1 },
      scene: { id: 's1', name: '页签一', ordinal: 1 },
      depth: 1,
      parentRef: controlRefOf('vanished'),
      childRefs: [],
      levelOrdinal: 1,
    }]
    const { code, message } = failure(() => resolve('lonely', { kind: 'relation', relation: 'parent' }, { targets: dangling }))
    expect(code).toBe('NOT_IN_WORKBENCH')
    expect(message).toContain('session:vanished')
  })

  it('parent 不需要版本号', () => {
    expect(resolve('kidA', { kind: 'relation', relation: 'parent' }, { revision: 'nonsense' })).toBe('middle')
  })
})

describe('resolveTarget — sibling:N', () => {
  const sibling = (ordinal: number): ControlSelector => ({ kind: 'sibling', ordinal })

  it('是含自己在内的 1-based 层内序号', () => {
    const revision = revisionFor('middle')
    expect(resolve('middle', sibling(1), { revision })).toBe('north')
    // 第 2 个就是调用者本人——兄弟组含自身（码头 host-topology-projector.ts:92-94）。
    expect(resolve('middle', sibling(2), { revision })).toBe('middle')
    expect(resolve('middle', sibling(3), { revision })).toBe('south')
  })

  it('越界 → NO_SUCH_NEIGHBOUR，句子给出本层实际张数', () => {
    const { code, message } = failure(() => resolve('middle', sibling(4), { revision: revisionFor('middle') }))
    expect(code).toBe('NO_SUCH_NEIGHBOUR')
    expect(message).toContain('3 cards')
    expect(message).toContain('including you')
  })
})

describe('resolveTarget — child:N', () => {
  const child = (ordinal: number): ControlSelector => ({ kind: 'relation', relation: 'child', ordinal })

  it('按子层顺序命中（近因序，不是落位序）', () => {
    const revision = revisionFor('middle')
    expect(resolve('middle', child(1), { revision })).toBe('kidA')
    expect(resolve('middle', child(2), { revision })).toBe('kidB')
  })

  it('越界 → NO_SUCH_NEIGHBOUR，句子给出实际子会话数', () => {
    const { code, message } = failure(() => resolve('middle', child(3), { revision: revisionFor('middle') }))
    expect(code).toBe('NO_SUCH_NEIGHBOUR')
    expect(message).toContain('2 child sessions')
  })

  it('一个子会话都没有时，句子直说「一个都没有」', () => {
    const { code, message } = failure(() => resolve('north', child(1), { revision: revisionFor('north') }))
    expect(code).toBe('NO_SUCH_NEIGHBOUR')
    expect(message).toContain('no child sessions at all')
  })
})

describe('resolveTarget — 版本号闸门（只对序号选择器）', () => {
  it('不带版本号 → STALE_TOPOLOGY', () => {
    expect(failure(() => resolve('middle', { kind: 'sibling', ordinal: 1 })).code).toBe('STALE_TOPOLOGY')
  })

  it('版本号不匹配 → STALE_TOPOLOGY，且与「不带」是逐字相同的一句话', () => {
    const missing = failure(() => resolve('middle', { kind: 'sibling', ordinal: 1 }))
    const mismatched = failure(() => resolve('middle', { kind: 'sibling', ordinal: 1 }, { revision: 'stale' }))
    expect(mismatched.code).toBe('STALE_TOPOLOGY')
    expect(mismatched.message).toBe(missing.message)
    expect(mismatched.message).toContain('matou_list_sessions')
  })

  it('child:N 与 sibling:N 用同一个版本号（一个数覆盖两个集合）', () => {
    const revision = revisionFor('middle')
    expect(resolve('middle', { kind: 'sibling', ordinal: 1 }, { revision })).toBe('north')
    expect(resolve('middle', { kind: 'relation', relation: 'child', ordinal: 1 }, { revision })).toBe('kidA')
  })

  it('版本号覆盖的正是「层 + 子层」这两个集合，且两段不可对调', () => {
    const swapped = topologyRevision(
      refsOf(childrenOf(TARGETS, 'middle')),
      refsOf(levelOf(TARGETS, 'middle')),
    )
    expect(failure(() => resolve('middle', { kind: 'sibling', ordinal: 1 }, { revision: swapped })).code)
      .toBe('STALE_TOPOLOGY')
  })

  it('版本号闸门先于越界判定：过期 + 越界一起给 STALE_TOPOLOGY', () => {
    expect(failure(() => resolve('middle', { kind: 'sibling', ordinal: 99 }, { revision: 'stale' })).code)
      .toBe('STALE_TOPOLOGY')
  })

  it('每个调用者的版本号是各自的（子层调用者与根层调用者不同）', () => {
    expect(failure(() => resolve('kidA', { kind: 'sibling', ordinal: 1 }, { revision: revisionFor('middle') })).code)
      .toBe('STALE_TOPOLOGY')
    expect(resolve('kidA', { kind: 'sibling', ordinal: 1 }, { revision: revisionFor('kidA') })).toBe('kidA')
  })
})

describe('resolveTarget — session:<id>', () => {
  it('命中层外目标（另一个页签里的卡片）', () => {
    expect(resolve('middle', { kind: 'session', sessionId: 'faraway' })).toBe('faraway')
  })

  it('命中自己所在层里的目标，也不需要版本号', () => {
    expect(resolve('middle', { kind: 'session', sessionId: 'south' }, { revision: 'nonsense' })).toBe('south')
  })

  it('不在投影里 → NOT_IN_WORKBENCH，句子里点名那个 id', () => {
    const { code, message } = failure(() => resolve('middle', { kind: 'session', sessionId: 'nobody' }))
    expect(code).toBe('NOT_IN_WORKBENCH')
    expect(message).toContain('nobody')
    expect(message).toContain('matou_list_sessions')
  })

  it('命中一个已知的子代理 id → TARGET_IS_SUBAGENT，句子指向子代理自己的工具', () => {
    const { code, message } = failure(() => resolve(
      'middle',
      { kind: 'session', sessionId: 'helper' },
      { subagentSessionIds: new Set(['helper']) },
    ))
    expect(code).toBe('TARGET_IS_SUBAGENT')
    expect(message).toContain('send_message')
    expect(message).toContain('interrupt_agent')
  })

  it('没传子代理集合时，子代理 id 退化成 NOT_IN_WORKBENCH（而不是崩）', () => {
    expect(failure(() => resolve('middle', { kind: 'session', sessionId: 'helper' })).code).toBe('NOT_IN_WORKBENCH')
  })

  it('真实卡片优先于子代理集合（同一个 id 同时出现在两边时不误报）', () => {
    expect(resolve(
      'middle',
      { kind: 'session', sessionId: 'south' },
      { subagentSessionIds: new Set(['south']) },
    )).toBe('south')
  })
})

describe('controlError —— 错误形状', () => {
  it('七个错误码，一个不多一个不少', () => {
    expect([...CONTROL_ERROR_CODES]).toEqual([
      'INVALID_TARGET',
      'NOT_IN_WORKBENCH',
      'NO_SUCH_NEIGHBOUR',
      'STALE_TOPOLOGY',
      'TARGET_IS_SUBAGENT',
      'TARGET_NOT_RUNNING',
      'WORKBENCH_NOT_READY',
    ])
  })

  it('message 是 `<CODE>: <句子>`，并带上可判别的 code 字段', () => {
    const error = controlError('WORKBENCH_NOT_READY')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('WORKBENCH_NOT_READY')
    expect(error.message).toBe(`WORKBENCH_NOT_READY: ${CONTROL_ERROR_SENTENCE.WORKBENCH_NOT_READY}`)
  })

  it('detail 顶掉默认句子，前缀不变', () => {
    const error = controlError('NO_SUCH_NEIGHBOUR', 'there is nothing over there; look again.')
    expect(error.message).toBe('NO_SUCH_NEIGHBOUR: there is nothing over there; look again.')
  })

  it('isControlError 只认自己造的错误', () => {
    expect(isControlError(controlError('STALE_TOPOLOGY'))).toBe(true)
    expect(isControlError(new Error('STALE_TOPOLOGY: something'))).toBe(false)
    expect(isControlError({ code: 'STALE_TOPOLOGY', message: 'x' })).toBe(false)
    expect(isControlError(undefined)).toBe(false)
  })

  it.each([...CONTROL_ERROR_CODES])('%s 的默认句子是英文人话，不是错误码缩写', code => {
    const sentence = CONTROL_ERROR_SENTENCE[code as ControlErrorCode]
    expect(sentence).not.toContain(code)
    expect(sentence).toMatch(/^[a-z]/u)
    expect(sentence.endsWith('.')).toBe(true)
    expect(sentence.split(' ').length).toBeGreaterThanOrEqual(8)
    // 面向模型的表面一律英文：句子里不能混进中文。
    expect(sentence).not.toMatch(/[一-鿿]/u)
  })

  it.each([...CONTROL_ERROR_CODES])('%s 的默认句子说清了下一步（点名工具或给出语法）', code => {
    const sentence = CONTROL_ERROR_SENTENCE[code as ControlErrorCode]
    expect(sentence).toMatch(/matou_list_sessions|matou_identify_self|a target is one of|send_message|nothing to interrupt/u)
  })

  /**
   * STALE_TOPOLOGY 这一句**故意不再与计划逐字一致**。计划写它时，闸门只管序号
   * （「addressing by ordinal」），而第二轮活体走查证明 `left`/`right` 会以同样
   * 的方式指错人；句子若还只说序号，模型读到它时不会想到自己刚才用的 `right` 也
   * 在被说。同时补上「用 session:<id> 钉住同一张卡」——只叫模型重新 list，它拿到
   * 的是正确的**位置**，却不一定是刚才那**张卡**。
   */
  it('STALE_TOPOLOGY 的句子同时点名位置型写法与稳定 id 退路', () => {
    const sentence = CONTROL_ERROR_SENTENCE.STALE_TOPOLOGY
    for (const form of ['left', 'right', 'sibling:N', 'child:N']) expect(sentence).toContain(form)
    expect(sentence).toContain('matou_list_sessions')
    expect(sentence).toContain('session:<id>')
  })

  it('计划里逐字给定的另外两句，逐字一致', () => {
    expect(CONTROL_ERROR_SENTENCE.TARGET_NOT_RUNNING)
      .toBe('the target has no running turn; nothing to interrupt.')
    expect(CONTROL_ERROR_SENTENCE.TARGET_IS_SUBAGENT).toBe(
      'that session is a subagent child; use your own `send_message` / `interrupt_agent` tools for it'
      + ' — this workbench control surface only covers workbench cards.',
    )
  })
})
