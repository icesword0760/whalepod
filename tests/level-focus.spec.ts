/**
 * 第三轮活体走查（2026-09-07，窗口在前台、实测 144 fps）抓到的：
 * **切走页签再切回来，焦点卡换了人。**
 *
 * spec §7.1 第 6 条要求「切走页签再切回：焦点卡、滚动位置不变」。实测**滚动位置
 * 恢复了、焦点没有**：存档里明明记着 `focusedSessionId: c4a42a6c`，切回来却落在本层
 * 第一张卡上。
 *
 * 根因很干脆：`geometry-store.ts` 一直在**写** `focusedSessionId`，但全仓**没有任何
 * 地方读它**。`useCarouselController` 的恢复副作用只用 `scrollLeft` 与锚点；焦点是
 * DSH 的当前会话，轮播控制器改不了它，而 `AppFrame` 里挑焦点的那行写的是
 * `currentLevelNodes[0]?.sessionId`——本层第一张。于是「回到这个页签」永远回到第一张。
 *
 * 产品上：你在一排卡里选中第 5 张开始干活，切去别的页签办点事，回来发现焦点跑到了
 * 第 1 张——而且因为排序是「最近交互靠前」，第 1 张往往还不是你刚才那张。
 *
 * 这条规则此前**一行测试都没有**（`AppFrame` 里那段逻辑只在集成测试里被顺带跑到），
 * 所以这里把它提成纯函数并逐条钉住。
 */
import { describe, expect, it } from 'vitest'
import { levelFocusTargetOf } from '../src/client/carousel/level-focus.ts'

const LEVEL = ['a', 'b', 'c']

describe('levelFocusTargetOf', () => {
  /** 规则 1（码头 `SessionCanvas.tsx:43-46`）：没有显式层时，层是由焦点推导出来的，轮不到它挑焦点。 */
  it('没有显式层时不表态', () => {
    expect(levelFocusTargetOf({
      explicitParentId: undefined,
      currentSessionId: 'zzz',
      currentParentId: 'somewhere-else',
      parentId: undefined,
      levelSessionIds: LEVEL,
      persistedFocusedSessionId: 'b',
    })).toBeUndefined()
  })

  it('当前会话就在本层时不表态（它已经是焦点了）', () => {
    expect(levelFocusTargetOf({
      explicitParentId: null,
      currentSessionId: 'c',
      currentParentId: undefined,
      parentId: undefined,
      levelSessionIds: LEVEL,
      persistedFocusedSessionId: 'a',
    })).toBeUndefined()
  })

  /** 本条就是走查抓到的那个缺陷。 */
  it('当前会话不在本层时，优先回到这一层上次记住的那张', () => {
    expect(levelFocusTargetOf({
      explicitParentId: null,
      currentSessionId: 'zzz',
      currentParentId: 'other',
      parentId: undefined,
      levelSessionIds: LEVEL,
      persistedFocusedSessionId: 'c',
    })).toBe('c')
  })

  /**
   * 反例，钉住「记住的那张必须还在本层」：会话被移除/归档后存档还留着它的 id，
   * 照着它开会开出一张不存在的卡（界面上表现为焦点卡空白）。
   */
  it('记住的那张已经不在本层时，退回第一张', () => {
    expect(levelFocusTargetOf({
      explicitParentId: null,
      currentSessionId: 'zzz',
      currentParentId: 'other',
      parentId: undefined,
      levelSessionIds: LEVEL,
      persistedFocusedSessionId: 'removed-one',
    })).toBe('a')
  })

  it('没有存档时退回第一张（保持原有行为）', () => {
    expect(levelFocusTargetOf({
      explicitParentId: null,
      currentSessionId: 'zzz',
      currentParentId: 'other',
      parentId: undefined,
      levelSessionIds: LEVEL,
      persistedFocusedSessionId: undefined,
    })).toBe('a')
  })

  it('空层不表态（用户刚把这一层的卡全删了，应当能在这儿新建）', () => {
    expect(levelFocusTargetOf({
      explicitParentId: 'p1',
      currentSessionId: 'zzz',
      currentParentId: 'other',
      parentId: 'p1',
      levelSessionIds: [],
      persistedFocusedSessionId: 'b',
    })).toBeUndefined()
  })

  it('完全没有当前会话时也按同一条规则挑', () => {
    expect(levelFocusTargetOf({
      explicitParentId: 'p1',
      currentSessionId: undefined,
      currentParentId: undefined,
      parentId: 'p1',
      levelSessionIds: LEVEL,
      persistedFocusedSessionId: 'b',
    })).toBe('b')
  })
})
