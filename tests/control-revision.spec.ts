/**
 * S7 Task 3 — 拓扑版本号。
 *
 * 版本号存在的唯一理由是「序号会因重排而指向别人」（D-S7-3）。所以这一组测试
 * 只钉两件事，别的一概不管：
 * - **位置敏感**：被序号索引的两个集合，只要顺序变了，版本号就必须变——否则
 *   `sibling:3` 会在用户眼皮底下悄悄换成另一张卡；
 * - **内容不敏感**：标题、运行状态、cwd 这些不参与寻址的东西怎么变，版本号都
 *   不能动——否则模型每读一次就得重新列一次，`STALE_TOPOLOGY` 沦为噪音。
 *
 * 另外还要挡住两个「看起来对、其实把两段揉成一段」的实现：把 level 与 child
 * 直接拼起来哈希，和把 ref 用分隔符 join 起来哈希。两者都会让某些不同的拓扑
 * 撞成同一个版本号。
 */
import { describe, expect, it } from 'vitest'
import { topologyRevision } from '../src/control/revision.ts'
import { controlRefOf } from '../src/control/topology.ts'
import type { ControlTarget } from '../src/control/topology.ts'

const WORKSPACE = Object.freeze({ id: 'ws1', title: '工作区一', ordinal: 1 })
const TASK = Object.freeze({ id: 't1', title: '事项一', ordinal: 1 })
const SCENE = Object.freeze({ id: 's1', name: '页签一', ordinal: 1 })

/**
 * One projected card, with only the fields a revision could plausibly read.
 * @param sessionId - the session id, which also fixes the `ref`.
 * @param over - fields to override, used to vary the NON-addressing content.
 * @returns a control target.
 */
function target(sessionId: string, over: Partial<ControlTarget> = {}): ControlTarget {
  return {
    ref: controlRefOf(sessionId),
    sessionId,
    title: `卡片 ${sessionId}`,
    running: false,
    blank: false,
    workspace: WORKSPACE,
    task: TASK,
    scene: SCENE,
    depth: 0,
    childRefs: [],
    levelOrdinal: 1,
    ...over,
  }
}

const refsOf = (targets: readonly ControlTarget[]): readonly string[] => targets.map(entry => entry.ref)

describe('topologyRevision', () => {
  it('是 sha256 十六进制，且同一输入两次调用同值', () => {
    const first = topologyRevision(['session:a', 'session:b'], ['session:c'])
    const second = topologyRevision(['session:a', 'session:b'], ['session:c'])
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).toBe(first)
  })

  it('位置敏感：层内交换两个 ref 就换一个版本号', () => {
    const before = topologyRevision(['session:a', 'session:b', 'session:c'], [])
    const swapped = topologyRevision(['session:b', 'session:a', 'session:c'], [])
    expect(swapped).not.toBe(before)
  })

  it('位置敏感：子集合交换两个 ref 也换一个版本号', () => {
    const before = topologyRevision([], ['session:a', 'session:b'])
    const swapped = topologyRevision([], ['session:b', 'session:a'])
    expect(swapped).not.toBe(before)
  })

  it('内容不敏感：标题、运行状态、cwd 变了但 ref 序列没变 → 同值', () => {
    const level = [target('a'), target('b')]
    const children = [target('c')]
    // 同一份拓扑，隔一秒后的样子：标题被 DSH 改了名、b 开始跑了一轮、c 报出了
    // cwd。寻址关系一个字都没变，所以模型手里的 `sibling:2` 依然指向 b。
    const laterLevel = [
      target('a', { title: '改了名的 A' }),
      target('b', { title: '', running: true, cwd: '/repo/b' }),
    ]
    const laterChildren = [target('c', { title: 'C 也改了名', blank: true })]
    expect(topologyRevision(refsOf(laterLevel), refsOf(laterChildren)))
      .toBe(topologyRevision(refsOf(level), refsOf(children)))
  })

  it('层集合与子集合不可互换', () => {
    expect(topologyRevision(['session:a'], ['session:b']))
      .not.toBe(topologyRevision(['session:b'], ['session:a']))
  })

  it('两段的边界不会被拼接抹平：([a,b],[]) ≠ ([a],[b])', () => {
    expect(topologyRevision(['session:a', 'session:b'], []))
      .not.toBe(topologyRevision(['session:a'], ['session:b']))
  })

  it('分隔符不会被 ref 自身的内容伪造：一个「含分隔符」的 ref ≠ 两个 ref', () => {
    // 这一对刻意选成「join(',') 之后逐字相同」：单个 ref `session:a,session:b`
    // 与两个 ref `session:a` + `session:b` 拼出来都是 `session:a,session:b`。
    // 任何把序列 join 成一个字符串再哈希的实现在这里必然撞号。
    expect(topologyRevision(['session:a,session:b'], []))
      .not.toBe(topologyRevision(['session:a', 'session:b'], []))
  })

  it('空拓扑有确定值，且与「只有层」「只有子」都不同', () => {
    const empty = topologyRevision([], [])
    expect(empty).toMatch(/^[0-9a-f]{64}$/u)
    expect(topologyRevision([], [])).toBe(empty)
    expect(topologyRevision(['session:a'], [])).not.toBe(empty)
    expect(topologyRevision([], ['session:a'])).not.toBe(empty)
  })

  it('空层与空子集互不相同：只有子会话时 ≠ 只有同层时', () => {
    expect(topologyRevision([], ['session:a'])).not.toBe(topologyRevision(['session:a'], []))
  })
})
