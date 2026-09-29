// @vitest-environment jsdom
/**
 * S5 Task 7 review finding: the one thing neither `bell.client.spec.tsx` nor
 * `notification-center.client.spec.tsx` can prove on its own — what a single
 * physical click on the bell does while BOTH seats are mounted and listening.
 *
 * They are separate React subtrees in production (`sidebar.footer.action` vs
 * `shell.overlay`, Ruling-S5-1) sharing only the module-level panel store, so
 * each of those suites necessarily stubs the other side away: the panel's
 * click-outside case clicks a sentinel button that toggles nothing back, and
 * the bell's cases run with no panel in the tree at all. Both stayed green
 * while the combination was broken:
 *
 *   pointerdown on bell → the panel's `document`-level outside-click fires
 *     (target is the bell, outside `panelRef`) → `closePanel()` → React
 *     flushes the discrete update → panel unmounts, its listeners come off
 *   click on bell      → the bell's own `togglePanel()` now sees
 *     `open === false` and flips it back to `true`
 *   net effect         → the panel never closes.
 *
 * The fix stamps `BELL_ANCHOR_ATTR` on the bell's button and teaches the
 * panel's outside-check to treat that element as "not outside" — the same
 * thing DSH's own `Menu.tsx` gets for free by sharing one `rootRef` between
 * its anchor and its list. This suite is the guard for it: it fails on the
 * pre-fix code and can only be satisfied by the two seats agreeing.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Bell } from '../src/client/notifications/Bell.tsx'
import type { BellProps } from '../src/client/notifications/Bell.tsx'
import { NotificationCenter } from '../src/client/notifications/NotificationCenter.tsx'
import type { NotificationCenterProps } from '../src/client/notifications/NotificationCenter.tsx'
import { createNotificationStore } from '../src/client/notifications/store.ts'
import { createPanelStore } from '../src/client/notifications/panel-store.ts'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** Real `zh` dictionary + `{param}` interpolation — same convention as the two sibling suites. */
function spyT() {
  return vi.fn((key: MatouKey, params?: Record<string, unknown>) =>
    zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')))
}

/** Same `observableHook`-shaped adapter `notification-center.client.spec.tsx` uses. */
function reactiveHook<T>(source: { getSnapshot: () => T, subscribe: (fn: () => void) => () => void }) {
  return <S,>(selector: (value: T) => S): S => selector(useSyncExternalStore(source.subscribe, source.getSnapshot))
}

/**
 * Mount BOTH seats as siblings — disjoint DOM subtrees, one shared panel
 * store instance and one shared notification store, exactly how `index.ts`
 * threads them through the single `workbenchFace`.
 */
function mountBoth() {
  const panelStore = createPanelStore().create()
  const notificationsStore = createNotificationStore({ now: () => 1_000 })
  const usePanel = reactiveHook(panelStore)
  const useNotifications = reactiveHook({
    getSnapshot: () => notificationsStore.snapshot(),
    subscribe: notificationsStore.subscribe,
  })
  // Stable references: `useSyncExternalStore` compares snapshots with `Object.is`.
  const orgSnapshot = { org: { tasks: [], scenes: [], placements: [] } }
  const workspacesSnapshot = { items: [] }

  const bellProps = {
    wide: true,
    t: spyT(),
    usePanel,
    useNotifications,
    togglePanel: panelStore.actions.toggle,
  } as unknown as BellProps
  const centerProps = {
    t: spyT(),
    usePanel,
    useNotifications,
    useOrg: reactiveHook({ getSnapshot: () => orgSnapshot, subscribe: () => () => {} }) as never,
    useWorkspaces: reactiveHook({ getSnapshot: () => workspacesSnapshot, subscribe: () => () => {} }) as never,
    closePanel: () => { panelStore.actions.setOpen(false) },
    removeNotification: notificationsStore.remove,
    clearNotifications: notificationsStore.clear,
    setNotificationSoundEnabled: notificationsStore.setSoundEnabled,
  } as unknown as NotificationCenterProps

  render(
    <div>
      <button type="button" data-testid="outside">outside</button>
      {/* Stands in for DSH's composer capsule in its workspace-trigger state
          (`InputBar.tsx:392`) and for any plugin that does the same: a
          genuinely-outside surface that swallows pointerdown. */}
      <button
        type="button"
        data-testid="outside-swallowing"
        onPointerDown={event => { event.stopPropagation() }}
      >
        swallows pointerdown
      </button>
      <Bell {...bellProps} />
      <NotificationCenter {...centerProps} />
    </div>,
  )
  return { panelStore }
}

/** The bell's own button — `aria-label` is exactly `通知`, unlike the panel's `通知声音`/`通知中心`. */
const bell = () => screen.getByRole('button', { name: '通知' })
/** The panel, by the `aria-label` its `role="region"` carries. */
const panel = () => screen.queryByRole('region', { name: '通知中心' })

/**
 * One physical click, in the order a real mouse produces it — and aimed
 * where a real mouse actually lands: the icon INSIDE the button, not the
 * button itself. That is what makes these tests reject a degenerate
 * exemption (`target === bell`, or a `contains()` written backwards);
 * `closest()` is the only shape that survives a deep target.
 */
function clickBell(): void {
  const target = bell().querySelector('svg') ?? bell()
  act(() => { fireEvent.pointerDown(target, { bubbles: true }) })
  act(() => { fireEvent.click(target, { bubbles: true }) })
}

describe('Bell + NotificationCenter mounted together', () => {
  it('面板打开时点铃铛 → 关闭（且不会被自己的 click 立刻翻回来）', () => {
    const { panelStore } = mountBoth()
    act(() => { panelStore.actions.setOpen(true) })
    expect(panel()).not.toBeNull()

    clickBell()

    // Pre-fix this read `true`: pointerdown closed it, click reopened it.
    expect(panelStore.getSnapshot().open).toBe(false)
    expect(panel()).toBeNull()
  })

  it('面板关闭时点铃铛 → 打开', () => {
    const { panelStore } = mountBoth()
    expect(panel()).toBeNull()

    clickBell()

    expect(panelStore.getSnapshot().open).toBe(true)
    expect(panel()).not.toBeNull()
  })

  it('真正在铃铛和面板之外的点击仍然关闭面板（豁免只覆盖铃铛自己）', () => {
    const { panelStore } = mountBoth()
    act(() => { panelStore.actions.setOpen(true) })

    act(() => { fireEvent.pointerDown(screen.getByTestId('outside')) })

    expect(panelStore.getSnapshot().open).toBe(false)
    expect(panel()).toBeNull()
  })

  it('外部元素吞掉 pointerdown 传播时面板照样关闭（捕获相位）', () => {
    const { panelStore } = mountBoth()
    act(() => { panelStore.actions.setOpen(true) })

    act(() => { fireEvent.pointerDown(screen.getByTestId('outside-swallowing')) })

    // On the bubble phase this reads `true`: the panel would hang open over
    // the very surface the user just clicked.
    expect(panelStore.getSnapshot().open).toBe(false)
    expect(panel()).toBeNull()
  })
})
