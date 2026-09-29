import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_RECENT_TURNS,
  MAX_MAX_MESSAGES,
  MAX_RECENT_TURNS,
  PER_MESSAGE_CHARS,
  TOTAL_CHARS,
  shapeHistory,
  shapeRecentTurns,
} from '../src/control/read.ts'
import type { HistoryEvent, TurnOutlineEntryLike } from '../src/control/read.ts'
import { composeControlMessage } from '../src/control/compose.ts'

const entry = (turn: number, over: Partial<TurnOutlineEntryLike> = {}): TurnOutlineEntryLike =>
  Object.freeze({ turn, seq: turn * 10, prompt: `p${turn}`, response: `r${turn}`, ...over })

const entries = (count: number): readonly TurnOutlineEntryLike[] =>
  Object.freeze(Array.from({ length: count }, (_, index) => entry(index + 1)))

/** A `user/message` event exactly as DSH logs it (data IS the UserMessage). */
const userEvent = (seq: number, text: string): HistoryEvent => Object.freeze({
  seq,
  type: 'user/message',
  data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

/** An `assistant/message` event: the message hides one level down, beside turn/step. */
const assistantEvent = (seq: number, blocks: readonly unknown[]): HistoryEvent => Object.freeze({
  seq,
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 0,
    message: { id: `m${seq}`, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'x', model: 'y' } },
  },
})

/** A `tool/result` event: the model-facing text sits inside a nested tool-result block. */
const toolResultEvent = (seq: number, text: string): HistoryEvent => Object.freeze({
  seq,
  type: 'tool/result',
  data: {
    turn: 1,
    step: 0,
    message: {
      id: `m${seq}`,
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text }], isError: false }],
    },
  },
})

describe('shapeRecentTurns', () => {
  it('取最后 N 条轮次，并回报全部轮次数', () => {
    const out = shapeRecentTurns(entries(5), 2)
    expect(out.turns.map(t => t.turn)).toEqual([4, 5]) // 最后两条，且保持升序
    expect(out.total_turns).toBe(5)
    expect(out.note).toBeUndefined()
  })

  it('turns 缺省取 3 条', () => {
    expect(DEFAULT_RECENT_TURNS).toBe(3)
    expect(shapeRecentTurns(entries(9)).turns.map(t => t.turn)).toEqual([7, 8, 9])
  })

  it('turns 上限 20，越界按 20 截', () => {
    expect(MAX_RECENT_TURNS).toBe(20)
    expect(shapeRecentTurns(entries(30), 50).turns).toHaveLength(20)
    expect(shapeRecentTurns(entries(30), 50).turns[0]?.turn).toBe(11) // 保留的是最新的 20 条
  })

  it('turns 非正整数时回落默认值，而不是产出空结果', () => {
    expect(shapeRecentTurns(entries(9), 0).turns).toHaveLength(3)
    expect(shapeRecentTurns(entries(9), -4).turns).toHaveLength(3)
    expect(shapeRecentTurns(entries(9), 2.5).turns).toHaveLength(3)
    expect(shapeRecentTurns(entries(9), Number.NaN).turns).toHaveLength(3)
  })

  /** 部署没挂 session-turn-outline：投影键整个缺席，绝不能抛错。 */
  it('entries 为 undefined 时回空结果 + 一句说明，不抛错', () => {
    const out = shapeRecentTurns(undefined, 3)
    expect(out.turns).toEqual([])
    expect(out.total_turns).toBe(0)
    expect(typeof out.note).toBe('string')
    expect(out.note?.length).toBeGreaterThan(0)
  })

  /** 「没挂投影」与「会话一轮都还没跑」不是一回事，后者不带 note。 */
  it('entries 为空数组时不带 note', () => {
    const out = shapeRecentTurns([], 3)
    expect(out.turns).toEqual([])
    expect(out.total_turns).toBe(0)
    expect(out.note).toBeUndefined()
  })

  it('prompt / response 为空串时原样保留，不当作缺失丢掉', () => {
    const out = shapeRecentTurns([entry(1, { prompt: '', response: '' })], 3)
    expect(out.turns).toHaveLength(1)
    expect(out.turns[0]).toEqual({ turn: 1, seq: 10, prompt: '', response: '' })
  })

  it('不改动入参数组', () => {
    const input = entries(4)
    shapeRecentTurns(input, 2)
    expect(input.map(e => e.turn)).toEqual([1, 2, 3, 4])
  })
})

describe('shapeHistory', () => {
  it('只保留三类带消息的事件，其余事件类型不出现', () => {
    const out = shapeHistory([
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      userEvent(2, 'hi'),
      { seq: 3, type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: {} } },
      { seq: 4, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c', name: 'bash', arguments: '{}' } },
      assistantEvent(5, [{ type: 'text', text: 'ho' }]),
      toolResultEvent(6, 'done'),
      { seq: 7, type: 'turn/end', data: {} },
    ])
    expect(out.messages.map(m => m.seq)).toEqual([2, 5, 6])
  })

  it('角色按事件类型映射，文本从各自的嵌套位置取出', () => {
    const out = shapeHistory([userEvent(1, 'ask'), assistantEvent(2, [{ type: 'text', text: 'answer' }]), toolResultEvent(3, 'output')])
    expect(out.messages).toEqual([
      { seq: 1, role: 'user', text: 'ask' },
      { seq: 2, role: 'assistant', text: 'answer' },
      { seq: 3, role: 'tool', text: 'output' },
    ])
  })

  /** reasoning 是「思考」不是可见文本，控制面读的是对方说了什么。 */
  it('多个 text 块换行拼接；reasoning 与 tool-call 块不进正文', () => {
    const out = shapeHistory([assistantEvent(1, [
      { type: 'reasoning', text: 'SECRET-THINKING' },
      { type: 'text', text: 'line one' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'text', text: 'line two' },
    ])])
    expect(out.messages[0]?.text).toBe('line one\nline two')
  })

  it('取最新的 max_messages 条，并给出向后翻页的游标', () => {
    const log = [userEvent(1, 'a'), userEvent(2, 'b'), userEvent(3, 'c'), userEvent(4, 'd'), userEvent(5, 'e')]
    const out = shapeHistory(log, { maxMessages: 2 })
    expect(out.messages.map(m => m.seq)).toEqual([4, 5])
    expect(out.has_more).toBe(true)
    expect(out.next_before_seq).toBe(4) // 下一页从最旧一条之前继续
  })

  it('max_messages 默认 50、上限 100（照 DSH 自己的数）', () => {
    expect(DEFAULT_MAX_MESSAGES).toBe(50)
    expect(MAX_MAX_MESSAGES).toBe(100)
    const log = Array.from({ length: 120 }, (_, index) => userEvent(index + 1, 'x'))
    expect(shapeHistory(log, { totalChars: 1_000_000 }).messages).toHaveLength(50)
    expect(shapeHistory(log, { maxMessages: 1000, totalChars: 1_000_000 }).messages).toHaveLength(100)
  })

  it('before_seq 是独占上界', () => {
    const log = [userEvent(1, 'a'), userEvent(2, 'b'), userEvent(3, 'c')]
    const out = shapeHistory(log, { beforeSeq: 3 })
    expect(out.messages.map(m => m.seq)).toEqual([1, 2]) // seq 3 本身被排除
    expect(out.has_more).toBe(false)
    expect('next_before_seq' in out).toBe(false)
  })

  it('正好取完时 has_more 为假且不给游标', () => {
    const log = [userEvent(1, 'a'), userEvent(2, 'b')]
    const out = shapeHistory(log, { maxMessages: 2 })
    expect(out.messages).toHaveLength(2)
    expect(out.has_more).toBe(false)
    expect('next_before_seq' in out).toBe(false)
    expect(out.truncated).toBe(false)
  })

  it('单条超上限时尾截并标记，未超的条目不带该标记', () => {
    expect(PER_MESSAGE_CHARS).toBe(2000)
    const long = 'L'.repeat(PER_MESSAGE_CHARS + 500)
    const out = shapeHistory([userEvent(1, 'short'), userEvent(2, long)])
    expect(out.messages[0]?.text).toBe('short')
    expect('truncated' in (out.messages[0] as object)).toBe(false)
    expect(out.messages[1]?.text).toBe(long.slice(0, PER_MESSAGE_CHARS)) // 保留开头，砍掉尾巴
    expect(out.messages[1]?.truncated).toBe(true)
    expect(out.truncated).toBe(true)
  })

  it('整体超预算时从最旧的一端丢弃整条，不丢半条', () => {
    expect(TOTAL_CHARS).toBe(20_000)
    const body = 'x'.repeat(PER_MESSAGE_CHARS)
    const log = Array.from({ length: 12 }, (_, index) => userEvent(index + 1, body))
    const out = shapeHistory(log)
    expect(out.messages).toHaveLength(10) // 12 × 2000 = 24000 > 20000，丢掉最旧两条
    expect(out.messages.map(m => m.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(out.messages.every(m => m.text.length === PER_MESSAGE_CHARS)).toBe(true) // 每条都是整条
    expect(out.messages.every(m => !('truncated' in m))).toBe(true) // 丢弃不是单条截断
    expect(out.truncated).toBe(true)
    expect(out.has_more).toBe(true)
    expect(out.next_before_seq).toBe(3)
  })

  it('总量正好等于预算时不丢弃', () => {
    const body = 'x'.repeat(PER_MESSAGE_CHARS)
    const log = Array.from({ length: 10 }, (_, index) => userEvent(index + 1, body))
    const out = shapeHistory(log)
    expect(out.messages).toHaveLength(10)
    expect(out.truncated).toBe(false)
    expect(out.has_more).toBe(false)
  })

  it('空日志回空结果', () => {
    const out = shapeHistory([])
    expect(out).toEqual({ messages: [], has_more: false, truncated: false })
  })

  it('只有非消息事件时也回空结果，不报 has_more', () => {
    const out = shapeHistory([{ seq: 1, type: 'turn/start', data: {} }])
    expect(out.messages).toEqual([])
    expect(out.has_more).toBe(false)
  })

  it('数据形状异常时给空正文而不是抛错', () => {
    const out = shapeHistory([
      { seq: 1, type: 'user/message', data: undefined },
      { seq: 2, type: 'assistant/message', data: { turn: 1, step: 0 } },
      { seq: 3, type: 'tool/result', data: { message: { content: 'not-an-array' } } },
    ])
    expect(out.messages.map(m => m.text)).toEqual(['', '', ''])
  })

  it('不改动入参数组', () => {
    const log = [userEvent(1, 'a'), userEvent(2, 'b'), userEvent(3, 'c')]
    shapeHistory(log, { maxMessages: 1 })
    expect(log.map(e => e.seq)).toEqual([1, 2, 3])
  })
})

describe('composeControlMessage', () => {
  it('正文带来源前缀：ref + 标题', () => {
    expect(composeControlMessage('session:abc', '重构登录页', '把测试跑一遍'))
      .toBe('[from session:abc (重构登录页)] 把测试跑一遍')
  })

  it('标题为空串时退化为只带 ref', () => {
    expect(composeControlMessage('session:abc', '', 'hello')).toBe('[from session:abc] hello')
  })

  it('标题只有空白时同样退化', () => {
    expect(composeControlMessage('session:abc', '   ', 'hello')).toBe('[from session:abc] hello')
  })

  /** 前缀必须占一行：标题里的换行会把「这条是谁发的」拆得看不出来。 */
  it('标题里的换行被折叠成空格，前缀保持单行', () => {
    expect(composeControlMessage('session:abc', 'a\nb  c', 'hi')).toBe('[from session:abc (a b c)] hi')
  })

  it('正文原样保留，不转义、不裁剪、不折行', () => {
    const body = 'line1\nline2 [not a prefix] (parens) 中文'
    expect(composeControlMessage('session:abc', 'T', body)).toBe(`[from session:abc (T)] ${body}`)
  })

  it('正文为空串时仍然带前缀', () => {
    expect(composeControlMessage('session:abc', 'T', '')).toBe('[from session:abc (T)] ')
  })
})
