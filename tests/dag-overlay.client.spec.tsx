// @vitest-environment jsdom
/**
 * S4 Task 12: the DAG overlay shell — the `shell.overlay` seat that puts the
 * canvas on screen, isolates the app behind it, owns Esc, and turns a card
 * click into the close/reveal/dismiss sequence.
 *
 * The three rulings this file is the executable proof of:
 *
 * - **Body portal (D-2).** `AppFrame.module.css`'s `.overlayLayer` is its own
 *   stacking context, so an overlay left in the seat can never rise above
 *   DSH's `Modal`/`Toast`/`Menu` portals. Every test mounts the component
 *   inside a stand-in seat element and asserts the rendered dialog is a DIRECT
 *   child of `document.body`, outside that element entirely.
 * - **`#root` inert (Global Constraints).** The document carries a real
 *   `<div id="root">`, so the open/close transitions actually flip the
 *   property DSH's own `OnboardingSurface.tsx:13-18` flips.
 * - **Esc in the capture phase (T-4).** A probe listener sits on `document`'s
 *   BUBBLE phase — the phase every other Esc handler in this app uses
 *   (`NotificationCenter.tsx:242-249`, DSH's `Modal`/`Menu`) — and the test
 *   asserts it never sees the keystroke. That single assertion is the
 *   anti-chain-close guard; it fails the moment the listener moves to the
 *   bubble phase or drops `stopImmediatePropagation`.
 *
 * The graph is NOT stubbed: every test drives the real
 * `useWorkbenchView` → `deriveOrgView` → `buildDagGraph` chain off session /
 * workspace / org fixtures, because the subagent-redirect and orphan branches
 * are only meaningful against the projection that actually decides which
 * sessions are subagents.
 */
import { useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { zh } from '../src/client/locales.ts'
import type { MatouKey } from '../src/client/locales.ts'
import { EMPTY_NAV } from '../src/client/nav/navigation.ts'
import { createDagPanelStore } from '../src/client/dag/panel-store.ts'
import { dagViewportKey, readDagViewport } from '../src/client/dag/viewport-store.ts'
import { DAG_OVERLAY_SEAT_ID, DagOverlay, registerDagOverlaySeat } from '../src/client/dag/DagOverlay.tsx'
import type { DagOverlayProps } from '../src/client/dag/DagOverlay.tsx'
import type { MatouOrgState, MatouPlacement } from '../src/org/model.ts'
import type { WorkbenchInjected } from '../src/client/workbench/face.ts'

/**
 * The `dag.*` copy Task 13 adds to `locales.ts` — same holding pattern
 * `dag-canvas.client.spec.tsx` uses, so this spec runs before that task lands
 * and keeps passing after it: the assertions check which KEY reached `t`, not
 * Task 13's eventual wording.
 */
const DAG_COPY: Record<string, string> = {
  'dag.label': '会话 DAG',
  'dag.close': '关闭关系图',
  'dag.empty': '这个页签里还没有会话',
  'dag.search.label': '搜索会话',
  'dag.search.placeholder': '搜索会话',
  'dag.search.results': '搜索结果',
  'dag.search.empty': '没有匹配的会话',
  'dag.zoom.label': '画布缩放',
  'dag.zoom.in': '放大',
  'dag.zoom.out': '缩小',
  'dag.zoom.reset': '恢复 100%',
  'dag.zoom.focus': '聚焦当前节点',
  'dag.legend.label': '关系说明',
  'dag.legend.fork': 'Fork：继承对话',
  'dag.legend.derived': '普通关联：不继承对话',
  'dag.node.open': '打开会话：{title}',
  'dag.node.notice': '新通知：{title}',
  'dag.node.children': '子会话 {n}',
  'dag.node.activity': '最近活动 {time}',
  'dag.node.noActivity': '暂无活动',
  'dag.node.emptyPreview': '暂无会话摘要',
  'dag.status.idle': '空闲',
  'dag.aggregate.branch': '远层分支',
  'dag.aggregate.layer': '远层层级',
  'dag.aggregate.count': '共 {n} 个会话',
  'dag.aggregate.range': '第 {from}–{to} 层 · 点击展开',
  'dag.aggregate.running': '运行中 {n}',
  'dag.aggregate.waiting': '等待输入 {n}',
  'dag.aggregate.done': '已完成 {n}',
  'dag.aggregate.label': '展开远层会话',
  'dag.missing': '这个会话已经不在了',
  'dag.subagentRedirect': '「{title}」是子代理会话，只在关系图里出现；已定位到它的父会话',
}

/** A `t` double over the real zh dictionary plus {@link DAG_COPY}. */
function spyT(): Translate<MatouKey> {
  const dict: Record<string, string> = { ...zh, ...DAG_COPY }
  return ((key: string, params?: Record<string, unknown>) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))) as Translate<MatouKey>
}

const t = spyT()

interface FixtureSession {
  id: string
  displayTitle: string
  parentId?: string
  origin?: 'subagent'
  running?: boolean
  completed?: boolean
  cwd?: string
  updatedAt?: number
}

/**
 * 甲 (root) → 乙 → 子代理; plus 孤儿子代理, a subagent whose DSH lineage
 * reaches the scene (so `buildDagGraph` draws it) while its placement row
 * names a parent this graph does not contain, which leaves it a ROOT subagent
 * with no non-subagent ancestor to fall back to. That is exactly the T-2
 * branch that has to answer with the failure toast rather than reveal nothing.
 */
const SESSIONS: FixtureSession[] = [
  { id: 's-a', displayTitle: '甲', updatedAt: 10 },
  { id: 's-b', displayTitle: '乙', parentId: 's-a', updatedAt: 20 },
  { id: 's-sub', displayTitle: '子代理', origin: 'subagent', parentId: 's-b', updatedAt: 30 },
  { id: 's-lost', displayTitle: '孤儿子代理', origin: 'subagent', parentId: 's-b', updatedAt: 40 },
]

const PLACEMENTS: MatouPlacement[] = [
  { sessionId: 's-a', taskId: 't-1', sceneId: 'sc-1', sortKey: 0, updatedAt: 1 },
  {
    sessionId: 's-b', taskId: 't-1', sceneId: 'sc-1',
    parentSessionId: 's-a', relationKind: 'forked-from', sortKey: 1, updatedAt: 1,
  },
  // Points outside the drawn node set on purpose — see SESSIONS' doc.
  { sessionId: 's-lost', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 's-gone', sortKey: 2, updatedAt: 1 },
]

const ORG: MatouOrgState = {
  tasks: [{ id: 't-1', workspaceId: 'w-1', title: '事项', status: 'active', isPinned: false, sortKey: 0, createdAt: 0, updatedAt: 0 }],
  scenes: [{ id: 'sc-1', taskId: 't-1', name: '页签', titlePinned: false, sortKey: 0, createdAt: 0, updatedAt: 0 }],
  placements: PLACEMENTS,
}

interface MountOptions {
  open?: boolean
  sessions?: FixtureSession[]
  org?: MatouOrgState
  /** Empty = no workspace at all, which resolves to no active scene. */
  workspaces?: readonly { workspaceId: string; sessionIds: readonly string[] }[]
  current?: string
  revealSession?: (sessionId: string) => boolean
  notifications?: readonly { sessionId: string | null }[]
}

/** Test-local selector hook over a `getSnapshot`/`subscribe` pair (the shape the renderer binds `hooks.*` into). */
function reactiveHook<T>(source: { getSnapshot: () => T; subscribe: (fn: () => void) => () => void }) {
  return <S,>(selector: (value: T) => S): S => selector(useSyncExternalStore(source.subscribe, source.getSnapshot))
}

function mount(options: MountOptions = {}) {
  const dagStore = createDagPanelStore().create()
  if (options.open !== false) dagStore.actions.setOpen(true)
  const sessions = options.sessions ?? SESSIONS
  const workspaces = options.workspaces ?? [{ workspaceId: 'w-1', sessionIds: sessions.map(entry => entry.id) }]
  const closeDag = vi.fn(() => { dagStore.actions.setOpen(false) })
  const revealSession = vi.fn(options.revealSession ?? (() => true))
  const dismissSessionIndicator = vi.fn()

  const sessionState = {
    ids: sessions.map(entry => entry.id),
    byId: Object.fromEntries(sessions.map(entry => [entry.id, {
      id: entry.id, blank: false, running: false, updatedAt: 1, ...entry,
    }])),
    current: options.current ?? 's-b',
    phase: 'ready',
  } as unknown as SessionListState
  const workspaceState = {
    items: workspaces.map(item => ({ ...item, path: '/tmp', title: '工作区', createdAt: '', updatedAt: '' })),
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  } as unknown as WorkspaceSnapshot
  const orgSnapshot = { phase: 'ready', revision: 0, org: options.org ?? ORG }
  const notificationsSnapshot = { notifications: options.notifications ?? [], soundEnabled: false }
  const pending = new Map<string, unknown>()

  const props = {
    t,
    useDag: reactiveHook(dagStore),
    useSessions: ((selector: (s: unknown) => unknown) => selector(sessionState)) as never,
    useWorkspaces: ((selector: (s: unknown) => unknown) => selector(workspaceState)) as never,
    useOrg: ((selector: (s: unknown) => unknown) => selector(orgSnapshot)) as never,
    useNav: ((selector: (s: unknown) => unknown) => selector(EMPTY_NAV)) as never,
    useLevel: ((selector: (s: unknown) => unknown) => selector({ parentBySceneId: {} })) as never,
    useNotifications: ((selector: (s: unknown) => unknown) => selector(notificationsSnapshot)) as never,
    useSessionPendingInteraction: ((selector: (s: unknown) => unknown) => selector(pending)) as never,
    closeDag,
    revealSession,
    dismissSessionIndicator,
  } as unknown as DagOverlayProps

  const utils = render(
    <div data-testid="seat" className="overlayLayer">
      <DagOverlay {...props} />
    </div>,
  )
  return { ...utils, dagStore, closeDag, revealSession, dismissSessionIndicator }
}

/** Let jsdom's rAF (and the canvas's own coalescing) run inside `act`. */
async function frames(ms = 40): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms) }) })
}

/** The overlay's rendered shell, or `null` while it is closed. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]')
}

/** One node card by session id (the canvas stamps `data-session-id` on every card). */
function card(sessionId: string): HTMLElement {
  const found = document.body.querySelector(`[data-dag-node][data-session-id="${sessionId}"]`)
  if (found === null) throw new Error(`no card for ${sessionId}`)
  return found as HTMLElement
}

let appRoot: HTMLElement

beforeEach(() => {
  appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  appRoot.remove()
  localStorage.clear()
})

describe('DagOverlay 浮层壳', () => {
  it('关闭时不渲染任何浮层 DOM', async () => {
    mount({ open: false })
    await frames()
    expect(dialog()).toBeNull()
    expect(document.body.querySelector('[role="group"]')).toBeNull()
  })

  it('打开时 portal 到 document.body，而不是留在座位（.overlayLayer）里', async () => {
    mount()
    await frames()
    const shell = dialog()
    expect(shell).not.toBeNull()
    // D-2: a direct child of body, so z-index 1200 actually beats DSH's own
    // 1000/1100 portals; inside the seat it could never leave the layer's
    // stacking context.
    expect(shell?.parentElement).toBe(document.body)
    expect(screen.getByTestId('seat').contains(shell)).toBe(false)
  })

  it('打开时 #root 置 inert，关闭后还原', async () => {
    const { dagStore } = mount()
    await frames()
    expect(appRoot.inert).toBe(true)
    await act(async () => { dagStore.actions.setOpen(false) })
    expect(appRoot.inert).toBe(false)
  })

  it('别人已经把 #root 设成 inert 时不抢也不还原（OnboardingSurface 同时挂着）', async () => {
    appRoot.inert = true
    const { dagStore } = mount()
    await frames()
    await act(async () => { dagStore.actions.setOpen(false) })
    expect(appRoot.inert).toBe(true)
  })

  it('Esc 关闭浮层', async () => {
    const { closeDag } = mount()
    await frames()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(closeDag).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })

  it('Esc 被捕获阶段独占：document 冒泡阶段的探针一次也收不到（防连锁关闭）', async () => {
    const probe = vi.fn()
    document.addEventListener('keydown', probe)
    try {
      mount()
      await frames()
      await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
      expect(probe).not.toHaveBeenCalled()
      // A key the overlay does not own still reaches everyone else.
      await act(async () => { fireEvent.keyDown(document, { key: 'a' }) })
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', probe)
    }
  })

  it('搜索框有内容时第一次 Esc 只清空查询，第二次才关闭', async () => {
    const { closeDag } = mount()
    await frames()
    const box = screen.getByRole('searchbox')
    await act(async () => { fireEvent.change(box, { target: { value: '乙' } }) })
    expect((box as HTMLInputElement).value).toBe('乙')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(closeDag).not.toHaveBeenCalled()
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(closeDag).toHaveBeenCalledTimes(1)
  })

  it('关闭按钮关闭浮层', async () => {
    const { closeDag } = mount()
    await frames()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: DAG_COPY['dag.close'] })) })
    expect(closeDag).toHaveBeenCalledTimes(1)
  })

  it('没有活动页签时渲染空态而不是画布', async () => {
    mount({ workspaces: [] })
    await frames()
    expect(dialog()).not.toBeNull()
    expect(document.body.querySelector('[role="group"]')).toBeNull()
    expect(dialog()?.textContent).toContain(DAG_COPY['dag.empty'])
  })
})

/**
 * 接线守卫（S4 Task 1 的作者点名的静默陷阱）。
 *
 * 在一个**根**会话上「⑂ Fork 会话」，新会话应与它并排；但 DSH 记的新会话
 * `parentId` 正是它复制状态的那个源会话。挡住这次回落的是落位行上的
 * `explicitRoot` 标记（`org/model.ts`）。
 *
 * 陷阱在于 `DagOverlay` 是**逐字段**还是**整行**把落位喂给 `buildDagGraph`：
 * 计划文本里 `placementOf` 的返回值形状只列了 `{parentSessionId, relationKind}`，
 * 照着手挑字段写不会有任何类型错误、不会有任何单测变红，只会让这张卡在关系
 * 图里默默挂到它状态源下面——一条画错的边，肉眼看不出是 bug。
 *
 * 所以这条断言盯的是**渲染出来的位置**：根节点在第 0 列（`x = 50`，
 * `dag/layout.ts` 的 `x = 50 + depth × 370`），挂错了就会跑到第 1 列 420。
 */
describe('DagOverlay 落位三态接线', () => {
  it('平级 Fork 出来的根会话画在第 0 列，而不是挂到它状态源下面', async () => {
    mount({
      sessions: [
        { id: 's-a', displayTitle: '甲', updatedAt: 10 },
        // DSH 说它的父是 s-a（状态就是从 s-a 复制的），但落位显式说了「在根层」
        { id: 's-peer', displayTitle: '平级', parentId: 's-a', updatedAt: 20 },
      ],
      org: {
        ...ORG,
        placements: [
          { sessionId: 's-a', taskId: 't-1', sceneId: 'sc-1', sortKey: 0, updatedAt: 1 },
          { sessionId: 's-peer', taskId: 't-1', sceneId: 'sc-1', explicitRoot: true, sortKey: 1, updatedAt: 1 },
        ],
      },
      workspaces: [{ workspaceId: 'w-1', sessionIds: ['s-a', 's-peer'] }],
    })
    await frames()
    expect(card('s-peer').style.left).toBe('50px')
    expect(card('s-a').style.left).toBe('50px')
  })

  it('去掉那个标记，同一份数据就会挂到状态源下面（证明上一条有区分力）', async () => {
    mount({
      sessions: [
        { id: 's-a', displayTitle: '甲', updatedAt: 10 },
        { id: 's-peer', displayTitle: '平级', parentId: 's-a', updatedAt: 20 },
      ],
      org: {
        ...ORG,
        placements: [
          { sessionId: 's-a', taskId: 't-1', sceneId: 'sc-1', sortKey: 0, updatedAt: 1 },
          // 同上，唯独没有 explicitRoot
          { sessionId: 's-peer', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
        ],
      },
      workspaces: [{ workspaceId: 'w-1', sessionIds: ['s-a', 's-peer'] }],
    })
    await frames()
    expect(card('s-peer').style.left).toBe('420px')
  })
})

describe('DagOverlay 点节点序列', () => {
  it('点普通节点：关浮层 → revealSession(该 id) → dismissSessionIndicator(该 id)，没有 toast', async () => {
    const { closeDag, revealSession, dismissSessionIndicator } = mount()
    await frames()
    await act(async () => { fireEvent.click(card('s-a')) })
    expect(closeDag).toHaveBeenCalledTimes(1)
    expect(revealSession).toHaveBeenCalledWith('s-a')
    expect(dismissSessionIndicator).toHaveBeenCalledWith('s-a')
    expect(dialog()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('点子代理节点：revealSession 收到的是它最近的非子代理祖先，并弹 dag.subagentRedirect', async () => {
    const { revealSession, dismissSessionIndicator } = mount()
    await frames()
    await act(async () => { fireEvent.click(card('s-sub')) })
    expect(revealSession).toHaveBeenCalledWith('s-b')
    expect(dismissSessionIndicator).toHaveBeenCalledWith('s-b')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      DAG_COPY['dag.subagentRedirect']!.replace('{title}', '子代理'),
    )
  })

  it('revealSession 返回 false：弹 dag.missing，且不清通知', async () => {
    const { revealSession, dismissSessionIndicator } = mount({ revealSession: () => false })
    await frames()
    await act(async () => { fireEvent.click(card('s-a')) })
    expect(revealSession).toHaveBeenCalledWith('s-a')
    expect(dismissSessionIndicator).not.toHaveBeenCalled()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(DAG_COPY['dag.missing'])
  })

  it('孤立子代理（没有非子代理祖先）：dag.missing，且根本不调 revealSession', async () => {
    const { revealSession, dismissSessionIndicator, closeDag } = mount()
    await frames()
    await act(async () => { fireEvent.click(card('s-lost')) })
    expect(revealSession).not.toHaveBeenCalled()
    expect(dismissSessionIndicator).not.toHaveBeenCalled()
    expect(closeDag).toHaveBeenCalledTimes(1)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(DAG_COPY['dag.missing'])
  })

  it('失败 toast 活过浮层的卸载（渲染在 open 闸门之外）', async () => {
    mount({ revealSession: () => false })
    await frames()
    await act(async () => { fireEvent.click(card('s-a')) })
    expect(dialog()).toBeNull()
    expect(screen.queryByRole('alert')).not.toBeNull()
  })
})

describe('DagOverlay 视口持久化', () => {
  it('挂载时把该页签存下的视口作为 initialTransform 交给画布', async () => {
    localStorage.setItem(dagViewportKey('sc-1'), JSON.stringify({ x: 11, y: 22, scale: 1.5 }))
    mount()
    await frames()
    const canvas = document.body.querySelector('[role="group"]')
    expect(canvas?.getAttribute('data-pan')).toBe('11,22')
    expect(canvas?.getAttribute('data-scale')).toBe('1.5')
  })

  it('变换经 200ms debounce 才落盘，按页签分键', async () => {
    mount()
    await frames()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: DAG_COPY['dag.zoom.in'] })) })
    await frames(40)
    expect(localStorage.getItem(dagViewportKey('sc-1'))).toBeNull()
    await frames(220)
    expect(readDagViewport('sc-1')?.scale).toBeCloseTo(1.1, 5)
  })

  it('debounce 还没到就关闭浮层时补写一次（卸载提交而非丢弃）', async () => {
    const { dagStore } = mount()
    await frames()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: DAG_COPY['dag.zoom.in'] })) })
    await act(async () => { dagStore.actions.setOpen(false) })
    expect(readDagViewport('sc-1')?.scale).toBeCloseTo(1.1, 5)
  })
})

describe('registerDagOverlaySeat', () => {
  async function bench() {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    return { ctx, slots: ctx.get('slots') as SlotRegistry }
  }

  it('以 matou-dag-overlay 注册进 shell.overlay', async () => {
    const { ctx, slots } = await bench()
    registerDagOverlaySeat(ctx, () => ({} as unknown as WorkbenchInjected))
    const entry = slots.entries('shell.overlay').find(candidate => candidate.options.id === DAG_OVERLAY_SEAT_ID)
    expect(entry).toBeDefined()
    expect(entry?.locale).toBe('matou')
  })

  it('disposer 移除注册（HMR 安全）', async () => {
    const { ctx, slots } = await bench()
    const dispose = registerDagOverlaySeat(ctx, () => ({} as unknown as WorkbenchInjected))
    const ids = () => slots.entries('shell.overlay').map(entry => entry.options.id)
    expect(ids()).toContain(DAG_OVERLAY_SEAT_ID)
    dispose()
    expect(ids()).not.toContain(DAG_OVERLAY_SEAT_ID)
  })

  it('把同一个 workbenchFace 原样接到 inject', async () => {
    const { ctx, slots } = await bench()
    const face = { marker: 'workbenchFace' } as unknown as WorkbenchInjected
    registerDagOverlaySeat(ctx, () => face)
    const entry = slots.entries('shell.overlay').find(candidate => candidate.options.id === DAG_OVERLAY_SEAT_ID)!
    expect((entry.inject as () => unknown)()).toBe(face)
  })
})
