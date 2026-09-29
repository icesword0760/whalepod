/**
 * 第三轮活体走查（2026-09-07，窗口在前台、实测 144 fps）抓到的：
 * **你正在操作的那张卡，一发消息就当场跳位。**
 *
 * spec §7.1 第 5 条写的是「焦点离开后卡片按最近交互重排，**正在操作的卡不跳位**」。
 * 实测：把焦点放在第 5 张、在里面发一条消息，它<b>立刻</b>窜到第 1 位，整条带子在
 * 用户眼皮底下重排。
 *
 * 码头的做法（源码为准，`apps/runtime/src/session-canvas/session-interaction-service.ts:76-96`
 * 与 `hierarchy/hierarchy-application-service.ts:2295-2303`）是一对 pending/commit：
 *
 * - 交互发生在**当前被聚焦**的会话上 → 只写 `pending_user_interaction_seq`，
 *   排序键 `last_user_interaction_seq` **不动**；
 * - 交互发生在别的会话上 → 直接写 `last_user_interaction_seq`，立刻上浮；
 * - **焦点离开它时**，才把 pending 提交为正式排序键。
 *
 * 我们这边直接拿 DSH 的 `updatedAt`（= `max(createdAt, lastPromptAt)`，本身就是
 * 「最后一次用户提问」的时刻）当排序键，等于永远走第二档，所以聚焦卡也当场跳。
 *
 * 这个函数就是那对 pending/commit 的判定部分：**谁现在该把 live 值提交成排序键**。
 * pending 是隐式的——live 值一直在动，只是聚焦期间不提交，焦点一走就提交。
 */
import { describe, expect, it } from 'vitest'
import { interactionCommits } from '../src/client/carousel/interaction-commit.ts'

describe('interactionCommits', () => {
  it('非聚焦会话有了更新的交互时刻 → 立刻提交（它本来就该上浮）', () => {
    expect(interactionCommits({
      focusedSessionId: 'me',
      sessions: [{ sessionId: 'other', placed: true, liveInteractionAt: 50, committedAt: 20 }],
    })).toEqual([{ sessionId: 'other', at: 50 }])
  })

  /** 缺陷本体：聚焦期间 live 再怎么涨，排序键都不动。 */
  it('聚焦中的会话 live 涨了也不提交（正在操作的卡不跳位）', () => {
    expect(interactionCommits({
      focusedSessionId: 'me',
      sessions: [{ sessionId: 'me', placed: true, liveInteractionAt: 99, committedAt: 20 }],
    })).toEqual([])
  })

  /** 焦点一离开就补交——这是码头那次 `SET last = pending` 的等价物。 */
  it('焦点离开后，攒下的 live 值一次性提交', () => {
    expect(interactionCommits({
      focusedSessionId: 'someone-else',
      sessions: [{ sessionId: 'me', placed: true, liveInteractionAt: 99, committedAt: 20 }],
    })).toEqual([{ sessionId: 'me', at: 99 }])
  })

  /**
   * 聚焦的会话若**还没有**排序键，必须当场钉一个下来。否则升级后第一次聚焦时
   * 它没有已提交值，投影只能退回读 live 的 `updatedAt`，第一条消息照样让它跳走。
   */
  it('聚焦中但还没有排序键时，当场按 live 钉一个', () => {
    expect(interactionCommits({
      focusedSessionId: 'me',
      sessions: [{ sessionId: 'me', placed: true, liveInteractionAt: 42, committedAt: undefined }],
    })).toEqual([{ sessionId: 'me', at: 42 }])
  })

  it('没有排序键的非聚焦会话也补一个', () => {
    expect(interactionCommits({
      focusedSessionId: 'me',
      sessions: [{ sessionId: 'other', placed: true, liveInteractionAt: 0, committedAt: undefined }],
    })).toEqual([{ sessionId: 'other', at: 0 }])
  })

  /** 反例：值没变就不许写。否则每帧一次存储写入，且会把「不跳位」变成「一直在跳」。 */
  it('已提交值已经是最新时不产生任何写入', () => {
    expect(interactionCommits({
      focusedSessionId: 'me',
      sessions: [
        { sessionId: 'me', placed: true, liveInteractionAt: 20, committedAt: 20 },
        { sessionId: 'other', placed: true, liveInteractionAt: 50, committedAt: 50 },
      ],
    })).toEqual([])
  })

  /** 反例：排序键只增不减。DSH 若因为任何原因把 updatedAt 报小了，不该让卡片倒退。 */
  it('live 比已提交值小时不回退', () => {
    expect(interactionCommits({
      focusedSessionId: undefined,
      sessions: [{ sessionId: 'other', placed: true, liveInteractionAt: 10, committedAt: 30 }],
    })).toEqual([])
  })

  it('没有焦点时，所有落后的会话一起提交', () => {
    expect(interactionCommits({
      focusedSessionId: undefined,
      sessions: [
        { sessionId: 'a', placed: true, liveInteractionAt: 5, committedAt: 1 },
        { sessionId: 'b', placed: true, liveInteractionAt: 7, committedAt: 7 },
        { sessionId: 'c', placed: true, liveInteractionAt: 9, committedAt: undefined },
      ],
    })).toEqual([{ sessionId: 'a', at: 5 }, { sessionId: 'c', at: 9 }])
  })

  /**
   * 2026-09-14 桌面端走查：用户点「新会话」永远建不出来。
   *
   * 原因不在新建那条路上——是这个函数给**没有落位行**的会话不停发排序键：宿主的
   * `placement/interaction` 对这类会话静默忽略（`org/ops.ts` 有意为之），但那次 apply
   * 仍把 revision 加一，于是客户端看到文档变了 → 重新求值 → 发现该会话依然没有已提交
   * 的排序键 → 再写一次 → 无限循环。循环本身只是空转，真正的伤害是它把**所有别的
   * 写入挤掉**：新会话的 `placement/set` 每一次（含重试）都撞上冲突。
   *
   * 另一半闸门在宿主：批次没改变任何状态就不推进 revision（`org/model.ts` 的
   * `sameOrgState`），从结构上让这一类循环跑不起来。
   */
  it('未落位的会话一律不发排序键（否则写不进去还会烧出无限重写循环）', () => {
    expect(interactionCommits({
      focusedSessionId: undefined,
      sessions: [
        { sessionId: '未落位', placed: false, liveInteractionAt: 77, committedAt: undefined },
        { sessionId: '已落位', placed: true, liveInteractionAt: 77, committedAt: undefined },
      ],
    })).toEqual([{ sessionId: '已落位', at: 77 }])
  })

  it('未落位且已经有排序键（不该出现的历史数据）同样跳过', () => {
    expect(interactionCommits({
      focusedSessionId: undefined,
      sessions: [{ sessionId: '未落位', placed: false, liveInteractionAt: 90, committedAt: 10 }],
    })).toEqual([])
  })
})
