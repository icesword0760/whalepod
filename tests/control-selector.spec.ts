import { describe, expect, it } from 'vitest'
import {
  SELECTOR_MAX_LENGTH,
  SELECTOR_ORDINAL_MAX,
  isSelectorParseFailure,
  parseSelector,
  selectorNeedsRevision,
} from '../src/control/selector.ts'
import type { ControlSelector, SelectorParseFailure } from '../src/control/selector.ts'

/** A real DSH session id: `session-${randomUUID()}` (`packages/api/session-controller/src/commands.ts:77`). */
const REAL_SESSION_ID = 'session-4f1c2c1e-8f4a-4a1b-9a0a-2d3e4f5a6b7c'

/** Parse and assert success, so each test asserts on a narrowed selector. */
function selector(raw: string): ControlSelector {
  const parsed = parseSelector(raw)
  if (isSelectorParseFailure(parsed)) {
    throw new Error(`parseSelector(${JSON.stringify(raw)}) failed unexpectedly: ${parsed.reason}`)
  }
  return parsed
}

/** Parse and assert failure, so each test asserts on the human-readable reason. */
function failure(raw: string): SelectorParseFailure {
  const parsed = parseSelector(raw)
  if (!isSelectorParseFailure(parsed)) {
    throw new Error(`parseSelector(${JSON.stringify(raw)}) unexpectedly parsed as ${JSON.stringify(parsed)}`)
  }
  return parsed
}

describe('parseSelector 的八种写法', () => {
  it('self / left / right / parent 各解析为自己那一支', () => {
    expect(selector('self')).toEqual({ kind: 'self' })
    expect(selector('left')).toEqual({ kind: 'relative', direction: 'left' })
    expect(selector('right')).toEqual({ kind: 'relative', direction: 'right' })
    expect(selector('parent')).toEqual({ kind: 'relation', relation: 'parent' })
  })

  it('child:N 带序号，裸 child 默认第 1 个（对齐码头 host-topology-projector.ts:110 的 `selector.ordinal ?? 1`）', () => {
    expect(selector('child:3')).toEqual({ kind: 'relation', relation: 'child', ordinal: 3 })
    expect(selector('child')).toEqual({ kind: 'relation', relation: 'child', ordinal: 1 })
  })

  it('sibling:N 带序号；裸 sibling 不给默认值（码头 host-control-server.ts:474-479 里 sibling.ordinal 是必填）', () => {
    expect(selector('sibling:2')).toEqual({ kind: 'sibling', ordinal: 2 })
    const bare = failure('sibling')
    expect(bare.reason).toContain('sibling:1')
  })

  it('session:<id> 与裸 id 解析为同一个 {kind:"session"}', () => {
    expect(selector('session:abc')).toEqual({ kind: 'session', sessionId: 'abc' })
    expect(selector('abc')).toEqual(selector('session:abc'))
  })

  it('裸的真实 DSH 会话 id（session-<uuid>）不被 `session:` 前缀剥离误伤', () => {
    expect(selector(REAL_SESSION_ID)).toEqual({ kind: 'session', sessionId: REAL_SESSION_ID })
    expect(selector(`session:${REAL_SESSION_ID}`)).toEqual({ kind: 'session', sessionId: REAL_SESSION_ID })
  })

  it('含冒号的 session id 只剥一次 `session:` 前缀', () => {
    expect(selector('session:a:b')).toEqual({ kind: 'session', sessionId: 'a:b' })
    expect(selector('session:session:a')).toEqual({ kind: 'session', sessionId: 'session:a' })
  })

  it('两侧空白被裁掉后再解析', () => {
    expect(selector('  self  ')).toEqual({ kind: 'self' })
    expect(selector('\tchild:2\n')).toEqual({ kind: 'relation', relation: 'child', ordinal: 2 })
  })
})

describe('parseSelector 的大小写敏感', () => {
  it('关键字大小写敏感：Left 不是 relative，而是一个（多半找不到的）会话 id', () => {
    expect(selector('Left')).toEqual({ kind: 'session', sessionId: 'Left' })
    expect(selector('SELF')).toEqual({ kind: 'session', sessionId: 'SELF' })
    expect(selector('Child:2')).toEqual({ kind: 'session', sessionId: 'Child:2' })
  })
})

describe('parseSelector 的序号边界', () => {
  it('1..10000 内接受，两端边界都算数', () => {
    expect(selector('child:1')).toEqual({ kind: 'relation', relation: 'child', ordinal: 1 })
    expect(selector(`child:${SELECTOR_ORDINAL_MAX}`)).toEqual({
      kind: 'relation',
      relation: 'child',
      ordinal: SELECTOR_ORDINAL_MAX,
    })
    expect(selector(`sibling:${SELECTOR_ORDINAL_MAX}`)).toEqual({ kind: 'sibling', ordinal: SELECTOR_ORDINAL_MAX })
    expect(SELECTOR_ORDINAL_MAX).toBe(10_000)
  })

  it('0 / 负数 / 超出上限全部失败，且原因里说清区间与收到的值', () => {
    for (const raw of ['child:0', 'child:-1', 'child:10001', 'sibling:0', 'sibling:-1', 'sibling:10001']) {
      const reason = failure(raw).reason
      expect(reason, raw).toContain('between 1 and 10000')
    }
    expect(failure('child:0').reason).toContain('"0"')
    expect(failure('child:-1').reason).toContain('"-1"')
    expect(failure('child:10001').reason).toContain('"10001"')
  })

  it('非十进制整数的序号失败，不退化成会话 id', () => {
    for (const raw of ['sibling:abc', 'child:abc', 'child:1.5', 'child:1e3', 'child:+1', 'child:', 'sibling:']) {
      expect(failure(raw).reason, raw).toContain('between 1 and 10000')
    }
  })

  it('前导零按十进制读（与码头 /^child:(\\d+)$/ + Number() 一致）', () => {
    expect(selector('child:007')).toEqual({ kind: 'relation', relation: 'child', ordinal: 7 })
  })
})

describe('parseSelector 的空输入与畸形输入', () => {
  it('空串与纯空白失败，并把八种写法列进原因里', () => {
    for (const raw of ['', ' ', '\t', '\n  \t']) {
      const reason = failure(raw).reason
      expect(reason, JSON.stringify(raw)).toContain('sibling:N')
      expect(reason, JSON.stringify(raw)).toContain('session id')
    }
  })

  it('带内部空白的整句不被当成会话 id', () => {
    const reason = failure('the one on the right').reason
    expect(reason).toContain('single token')
  })

  it('超长输入失败而不是变成一个巨大的会话 id（码头 host-control-server.ts:463 的 160 上限）', () => {
    expect(SELECTOR_MAX_LENGTH).toBe(160)
    expect(selector('a'.repeat(SELECTOR_MAX_LENGTH))).toEqual({
      kind: 'session',
      sessionId: 'a'.repeat(SELECTOR_MAX_LENGTH),
    })
    expect(failure('a'.repeat(SELECTOR_MAX_LENGTH + 1)).reason).toContain('160')
  })

  it('只有 `session:` 前缀而没有 id 时失败', () => {
    expect(failure('session:').reason).toContain('session id')
  })
})

describe('selectorNeedsRevision', () => {
  /**
   * 「按位置寻址」的四种写法都要版本号。`left`/`right` 是第二轮活体走查加进来的：
   * 当时模型在同一轮里先让 `right` 干活、再停掉 `right`，两次打到了**不同的卡**
   * ——因为第一条消息让目标卡「最近交互」时间前移、被顶到本层最前，调用方退了一
   * 位，它的「右边」就换了人。位置型选择器与序号型的失效方式完全一样，因此吃同
   * 一道闸门。
   */
  it('按位置寻址的四种写法都需要拓扑版本号', () => {
    for (const raw of ['sibling:2', 'child:3', 'child', 'left', 'right']) {
      expect(selectorNeedsRevision(selector(raw)), raw).toBe(true)
    }
  })

  /**
   * 反例，钉住的是「只有位置型才要」这半个语义：若实现改成「一律要版本号」，上面
   * 那条照样绿，只有这条会红。`self` 是我自己、`parent` 是一条边、`session:<id>`
   * 是身份——重排动不了它们指向谁。
   */
  it('身份型不需要（重排动不了它们指向谁）', () => {
    for (const raw of ['self', 'parent', 'session:abc', REAL_SESSION_ID]) {
      expect(selectorNeedsRevision(selector(raw)), raw).toBe(false)
    }
  })
})
