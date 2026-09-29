// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { Bell, BELL_SEAT_ID, registerBellSeat } from '../src/client/notifications/Bell.tsx'
import type { BellProps } from '../src/client/notifications/Bell.tsx'
import { createPanelStore } from '../src/client/notifications/panel-store.ts'
import type { WorkbenchInjected } from '../src/client/workbench/face.ts'

afterEach(cleanup)

/** Real `zh` dictionary + `{param}` interpolation — same convention as `header-seats.client.spec.tsx`'s `spyT()`. */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

/**
 * Minimal `BellProps` double. `Bell` only destructures `wide`/`t`/
 * `useNotifications`/`usePanel`/`togglePanel` out of the full shared
 * `WorkbenchInjected` face — the same per-prop-double convention
 * `app-frame.client.spec.tsx` uses for its own `useOrg`/`useNav`/
 * `useNotifications` doubles — so the cast covers the ~20 unused
 * `WorkbenchActions` methods this component never reads.
 */
function bellProps(
  over: { wide?: boolean; unreadCount?: number; panelOpen?: boolean; togglePanel?: () => void } = {},
): BellProps {
  return {
    wide: over.wide ?? true,
    t: spyT(),
    useNotifications: ((sel: (snapshot: { unreadCount: number }) => unknown) =>
      sel({ unreadCount: over.unreadCount ?? 0 })) as never,
    usePanel: ((sel: (snapshot: { open: boolean }) => unknown) =>
      sel({ open: over.panelOpen ?? false })) as never,
    togglePanel: over.togglePanel ?? vi.fn(),
  } as unknown as BellProps
}

describe('Bell', () => {
  it('wide: true 显示文字"通知"', () => {
    render(<Bell {...bellProps({ wide: true })} />)
    expect(screen.getByText('通知')).toBeTruthy()
  })

  it('wide: false 不显示文字，只剩图标', () => {
    render(<Bell {...bellProps({ wide: false })} />)
    expect(screen.queryByText('通知')).toBeNull()
  })

  it('wide: false 配 Tooltip：悬停超过 delayMs 后出现气泡，文案是"通知"', () => {
    vi.useFakeTimers()
    render(<Bell {...bellProps({ wide: false })} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip').textContent).toBe('通知')
  })

  it('wide: true 时 Tooltip 被禁用（行内已有可见文字，不重复弹气泡）', () => {
    vi.useFakeTimers()
    render(<Bell {...bellProps({ wide: true })} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('unreadCount > 0 时显示未读红点', () => {
    render(<Bell {...bellProps({ unreadCount: 3 })} />)
    expect(screen.getByTestId('bell-unread-dot')).toBeTruthy()
  })

  it('unreadCount === 0 时不显示红点', () => {
    render(<Bell {...bellProps({ unreadCount: 0 })} />)
    expect(screen.queryByTestId('bell-unread-dot')).toBeNull()
  })

  it('点击铃铛切换 panel store 的 open（真实 store，不是 mock 回调）', () => {
    const panelStore = createPanelStore().create()
    render(<Bell {...bellProps({ togglePanel: panelStore.actions.toggle })} />)
    expect(panelStore.getSnapshot().open).toBe(false)
    fireEvent.click(screen.getByRole('button'))
    expect(panelStore.getSnapshot().open).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(panelStore.getSnapshot().open).toBe(false)
  })

  /**
   * S5 Task 7 leftover from Task 6's review: the bell now reads `hooks.panel`
   * (Task 7 gave it a real consumer) and reports its own open/closed state —
   * 码头's `flat-sidebar__notify` carries the same `aria-expanded`.
   */
  it('usePanel 的 open 为 true 时 aria-expanded="true"', () => {
    render(<Bell {...bellProps({ panelOpen: true })} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })

  it('usePanel 的 open 为 false 时 aria-expanded="false"', () => {
    render(<Bell {...bellProps({ panelOpen: false })} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('真实 panelStore 的 open 跃迁后 aria-expanded 跟随（同一实例同时驱动 usePanel 与 togglePanel）', () => {
    const panelStore = createPanelStore().create()
    const props = () => bellProps({ togglePanel: panelStore.actions.toggle, panelOpen: panelStore.getSnapshot().open })
    const { rerender } = render(<Bell {...props()} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button'))
    rerender(<Bell {...props()} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('registerBellSeat', () => {
  /**
   * Minimal SlotRegistry bench: declares `sidebar.header.action` flat under
   * the built-in root (same trick `header-seats.client.spec.tsx` uses).
   */
  async function bench() {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'sidebar.header.action': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    return { ctx, slots: ctx.get('slots') as SlotRegistry }
  }

  it('以正确的 name/id/locale 注册进 sidebar.header.action', async () => {
    const { ctx, slots } = await bench()
    registerBellSeat(ctx, () => ({} as unknown as WorkbenchInjected))
    const entries = slots.entries('sidebar.header.action')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options.id).toBe(BELL_SEAT_ID)
    expect(entries[0]!.locale).toBe('matou')
  })

  it('disposer 移除注册（HMR 安全）', async () => {
    const { ctx, slots } = await bench()
    const dispose = registerBellSeat(ctx, () => ({} as unknown as WorkbenchInjected))
    const ids = () => slots.entries('sidebar.header.action').map(entry => entry.options.id)
    expect(ids()).toContain(BELL_SEAT_ID)
    dispose()
    expect(ids()).not.toContain(BELL_SEAT_ID)
  })

  it('把注入的 face 工厂原样接到 inject（与 sidebar.workspaces 共用同一个 workbenchFace，不重建/不裁剪）', async () => {
    const { ctx, slots } = await bench()
    const face = { marker: 'workbenchFace' } as unknown as WorkbenchInjected
    registerBellSeat(ctx, () => face)
    const entry = slots.entries('sidebar.header.action').find(candidate => candidate.options.id === BELL_SEAT_ID)!
    expect((entry.inject as () => unknown)()).toBe(face)
  })
})
