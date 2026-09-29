// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a SessionProvider component stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * ui-renderer's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from 'dsh-plugin-matou-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from 'dsh-plugin-matou-layout/src/client/AppFrame.tsx'
import { SIDEBAR_COLLAPSED } from 'dsh-plugin-matou-layout/src/client/columns.ts'
import { EMPTY_ORG_STATE } from 'dsh-plugin-matou-layout/src/org/model.ts'
import type { MatouOrgState } from 'dsh-plugin-matou-layout/src/org/model.ts'
import { zh } from 'dsh-plugin-matou-layout/src/client/locales.ts'
import type { MatouKey } from 'dsh-plugin-matou-layout/src/client/locales.ts'
import { EMPTY_NAV } from 'dsh-plugin-matou-layout/src/client/nav/navigation.ts'
import { createLayoutStore } from 'dsh-plugin-matou-layout/src/client/stores.ts'
import type { LevelState } from 'dsh-plugin-matou-layout/src/client/carousel/level-store.ts'
import { createNotificationStore } from 'dsh-plugin-matou-layout/src/client/notifications/store.ts'
import type { AgentNotificationSnapshot } from 'dsh-plugin-matou-layout/src/client/notifications/store.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const selectedSessionTitle = { current: undefined as string | undefined }
const workspacesReady = { current: true }
type AttentionSnapshot = Parameters<Parameters<AppFrameProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: AppFrameProps['useSessionPendingInteraction'] = selector => selector(noAttention)

/** One fixture session for the carousel-focused tests below (richer than the single-`selectedSession` default). */
interface FixtureSession {
  id: string
  displayTitle: string
  running?: boolean
  completed?: boolean
  updatedAt?: number
  /** D2 (S3b Task 11c): DSH's own "never had a turn" signal, mirrored onto `CardModel.blank`. */
  blank?: boolean
}
/** Populated by the carousel describe block; `undefined` keeps every other test's single-session default untouched. */
const carouselFixture = {
  sessions: undefined as FixtureSession[] | undefined,
  workspaceItems: undefined as WorkspaceView[] | undefined,
  org: undefined as MatouOrgState | undefined,
  level: undefined as LevelState | undefined,
  archivedSessionIds: [] as readonly string[],
  /**
   * I4: DSH's per-session LIVE lifecycle, keyed by session id. Absent entries
   * make `useSessionLifecycle` report `undefined`, which is the honest
   * "no binding yet" case the card falls back to `SessionSummary.blank` for.
   */
  lifecycle: {} as Record<string, { blank: boolean; running: boolean; promptAttempted: boolean }>,
}

/**
 * S5 Task 5: a REAL notification store backing `useNotifications`, decoupled
 * from the real derive→push pipeline (that seam is
 * `notification-lighting.client.spec.tsx`'s territory — `pushNotification`
 * here stays the inert `workbenchStubs` mock). Recreated fresh in
 * `beforeEach` so no test's `.push()` calls leak into the next; a bare
 * factory (never `createBrowserNotificationStore`) keeps this file clear of
 * any real `AudioContext`/`localStorage` touch, per Task 1/2's contract.
 */
let notificationsFixtureStore = createNotificationStore({ now: () => 1_000 })

// Provider contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode renders children and
// empty mode runs the empty branch.
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children}</>


/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

const workbenchStubs = {
  addWorkspace: vi.fn(async () => undefined),
  createTask: vi.fn(async () => 'new'), renameTask: vi.fn(async () => undefined), setTaskPinned: vi.fn(async () => undefined),
  deleteTask: vi.fn(async () => undefined), createScene: vi.fn(async () => 'sc'), renameScene: vi.fn(async () => undefined),
  deleteScene: vi.fn(async () => undefined), newSession: vi.fn(async () => undefined), openSession: vi.fn(),
  clearSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), renameSession: vi.fn(async () => undefined), archiveSession: vi.fn(async () => undefined),
  navigate: vi.fn(),
  drillTo: vi.fn(), returnToParent: vi.fn(),
  forkChild: vi.fn(async () => undefined), forkSibling: vi.fn(async () => undefined), forkPeer: vi.fn(async () => undefined),
  removeCard: vi.fn(async () => undefined),
  commitInteractions: vi.fn(async () => undefined),
  // S5 Task 4: the notification store's imperative write side reaches AppFrame
  // as a plain face member (not under `hooks` — see `workbench/face.ts`).
  pushNotification: vi.fn(() => null),
}

function mountFrame() {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'main') return <div data-testid="center-content" />
    if (key === 'rightbar') return <div data-testid="details-content" />
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    let sessionState: SessionListState
    if (carouselFixture.sessions !== undefined) {
      const byId: Record<string, unknown> = {}
      for (const entry of carouselFixture.sessions) {
        byId[entry.id] = { blank: false, running: false, updatedAt: 1, ...entry }
      }
      sessionState = {
        ids: carouselFixture.sessions.map(entry => entry.id),
        byId,
        current: selectedSession.current,
        phase: 'ready',
      } as SessionListState
    } else {
      const current = selectedSession.current
      sessionState = {
        ids: current === undefined ? [] : [current],
        byId: current === undefined
          ? {}
          : {
            [current]: {
              id: current,
              displayTitle: 'Test',
              running: false,
              blank: selectedSessionBlank.current,
              updatedAt: 1,
              ...(selectedSessionTitle.current === undefined ? {} : { title: selectedSessionTitle.current }),
            },
          },
        current,
        phase: 'ready',
      } as SessionListState
    }
    return sel(sessionState)
  }) as never
  /**
   * Read lazily (like `useSessions`/`useOrg` above), not snapshotted at mount
   * time: a test that clears `carouselFixture.workspaceItems` and re-renders
   * expects the workspace list to actually empty out. Snapshotting it kept
   * the original workspace alive across such a re-render, which silently left
   * a *virtual default* scene standing where the test believed every scene
   * was gone.
   */
  const workspaceStateOf = (): WorkspaceSnapshot => ({
    items: carouselFixture.workspaceItems ?? [],
    archivedSessionIds: carouselFixture.archivedSessionIds,
    state: 'idle', phase: 'ready', error: null,
    ...(workspacesReady.current ? {} : { state: 'loading' as const, phase: 'pending' as const }),
  })
  /**
   * Real `zh` dictionary + `{param}` interpolation (same convention as other
   * specs' `spyT()`), not a key echo — the carousel/breadcrumb tests below
   * check rendered copy.
   */
  const t = ((key: MatouKey, params?: Record<string, unknown>) => (
    key === 'brand.localBuild'
      ? 'DSH Local Build'
      : zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  )) as never
  const element = () => (
    <AppFrame
      useStore={hookOf(instance)}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useSessionPendingInteraction={useSessionPendingInteraction}
      useSessionLifecycle={((key: string, sel?: (v: unknown) => unknown) =>
        sel === undefined ? carouselFixture.lifecycle[key] : sel(carouselFixture.lifecycle[key])) as never}
      useWorkspaces={((sel: (s: WorkspaceSnapshot) => unknown) => sel(workspaceStateOf())) as never}
      useOrg={((sel: (s: unknown) => unknown) =>
        sel({ phase: 'ready', revision: 0, org: carouselFixture.org ?? EMPTY_ORG_STATE })) as never}
      useNav={((sel: (s: unknown) => unknown) => sel(EMPTY_NAV)) as never}
      useNotifications={((sel: (s: AgentNotificationSnapshot) => unknown) =>
        sel(notificationsFixtureStore.snapshot())) as never}
      useLevel={((sel: (s: LevelState) => unknown) =>
        sel(carouselFixture.level ?? { parentBySceneId: {} })) as never}
      // S4 Task 8: inert here — the forced-recenter path is exercised in
      // `carousel-reveal.client.spec.tsx`, where injected measurement
      // stand-ins can actually observe a scroll (jsdom has no layout).
      useReveal={((sel: (s: unknown) => unknown) => sel({ bySceneId: {} })) as never}
      {...workbenchStubs}
      SessionProvider={SessionProviderStub}
      t={t}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

function tracks(frame: HTMLElement): number[] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  frameWidth = 1920
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  selectedSessionTitle.current = undefined
  workspacesReady.current = true
  carouselFixture.sessions = undefined
  carouselFixture.workspaceItems = undefined
  carouselFixture.org = undefined
  carouselFixture.level = undefined
  carouselFixture.archivedSessionIds = []
  carouselFixture.lifecycle = {}
  notificationsFixtureStore = createNotificationStore({ now: () => 1_000 })
  // The stub face is module-level (one stable identity across every mount);
  // `restoreMocks` does not reach it, so calls would otherwise accumulate
  // across tests and make any "exactly these calls" assertion meaningless.
  for (const stub of Object.values(workbenchStubs)) stub.mockClear()
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  document.title = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('AppFrame', () => {
  it('localizes the product title when the build does not supply one', () => {
    mountFrame()
    expect(document.title).toBe('DSH Local Build')
  })

  it('projects the selected durable Session title', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Product')
    selectedSessionTitle.current = 'First'
    const { rerenderFrame } = mountFrame()
    expect(document.title).toBe('First — Product')

    selectedSessionTitle.current = 'Revised'
    act(() => { rerenderFrame() })
    expect(document.title).toBe('Revised — Product')

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(document.title).toBe('Product')
  })

  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('renders the session pair with empty owner shares (sessionId is framework-standard)', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('main')
    expect(keys).toContain('rightbar')
    expect(keys).not.toContain('conversation.empty')
    // 中央座位仍然不带 owner 属性；右栏在 0.1.5 起要带官方约定的三个字段
    // （已解析宽度 / 视口宽 / 能否显示），占位者 ui-sidebar-right 靠它们决定呈现。
    expect(slotCalls.find(c => c.key === 'main')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'rightbar')!.props)
      .toEqual({ width: expect.any(Number), viewportWidth: expect.any(Number), canShow: expect.any(Boolean) })
  })

  it('keeps the main slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId, queryByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('main')
    // 0.1.5 起右栏是根作用域，没有当前会话也照常挂载——它的显隐由
    // `ctx.layout` 的开合决定，并通过 `canShow` 告诉占位者，而不是由本框架
    // 按「有没有会话」强行摘掉。（旧断言写的是 `toBeNull()`，那是 session
    // 作用域时代的语义。）
    expect(queryByTestId('details-content')).toBeTruthy()
    expect(slotCalls.find(c => c.key === 'rightbar')!.props).toMatchObject({ canShow: true })
    expect(slotCalls.map(c => c.key)).toContain('rightbar')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    workspacesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('main')
    expect(slotCalls.map(c => c.key)).toContain('rightbar')
  })

  /**
   * **0.1.5 起语义变了，这条测试跟着改了。**
   *
   * 旧行为：右栏（`details`，session 作用域）装的是「当前会话的某条工具调用详情」，
   * 所以换会话就自动收起、空白会话不给占位。
   * 新行为：右栏是根作用域的 `rightbar`，占位者 `ui-sidebar-right` 自己按会话管
   * 里面的停靠面，开合只由 `ctx.layout` 决定。本框架再去替它开合就是越界——
   * 在本插件里尤其要命，轮播的日常操作就是不停切卡，每切一次收一次等于没法用。
   *
   * 所以这条现在钉的是反过来的不变式：**换会话、甚至换成空白会话，右栏都不动。**
   */
  it('换会话不再自动收起右栏（0.1.5 根作用域语义）', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])
    expect(instance.getSnapshot().details).toBe(360)

    // 反例：真正该收起它的是布局自己的关栏动作，不是会话变化。
    act(() => { instance.actions.closeDetails() })
    expect(tracks(frame)).toEqual([280, 0])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // step-2 squeeze: details renders 330 while preference is 360
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
  })

  it('closed file panel advertises opening space and narrow windows keep an overlay', () => {
    frameWidth = 800
    const { frame, instance, slotCalls } = mountFrame()
    const props = slotCalls.find(c => c.key === 'rightbar')!.props
    expect(props).toMatchObject({ canShow: true, width: 360 })
    expect(frame.querySelector('[data-details-overlay]')).toBeNull()
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelector('[data-details-overlay]')).toBeTruthy()
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelector('[data-details-overlay]')).toBeNull()
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // close while wide: preference 0
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // preference untouched
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — card carousel (S3b Task 10)', () => {
  /** One workspace/task/scene with three placed sessions: A and C at the root layer, B under A. */
  function setupCarouselFixture(): void {
    carouselFixture.workspaceItems = [
      { workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B', 'C'] },
    ] as unknown as WorkspaceView[]
    carouselFixture.sessions = [
      { id: 'A', displayTitle: 'Session A' },
      { id: 'B', displayTitle: 'Session B' },
      { id: 'C', displayTitle: 'Session C' },
    ]
    carouselFixture.org = {
      tasks: [{
        id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1,
      }],
      scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
      placements: [
        { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
        { sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
        { sessionId: 'B', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 'A', sortKey: 3, updatedAt: 1 },
      ],
    }
    selectedSession.current = 'A' as SessionId
  }

  it('renders the sibling-session carousel region sized to the root layer\'s children, no breadcrumb', () => {
    setupCarouselFixture()
    const { container } = mountFrame()
    const region = screen.getByRole('region', { name: zh['carousel.list'] })
    expect(region).toBeTruthy()
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(2) // A, C — B is under A, not shown at root
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('drilling in shows only the parent\'s children plus the breadcrumb; the button returns to the parent layer', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: { 'sc-1': 'A' } }
    const { container } = mountFrame()
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(1) // only B
    const nav = screen.getByRole('navigation', { name: '层级导航' })
    expect(nav.textContent).toContain('Session A')
    expect(nav.textContent).toContain('1')
    const back = screen.getByRole('button', { name: /返回父会话/ })
    back.click()
    expect(workbenchStubs.returnToParent).toHaveBeenCalledWith('sc-1')
  })

  /**
   * A `total` root-session scene, ids `r0`..`r{total-1}` placed in that
   * order, `r0` current. `total > visibleCount * 3` is what makes the render
   * window actually bite (jsdom measures `clientWidth === 0`, so
   * `visibleColumnsForWidth` falls back to 4 columns -> a 12-card window).
   */
  function setupWideRootFixture(total: number): string[] {
    const ids = Array.from({ length: total }, (_, index) => `r${index}`)
    carouselFixture.workspaceItems = [
      { workspaceId: 'ws-1', title: 'WS', sessionIds: ids },
    ] as unknown as WorkspaceView[]
    carouselFixture.sessions = ids.map(id => ({ id, displayTitle: `Session ${id}` }))
    carouselFixture.org = {
      tasks: [{
        id: 't-1', workspaceId: 'ws-1', title: 'T', status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1,
      }],
      scenes: [{ id: 'sc-1', taskId: 't-1', name: 'S', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 }],
      placements: ids.map((id, index) => ({
        sessionId: id, taskId: 't-1', sceneId: 'sc-1', sortKey: index + 1, updatedAt: 1,
      })),
    }
    selectedSession.current = 'r0' as SessionId
    return ids
  }

  it('pins exactly the cards it renders (2 张卡时窗口天然覆盖全部)', () => {
    setupCarouselFixture()
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['A', 'C'])
    expect(workbenchStubs.pinSession.mock.calls.map(call => call[0]).sort()).toEqual(['A', 'C'])
  })

  /**
   * C1 (final review): with more siblings than the render window holds, the
   * surplus cards must be neither pinned NOR rendered. The old assertion
   * ("pins every rendered card") could not catch this: its fixture had two
   * cards, so the window covered everything and pin-set == render-set held
   * trivially. An unpinned-but-rendered pane resolves through DSH's
   * `keyed ?? adapter.resolve(sessionKey) ?? current` fallback and shows the
   * FOCUSED session's transcript under the surplus card's own title — the
   * user can type into the wrong conversation.
   */
  it('同层卡片数超过渲染窗口时，超窗卡片既不上台也不渲染（pin 集合 === 渲染集合）', () => {
    const ids = setupWideRootFixture(14)
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toHaveLength(12) // visibleCount(4) * 3
    expect(rendered).toEqual(ids.slice(0, 12))
    for (const surplus of ids.slice(12)) {
      expect(container.querySelector(`[data-session-id="${surplus}"]`)).toBeNull()
    }
    const pinned = workbenchStubs.pinSession.mock.calls.map(call => call[0])
    expect([...pinned].sort()).toEqual([...rendered].sort())
    expect(pinned).not.toContain('r12')
    expect(pinned).not.toContain('r13')
  })

  /**
   * Ruling-20's read-side repair, end to end: a child whose parent was
   * archived by an OLD build (before `removeCard` learned to re-attach) is
   * projected as a root node instead of pointing at a session no layer
   * contains — otherwise B belongs to no layer at all and, since the drill
   * level is deliberately unpersisted, no reload can reach it either.
   */
  it('父会话已归档的孤儿子会话回到根层，而不是从所有层里消失', () => {
    setupCarouselFixture()
    carouselFixture.archivedSessionIds = ['A']
    selectedSession.current = 'B' as SessionId
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toContain('B')
    expect(rendered).not.toContain('A')
  })

  /**
   * I1 (final review, Ruling-19): spec §3/§7.1 step 5 — 「新卡/新 fork 落在
   * 最右端」. 码头's first sort key is a user-interaction sequence that starts
   * at 0, so a brand-new card sorts LAST. DSH's `updatedAt` is
   * `max(header.createdAt, lastPromptAt)`, which for a just-created session is
   * the LARGEST value in the layer — under a naive `lastInteractionAt =
   * updatedAt` mapping `orderSiblings`'s 「最近交互 DESC」put the new card
   * leftmost, the exact opposite. A never-interacted (blank) session is
   * therefore projected at 0.
   */
  it('新建的空白卡落在最右端，而不是因为 updatedAt 最大被排到最左（I1）', () => {
    setupCarouselFixture()
    carouselFixture.sessions = [
      { id: 'A', displayTitle: 'Session A', updatedAt: 100 },
      { id: 'C', displayTitle: 'Session C', updatedAt: 200 },
      // Just created: the newest `updatedAt` in the layer, and never had a turn.
      { id: 'N', displayTitle: 'Session N', updatedAt: 9_000, blank: true },
    ]
    carouselFixture.workspaceItems = [
      { workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'C', 'N'] },
    ] as unknown as WorkspaceView[]
    carouselFixture.org = {
      ...carouselFixture.org!,
      placements: [
        { sessionId: 'A', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
        { sessionId: 'C', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
        { sessionId: 'N', taskId: 't-1', sceneId: 'sc-1', sortKey: 3, updatedAt: 1 },
      ],
    }
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['C', 'A', 'N']) // MRU among the two that have interacted; the new blank one last
  })

  /**
   * I5 (final review, revised by the coordinator after the first pass folded
   * 码头's TWO mechanisms into one). The drill layer is deliberately
   * unpersisted (spec §3) while the focused session IS persisted per tab, so
   * a reload leaves them disagreeing. 码头 answers that with two separate
   * rules, and the difference matters:
   *
   * - `SessionCanvas.tsx:44-46` — ONLY when there is no explicit layer, the
   *   layer IS `focused.parentSessionId`. That is the reload case.
   * - `SessionCanvas.tsx:59` — with an explicit layer, the LAYER DOES NOT
   *   MOVE; the focus does (`levelFocus = focused.parentSessionId === parentId
   *   ? focused : direct[0]`).
   *
   * Collapsing them into "always retarget the layer at the focused session"
   * would kick the user out of a layer they explicitly drilled into the
   * moment focus went elsewhere — including out of an emptied layer they
   * wanted to create a new session in.
   */
  it('无显式层级（刷新态）+ 焦点在子层：层级反推到该子层，焦点保持（码头 :44-46）', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: {} } // unset — what a reload leaves behind
    selectedSession.current = 'B' as SessionId // ...while nav restored A's child
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['B']) // A's children layer, derived from B's own parent
    expect(screen.getByRole('navigation', { name: '层级导航' }).textContent).toContain('Session A')
    expect(container.querySelector('[data-session-id="B"] [aria-current="true"]')).toBeTruthy()
    expect(workbenchStubs.openSession).not.toHaveBeenCalled() // focus was already right
  })

  it('无显式层级 + 焦点在根层会话：层级就是根层', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: {} }
    selectedSession.current = 'C' as SessionId
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['A', 'C'])
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('显式下钻某层 + 焦点在别层：层级不动，焦点移到该层第一张卡（码头 SessionCanvas.tsx:59）', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: { 'sc-1': 'A' } } // explicitly drilled into A
    selectedSession.current = 'C' as SessionId // ...focus sits on a ROOT-layer sibling
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['B']) // the layer did NOT pop back to the root
    expect(workbenchStubs.openSession).toHaveBeenCalledWith('B') // the focus moved instead
  })

  it('显式下钻某层 + 该层已空：层级仍不动，也不动焦点（用户可以在空层里新建会话）', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: { 'sc-1': 'C' } } // C has no children
    selectedSession.current = 'A' as SessionId
    const { container } = mountFrame()
    expect(screen.getByText('当前画布没有活跃会话')).toBeTruthy()
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(0)
    expect(screen.getByRole('navigation', { name: '层级导航' }).textContent).toContain('Session C')
    expect(workbenchStubs.openSession).not.toHaveBeenCalled()
  })

  it('显式层级且焦点已在该层：既不动层级也不动焦点', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: { 'sc-1': 'A' } }
    selectedSession.current = 'B' as SessionId
    mountFrame()
    expect(workbenchStubs.openSession).not.toHaveBeenCalled()
  })

  it('显式根层（null，用户一路返回到根）与"未设置"不是一回事：不再反推层级', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: { 'sc-1': null } } // explicitly the ROOT layer
    selectedSession.current = 'B' as SessionId // ...focus sits in A's child layer
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['A', 'C']) // stayed at the root, unlike the unset case above
    expect(workbenchStubs.openSession).toHaveBeenCalledWith('A') // focus moved to the layer's first card
  })

  it('当前会话不属于本页签时既不反推层级也不改焦点（交给 useWorkbenchSync 换页签）', () => {
    setupCarouselFixture()
    selectedSession.current = 'elsewhere' as SessionId
    const { container } = mountFrame()
    const rendered = Array.from(container.querySelectorAll('[data-session-id]'))
      .map(slot => (slot as HTMLElement).dataset.sessionId)
    expect(rendered).toEqual(['A', 'C']) // no explicit level and no resolvable focus -> the root layer
    expect(workbenchStubs.openSession).not.toHaveBeenCalled()
  })

  it('shows the empty-scene fallback (no chip/pinToggle strip) when no task/scene exists', () => {
    const { getByText, queryByRole } = mountFrame() // no carouselFixture: workspaces stay empty, as the default
    expect(getByText('选择或新建一个事项开始工作')).toBeTruthy()
    expect(queryByRole('region', { name: zh['carousel.list'] })).toBeNull()
  })

  it('drilling into a childless session shows the "no active sessions" fallback (fix round M1)', () => {
    setupCarouselFixture()
    carouselFixture.level = { parentBySceneId: { 'sc-1': 'C' } } // C has no children
    const { container } = mountFrame()
    expect(screen.getByText('当前画布没有活跃会话')).toBeTruthy()
    // The carousel region stays mounted (geometry/scroll continuity), just empty.
    expect(screen.getByRole('region', { name: zh['carousel.list'] })).toBeTruthy()
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(0)
  })

  it('Cmd+] cycles carousel focus, which calls onFocus -> workbenchActions.openSession (fix round M5)', () => {
    setupCarouselFixture()
    const { container } = mountFrame()
    const region = container.querySelector('[role="region"]') as HTMLElement
    // Both metaKey and ctrlKey set: robust to whichever platform useCarouselController's isMac sniff resolves to in this environment.
    fireEvent.keyDown(region, { key: ']', metaKey: true, ctrlKey: true })
    expect(workbenchStubs.openSession).toHaveBeenCalledWith('C') // root layer [A, C], A focused (current) -> cycles to C
  })

  it('点击一张非聚焦紧凑卡触发 onFocus -> openSession（spec §7.1 步骤 2：点卡片成为焦点，round 2 补线）', () => {
    setupCarouselFixture()
    const { container } = mountFrame()
    const slot = container.querySelector('[data-session-id="C"]') as HTMLElement // A is current/focused, C is compact
    fireEvent.pointerDown(slot)
    expect(workbenchStubs.openSession).toHaveBeenCalledWith('C')
  })

  it('leaving the render window unpins the session that left it (fix round M2)', () => {
    setupCarouselFixture()
    const { rerenderFrame } = mountFrame()
    expect(workbenchStubs.pinSession).toHaveBeenCalledWith('A')
    // A leaves the fixture entirely — simulates it falling out of the render window.
    carouselFixture.sessions = carouselFixture.sessions!.filter(entry => entry.id !== 'A')
    carouselFixture.workspaceItems = [
      { workspaceId: 'ws-1', title: 'WS', sessionIds: ['B', 'C'] },
    ] as unknown as WorkspaceView[]
    carouselFixture.org = {
      ...carouselFixture.org!,
      placements: carouselFixture.org!.placements.filter(placement => placement.sessionId !== 'A'),
    }
    act(() => { rerenderFrame() })
    expect(workbenchStubs.unpinSession).toHaveBeenCalledWith('A')
  })

  it('leaving the scene entirely (no active task/scene) clears the whole stage (fix round M2)', () => {
    setupCarouselFixture()
    const { rerenderFrame } = mountFrame()
    expect(workbenchStubs.pinSession).toHaveBeenCalledWith('A')
    expect(workbenchStubs.pinSession).toHaveBeenCalledWith('C')
    carouselFixture.workspaceItems = undefined
    carouselFixture.sessions = undefined
    carouselFixture.org = undefined
    act(() => { rerenderFrame() })
    expect(workbenchStubs.unpinSession).toHaveBeenCalledWith('A')
    expect(workbenchStubs.unpinSession).toHaveBeenCalledWith('C')
  })

  it('unmounting AppFrame clears the whole stage (fix round M2)', () => {
    setupCarouselFixture()
    const { unmount } = mountFrame()
    expect(workbenchStubs.pinSession).toHaveBeenCalledWith('A')
    expect(workbenchStubs.pinSession).toHaveBeenCalledWith('C')
    unmount()
    expect(workbenchStubs.unpinSession).toHaveBeenCalledWith('A')
    expect(workbenchStubs.unpinSession).toHaveBeenCalledWith('C')
  })

  /**
   * D2 (S3b Task 11c review): `sessions.byId[id].blank` must reach
   * `CardModel.blank`, or a focused-but-blank card renders no header at all
   * (DSH hides its own official header for a blank session regardless of
   * focus — see CardShell's module doc).
   */
  it('聚焦卡对应的会话是空白会话时，仍显示 42px 紧凑头（D2：blank 从 sessions.byId 传到 CardModel）', () => {
    setupCarouselFixture()
    carouselFixture.sessions = carouselFixture.sessions!.map(entry =>
      entry.id === 'A' ? { ...entry, blank: true } : entry)
    mountFrame() // A is `selectedSession.current` (focused) and now blank
    expect(screen.getByText('Session A')).toBeTruthy()
  })

  it('聚焦卡对应的会话不是空白会话时，不显示 42px 紧凑头（完全让位给官方头）', () => {
    setupCarouselFixture() // A's fixture entry omits `blank` -> defaults to false
    mountFrame()
    expect(screen.queryByText('Session A')).toBeNull()
  })

  /**
   * I4 end to end: the list still says `blank`, but the session INSTANCE
   * already reports `promptAttempted`, so DSH's own header is on screen and
   * the card must not draw a second one.
   */
  it('聚焦空白卡在首条消息提交那一帧收起紧凑头（会话实例快照压过列表投影的 blank）', () => {
    setupCarouselFixture()
    carouselFixture.sessions = carouselFixture.sessions!.map(entry =>
      entry.id === 'A' ? { ...entry, blank: true } : entry)
    carouselFixture.lifecycle = { A: { blank: true, running: false, promptAttempted: true } }
    mountFrame()
    expect(screen.queryByText('Session A')).toBeNull()
  })

  it('会话实例还没有绑定（拿不到快照）时回退到列表投影的 blank', () => {
    setupCarouselFixture()
    carouselFixture.sessions = carouselFixture.sessions!.map(entry =>
      entry.id === 'A' ? { ...entry, blank: true } : entry)
    carouselFixture.lifecycle = {} // no binding for A
    mountFrame()
    expect(screen.getByText('Session A')).toBeTruthy()
  })

  /**
   * S5 Task 5, card level: `hasNotice`/`hasRing` are one boolean signal —
   * `sessionHasUnread(sessionId)` — not a count (spec §5's 点亮层级 row).
   * `C` is a non-focused root card (`A` is `selectedSession.current`), so its
   * compact header always renders and can carry the "新通知" pill; testing
   * against the focused `A` instead would confound this with D2's "focused
   * card defers to DSH's own header" rule, which suppresses that pill
   * regardless of `hasNotice`.
   */
  it('lights exactly the card whose own session has an unread notification, not its siblings (S5 Task 5)', () => {
    setupCarouselFixture()
    const { container, rerenderFrame } = mountFrame()
    const cardOf = (id: string) => container.querySelector(`[data-session-id="${id}"]`) as HTMLElement
    expect(within(cardOf('C')).queryByText('新通知')).toBeNull()

    notificationsFixtureStore.push({ eventId: 'n-c', eventType: 'permission', title: 'Claude Code', sessionId: 'C' })
    rerenderFrame()
    expect(within(cardOf('C')).getByText('新通知')).toBeTruthy()
  })

  /**
   * S5 Task 5, scene tab level: a tab lights up when ANY session currently
   * MOUNTED under it has unread — via the org-derived placement set, per
   * Ruling (码头 `SceneTabBar.tsx:121-125`), never `unreadForScene`. `sc-2`
   * mounts only `D`; `sc-1` mounts `A`/`B`/`C`, none of which are unread
   * here, so only `sc-2`'s dot must appear.
   */
  it('omits the entire scene tab row, including unread dots and add-tab control', () => {
    setupCarouselFixture()
    carouselFixture.workspaceItems = [
      { workspaceId: 'ws-1', title: 'WS', sessionIds: ['A', 'B', 'C', 'D'] },
    ] as unknown as WorkspaceView[]
    carouselFixture.sessions = [...carouselFixture.sessions!, { id: 'D', displayTitle: 'Session D' }]
    carouselFixture.org = {
      ...carouselFixture.org!,
      scenes: [
        ...carouselFixture.org!.scenes,
        { id: 'sc-2', taskId: 't-1', name: 'S2', titlePinned: false, sortKey: 2, createdAt: 1, updatedAt: 1 },
      ],
      placements: [
        ...carouselFixture.org!.placements,
        { sessionId: 'D', taskId: 't-1', sceneId: 'sc-2', sortKey: 1, updatedAt: 1 },
      ],
    }
    notificationsFixtureStore.push({ eventId: 'n-d', eventType: 'permission', title: 'Claude Code', sessionId: 'D' })
    const { container } = mountFrame()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(screen.queryByLabelText('新建页签')).toBeNull()
    expect(container.querySelector('[data-testid="scene-unread-sc-2"]')).toBeNull()
    expect(container.querySelector('[data-testid="scene-unread-sc-1"]')).toBeNull()
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
  })
})
