// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { CardShell, officialHeaderHidden } from '../src/client/carousel/CardShell.tsx'
import type { CardModel, SessionLifecycleFacts, UseSessionLifecycle } from '../src/client/carousel/CardShell.tsx'

afterEach(cleanup)

/** A spy wrapping the real zh dictionary: proves the component calls `t(key, params)` (not a hardcoded literal) while still rendering the real product copy. */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

const COMPACT_CARD: CardModel = {
  sessionId: 'a',
  title: '登录修复',
  state: 'ongoing',
  hasNotice: false,
  hasRing: false,
  childCount: 2,
  childState: 'ongoing',
  focused: false,
  blank: false,
}

describe('CardShell', () => {
  it('紧凑卡渲染 42px 头：状态点+标题+子会话徽标（经 t 取文案）；聚焦卡完全让位给官方头', () => {
    const t = spyT()
    const { rerender } = render(
      <CardShell card={COMPACT_CARD} renderPane={() => <div data-testid="pane" />} t={t} />,
    )
    expect(screen.getByText('登录修复')).toBeTruthy()
    expect(screen.getByText('子会话 2')).toBeTruthy()
    expect(t).toHaveBeenCalledWith('card.children', { n: 2 })
    expect(screen.getByTestId('pane')).toBeTruthy()

    rerender(
      <CardShell
        card={{ ...COMPACT_CARD, focused: true }}
        renderPane={(sessionKey, focused) => <div data-testid="pane">{sessionKey}:{String(focused)}</div>}
        t={t}
      />,
    )
    expect(screen.getByTestId('pane').textContent).toBe('a:true')
    // The focused card defers entirely to DSH's official header (Task 8's
    // global slot seat appears inside renderPane on its own); it must not
    // also draw the compact 42px header (that would be the "two heads").
    expect(screen.queryByText('登录修复')).toBeNull()
  })

  it('hasNotice 为真时经 t 取「新通知」文案', () => {
    const t = spyT()
    render(
      <CardShell card={{ ...COMPACT_CARD, hasNotice: true }} renderPane={() => <div />} t={t} />,
    )
    expect(screen.getByText('新通知')).toBeTruthy()
    expect(t).toHaveBeenCalledWith('card.notice')
  })

  it('聚焦卡与通知光圈反映在 aria-current 与 data-session-id 属性上', () => {
    const t = spyT()
    const { container } = render(
      <CardShell card={{ ...COMPACT_CARD, focused: true, hasRing: true }} renderPane={() => <div />} t={t} />,
    )
    const card = container.querySelector('[aria-current]') as HTMLElement
    expect(card.getAttribute('aria-current')).toBe('true')
  })
})

/**
 * D2 (S3b Task 11c review): DSH hides its own official session header for a
 * *blank* session (never had a turn) regardless of focus — see
 * `ConversationSession.tsx`'s `hideChrome`. Left alone, a focused-but-blank
 * card would show no header at all: no title, no "⋯" menu, no child badge,
 * no operable surface. `CardShell` must draw the compact 42px header
 * whenever `!focused || blank`, covering all three reachable combinations.
 */
describe('CardShell — 空白会话的头部兜底（D2）', () => {
  it('聚焦且非空白：无 42px 紧凑头（完全让位给官方头）', () => {
    const t = spyT()
    render(
      <CardShell card={{ ...COMPACT_CARD, focused: true, blank: false }} renderPane={() => <div />} t={t} />,
    )
    expect(screen.queryByText('登录修复')).toBeNull()
  })

  it('聚焦且空白：有 42px 紧凑头（官方头本就被 DSH 隐藏，不会出现双头）', () => {
    const t = spyT()
    render(
      <CardShell card={{ ...COMPACT_CARD, focused: true, blank: true }} renderPane={() => <div />} t={t} />,
    )
    expect(screen.getByText('登录修复')).toBeTruthy()
  })

  it('非聚焦（空白与否不影响）：有 42px 紧凑头', () => {
    const t = spyT()
    render(
      <CardShell card={{ ...COMPACT_CARD, focused: false, blank: true }} renderPane={() => <div />} t={t} />,
    )
    expect(screen.getByText('登录修复')).toBeTruthy()
  })
})

/**
 * I4 (final review): D2's fallback keyed off `SessionSummary.blank`, which
 * only flips once a prompt is ACCEPTED, while DSH's own header keys off the
 * session instance's live snapshot — `promptAttempted` goes true in the frame
 * the user hits send. Between those two moments (a full round trip) the
 * official header is already showing and the compact one had not yet
 * withdrawn: two heads. Worse, a failed first prompt leaves `promptAttempted`
 * true and `blank` true indefinitely, so the doubling never resolved on its
 * own.
 */
describe('officialHeaderHidden（I4：与 DSH ConversationSessionHeader 的 hideChrome 同源）', () => {
  const live = (over: Partial<SessionLifecycleFacts> = {}): SessionLifecycleFacts =>
    ({ blank: true, running: false, promptAttempted: false, ...over })

  it('从未发过消息的空白会话：DSH 隐藏官方头', () => {
    expect(officialHeaderHidden(live(), true)).toBe(true)
  })

  it('已提交第一条消息（promptAttempted 为真、blank 仍为真）：DSH 已经显示官方头', () => {
    expect(officialHeaderHidden(live({ promptAttempted: true }), true)).toBe(false)
  })

  it('运行中：无论 blank 如何，DSH 都显示官方头', () => {
    expect(officialHeaderHidden(live({ running: true }), true)).toBe(false)
  })

  it('非空白会话：DSH 显示官方头', () => {
    expect(officialHeaderHidden(live({ blank: false }), false)).toBe(false)
  })

  it('拿不到会话实例快照时回退到列表投影的 blank（诚实降级，不猜）', () => {
    expect(officialHeaderHidden(undefined, true)).toBe(true)
    expect(officialHeaderHidden(undefined, false)).toBe(false)
  })
})

describe('CardShell — 官方头判据接会话实例实时快照（I4）', () => {
  /** A `UseSessionLifecycle` stand-in over one fixed snapshot (no subscription needed in a unit test). */
  const lifecycleOf = (facts: SessionLifecycleFacts | undefined): UseSessionLifecycle =>
    (_sessionId, selector) => selector(facts)

  it('聚焦的空白卡在首条消息提交那一帧就收起紧凑头（不出现双头）', () => {
    render(
      <CardShell
        card={{ ...COMPACT_CARD, focused: true, blank: true }}
        renderPane={() => <div />}
        useSessionLifecycle={lifecycleOf({ blank: true, running: false, promptAttempted: true })}
        t={spyT()}
      />,
    )
    // `blank` from the list projection is still true here — the point of the fix.
    expect(screen.queryByText('登录修复')).toBeNull()
  })

  /**
   * Replaces a test that rerendered with IDENTICAL props (no state
   * migration, zero value over the mount-time case above). This models the
   * real transition instead: compact header showing while
   * `promptAttempted: false`, withdrawing the moment the SAME live-bound
   * hook starts reporting it true — `useSessionLifecycle` stays one stable
   * reference across both renders (its documented contract); only the
   * facts it reads change.
   */
  it('promptAttempted 由假变真（首条消息刚提交，尚未接受也尚未失败）：紧凑头随同一实时快照的更新收起', () => {
    let facts: SessionLifecycleFacts = { blank: true, running: false, promptAttempted: false }
    const useLifecycle: UseSessionLifecycle = (_sessionId, selector) => selector(facts)
    const { rerender } = render(
      <CardShell
        card={{ ...COMPACT_CARD, focused: true, blank: true }}
        renderPane={() => <div />}
        useSessionLifecycle={useLifecycle}
        t={spyT()}
      />,
    )
    // Before the prompt: D2's fallback still holds, compact header stays.
    expect(screen.getByText('登录修复')).toBeTruthy()
    facts = { blank: true, running: false, promptAttempted: true }
    rerender(
      <CardShell
        card={{ ...COMPACT_CARD, focused: true, blank: true }}
        renderPane={() => <div />}
        useSessionLifecycle={useLifecycle}
        t={spyT()}
      />,
    )
    // After: DSH's official header is now showing — the compact one must not
    // linger from the previous render (that would be the "two heads" bug).
    expect(screen.queryByText('登录修复')).toBeNull()
  })

  it('还没发过消息的聚焦空白卡仍保留紧凑头（D2 的兜底不被这次修复推翻）', () => {
    render(
      <CardShell
        card={{ ...COMPACT_CARD, focused: true, blank: true }}
        renderPane={() => <div />}
        useSessionLifecycle={lifecycleOf({ blank: true, running: false, promptAttempted: false })}
        t={spyT()}
      />,
    )
    expect(screen.getByText('登录修复')).toBeTruthy()
  })
})
