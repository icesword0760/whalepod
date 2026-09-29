/**
 * 第三轮活体走查（2026-09-07）抓到的缺陷：**四个工具的返回，模型只收到一行计数。**
 *
 * DSH 的 `defineTool` 里，`output.render` 产出的**就是模型看到的内容**
 * （`packages/core/tools/src/schema.ts:494`「Pure Native/model rendering of one
 * validated canonical value」、`index.ts:284`「The final model-facing content」），
 * `output.schema` 那个结构化 value 只进日志与 UI。本插件把 render 写成了摘要行：
 *
 * - `matou_list_sessions` → 「6 session(s) in scope "level"」：**没有会话明细，
 *   也没有 topology_revision**。模型因此无法按位置寻址——走查里它连着调了三次
 *   list 都拿不到版本号，最后空转到被我掐掉。
 * - `matou_read_recent` → 「3 of 8 turn(s) from …」：**读不到任何内容**。
 * - `matou_read_history` → 「20 message(s) from …」：同上。
 * - `matou_identify_self` 那一句是对的，但**漏了 topology_revision**，于是「先认
 *   自己再按位置寻址」这条路也是断的。
 *
 * 产品后果：「看看右边那张在干什么」这件事根本做不到——AI 只知道「有 8 轮」，
 * 说不出内容；「告诉右边那张……」在 `left`/`right` 收紧吃版本号之后也直接失效。
 *
 * **为什么 35 条工具测试全绿还是漏了**：`control-tools.spec.ts` 的 `run()` 只断言
 * `render(...)` 返回的数组**非空**，从不看里面写了什么，而所有内容断言都打在
 * `execute()` 返回的 value 上——那个 value 模型根本看不到。所以这个文件专门只测
 * 「模型读到的那串文本」，每条都是「载荷里的关键事实必须出现在文本里」。
 */
import { describe, expect, it } from 'vitest'
import {
  renderHistory,
  renderIdentity,
  renderRecentTurns,
  renderSessionList,
} from '../src/control/render.ts'

const IDENTITY = {
  ref: 'session:me',
  session_id: 'me',
  title: '我这张',
  cwd: '/work/me',
  workspace: { id: 'ws1', title: '演示工作区', ordinal: 1 },
  task: { id: 't1', title: '事项一', ordinal: 1 },
  scene: { id: 'sc1', title: '默认', ordinal: 1 },
  depth: 1,
  level_ordinal: 2,
  level_size: 3,
  parent_ref: 'session:dad',
  child_refs: ['session:kid1', 'session:kid2'],
  level: [
    { ordinal: 1, ref: 'session:a', session_id: 'a', title: '左边', running: false, blank: false, is_self: false, cwd: '/work/a' },
    { ordinal: 2, ref: 'session:me', session_id: 'me', title: '我这张', running: true, blank: false, is_self: true, cwd: '/work/me' },
    { ordinal: 3, ref: 'session:c', session_id: 'c', title: '右边', running: false, blank: true, is_self: false },
  ],
  topology_revision: 'rev-7f3a',
  selector_syntax: 'a target is one of self, left, right, parent, child:N, sibling:N, session:<id>',
}

describe('renderIdentity —— 模型读到的「我在哪」', () => {
  const text = renderIdentity(IDENTITY as never)

  it('带上 topology_revision（走查里模型正是因为拿不到它而空转）', () => {
    expect(text).toContain('rev-7f3a')
  })

  it('位置、路径、标题都在', () => {
    expect(text).toContain('session:me')
    expect(text).toContain('我这张')
    expect(text).toContain('2 of 3')
    expect(text).toContain('演示工作区')
    expect(text).toContain('事项一')
  })

  it('父与子都点名到 ref，不是只给个数字', () => {
    expect(text).toContain('session:dad')
    expect(text).toContain('session:kid1')
    expect(text).toContain('session:kid2')
  })

  it('同层每一张都列出来，且标出哪张是自己', () => {
    expect(text).toContain('sibling:1')
    expect(text).toContain('sibling:3')
    expect(text).toContain('左边')
    expect(text).toContain('右边')
    expect(text.split('\n').find(l => l.includes('sibling:2'))).toMatch(/you/)
  })

  /** 反例：没有父时不能编一个出来，也不能只说「parent:」留白。 */
  it('根层会话明说「没有父」，而不是留一个空位', () => {
    const root = { ...IDENTITY, depth: 0, child_refs: [] }
    delete (root as Record<string, unknown>)['parent_ref']
    const rooted = renderIdentity(root as never)
    expect(rooted).not.toContain('session:dad')
    expect(rooted).toMatch(/no parent|top level/i)
    // 「none」在「parent: none」里也会命中，所以这里连字段名一起断言。
    expect(rooted).toContain('children: none')
    expect(rooted).not.toContain('child:1')
  })
})

const LEVEL_LIST = {
  scope: 'level' as const,
  sessions: [
    { ordinal: 1, ref: 'session:a', session_id: 'a', title: '左边', path: '演示工作区 / 事项一 / 默认', depth: 1, running: false, blank: false, is_self: false, cwd: '/work/a' },
    { ordinal: 2, ref: 'session:me', session_id: 'me', title: '我这张', path: '演示工作区 / 事项一 / 默认', depth: 1, running: true, blank: false, is_self: true, cwd: '/work/me' },
  ],
  topology_revision: 'rev-7f3a',
}

describe('renderSessionList —— 模型读到的「旁边有哪些卡」', () => {
  it('level 档：每张卡的序号、ref、标题都在，版本号也在', () => {
    const text = renderSessionList(LEVEL_LIST as never)
    expect(text).toContain('sibling:1')
    expect(text).toContain('sibling:2')
    expect(text).toContain('session:a')
    expect(text).toContain('左边')
    expect(text).toContain('我这张')
    expect(text).toContain('rev-7f3a')
  })

  it('level 档：标出哪张是自己、哪张在跑', () => {
    const text = renderSessionList(LEVEL_LIST as never)
    const mine = text.split('\n').find(l => l.includes('session:me'))
    expect(mine).toMatch(/you/)
    expect(mine).toMatch(/running/)
  })

  /**
   * 反例，钉住「序号只在本层有意义」这半个语义：all 档给的是整个工作台，
   * 序号在那里不成立，若实现照抄 level 档的写法，模型会拿一个跨层的序号去
   * `sibling:N`，打到别人身上。
   */
  it('all 档：给路径、不给序号，并说清要用 session:<id> 寻址', () => {
    const text = renderSessionList({
      scope: 'all',
      sessions: [
        { ref: 'session:x', session_id: 'x', title: '别层的', path: '演示工作区 / 事项二 / 默认', depth: 0, running: false, blank: false, is_self: false },
      ],
      topology_revision: 'rev-7f3a',
    } as never)
    expect(text).toContain('session:x')
    expect(text).toContain('事项二')
    expect(text).not.toContain('sibling:')
    expect(text).toContain('session:<id>')
  })

  it('一张都没有时说人话，而不是给个空列表', () => {
    const text = renderSessionList({ scope: 'level', sessions: [], topology_revision: 'rev-0' } as never)
    expect(text).toMatch(/no other|only card|1 card|no card/i)
    expect(text).toContain('rev-0')
  })
})

describe('renderRecentTurns —— 模型读到的「它最近在干什么」', () => {
  const value = {
    target: { ref: 'session:x', title: '右边那张' },
    turns: [
      { turn: 6, seq: 40, prompt: '把测试跑一遍', response: '跑完了，3 个失败' },
      { turn: 7, seq: 44, prompt: '修掉第一个', response: '已修，重跑全绿' },
    ],
    total_turns: 8,
    as_of_seq: 44,
  }

  it('每一轮的提问与回复都出现在文本里（这是这个工具存在的全部理由）', () => {
    const text = renderRecentTurns(value as never)
    expect(text).toContain('把测试跑一遍')
    expect(text).toContain('跑完了，3 个失败')
    expect(text).toContain('修掉第一个')
    expect(text).toContain('已修，重跑全绿')
  })

  it('说清这是 8 轮里的哪 2 轮，并点名目标', () => {
    const text = renderRecentTurns(value as never)
    expect(text).toContain('session:x')
    expect(text).toContain('右边那张')
    expect(text).toContain('8')
  })

  /** 退化档：这个部署没有轮次投影时，只有一句说明，不能假装读到了空内容。 */
  it('退化时原样给出那句说明', () => {
    const text = renderRecentTurns({
      target: { ref: 'session:x', title: '右边那张' },
      turns: [], total_turns: 0,
      note: 'this deployment has no turn outline; use matou_read_history instead.',
    } as never)
    expect(text).toContain('matou_read_history')
    expect(text).not.toMatch(/^0 of 0 turn\(s\)$/)
  })
})

describe('renderHistory —— 模型读到的「它说过什么」', () => {
  const value = {
    target: { ref: 'session:x', title: '右边那张' },
    messages: [
      { seq: 40, role: 'user' as const, text: '你好' },
      { seq: 41, role: 'assistant' as const, text: '你好，有什么可以帮你' },
      { seq: 42, role: 'tool' as const, text: '（很长的输出…）', truncated: true },
    ],
    has_more: true,
    next_before_seq: 40,
    truncated: true,
    as_of_seq: 42,
  }

  it('每条消息的角色与正文都出现在文本里', () => {
    const text = renderHistory(value as never)
    expect(text).toContain('你好，有什么可以帮你')
    expect(text).toContain('user')
    expect(text).toContain('assistant')
    expect(text).toContain('tool')
  })

  it('还有更多时，把翻页要用的 before_seq 直接给出来', () => {
    const text = renderHistory(value as never)
    expect(text).toContain('before_seq')
    expect(text).toContain('40')
  })

  it('被截断的单条标出来，免得模型把半句话当成全部', () => {
    const text = renderHistory(value as never)
    expect(text.split('\n').find(l => l.includes('（很长的输出…）'))).toMatch(/truncated/i)
  })

  /** 反例：没有更多时不许出现翻页指引，否则模型会为一页不存在的历史再调一次。 */
  it('没有更多时不提翻页', () => {
    const text = renderHistory({
      target: { ref: 'session:x', title: '右边那张' },
      messages: [{ seq: 1, role: 'user' as const, text: '就一条' }],
      has_more: false, truncated: false, as_of_seq: 1,
    } as never)
    expect(text).not.toContain('before_seq')
    expect(text).toContain('就一条')
  })
})
