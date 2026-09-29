import { registerCapabilities } from './capabilities/register.tsx'
import { registerMessageFork } from './carousel/message-fork.tsx'
/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * four child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action contract; navigation state lives
 * with the runtime sessions service. A second effect seats the theme
 * presenter, which projects ctx.theme snapshots onto document.body.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelActions } from './service.ts'
import { registerImport } from './import/register.ts'
import { AppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'
import { MATOU_PLUGIN_REMOTE } from './org/remote-contribution.ts'
import { createOrgClient, createOrgMirrorStore } from './org/store.ts'
import type { MatouOrgClient } from './org/store.ts'
import { createDagPanelStore } from './dag/panel-store.ts'
import { registerDagOverlaySeat } from './dag/DagOverlay.tsx'
import { createBrowserNotificationStore } from './notifications/browser-store.ts'
import type { AgentNotificationSnapshot } from './notifications/store.ts'
import { createPanelStore } from './notifications/panel-store.ts'
import { registerBellSeat } from './notifications/Bell.tsx'
import { registerNotificationCenterSeat } from './notifications/NotificationCenter.tsx'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { TaskSidebarSeat } from './workbench/TaskSidebarSeat.tsx'
import { registerHeaderSeats } from './carousel/header-seats.tsx'
import { createLevelStore } from './carousel/level-store.ts'
import { createRevealStore } from './carousel/reveal-store.ts'
import { en, zh } from './locales.ts'
import { createNavStore } from './nav/store.ts'
import { createWorkbenchActions } from './workbench/actions.ts'
import type { WorkbenchInjected } from './workbench/face.ts'

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
    /** Client mirror of the plugin-owned organization document. */
    matouOrg: MatouOrgClient
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // 这四个座位（sidebar / main / rightbar / shell.overlay）**故意不在这里声明**。
    //
    // 本插件替换官方 `ui-layout`，但官方那份的**类型**始终在编译范围内
    // （0.1.5 起 ui-sidebar / ui-conversation / ui-workspace 都引用它），
    // 而它已经把这四个名字声明进 SlotMap。两边各声明一次、只要有一个字段不同，
    // TypeScript 就报 TS2717「同名属性类型必须一致」——0.1.5 里 `rightbar` 多了
    // owner 属性，就是这么撞上的。
    //
    // 所以这里只声明**本插件自己新增**的座位，四个根座位沿用官方声明：
    // 既不会漂移，也天然保证我们渲染的 opts 与占位者期望的一致。
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
// `uiWorkspace` 刻意**不在**这个列表里：0.1.5 起它 inject 了 `layout`，而
// `layout` 正是本插件提供的——把它列为必需依赖会让两边互等，整个 Web 客户端
// 启不来（实测：15 个条目全部 pending）。它唯一的用途是用户点「添加工作区」时
// 弹目录选择器，用到时再取即可，见 `workbench/actions.ts` 的 `pickDirectory`。
export const inject = ['slots', 'theme', 'locale', 'sessions', 'workspaces', 'remote', 'uiSession']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
/** 本布局的中央永远是工作台，没有第二个主面板；见下方 `panelInfo` 的注释。 */
const PANEL_INFO = Object.freeze({ activePanelId: null })

export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  // Stores are created in apply world (cache-warmed at once); the org client
  // attaches when the remote namespace is mounted below.
  const orgStore = createOrgMirrorStore().create()
  const navStore = createNavStore().create()
  const levelStore = createLevelStore().create()
  // S4 Task 8 (裁定 T-5): the per-scene "re-center on this session" counter.
  // Written only by `revealSession`, read only by AppFrame's `Carousel` — but
  // still a module-level store for the Ruling-S5-1 reason the others give:
  // the writers reach it from the DAG overlay and the notification panel,
  // both seats outside AppFrame's own React subtree.
  const revealStore = createRevealStore().create()
  // The browser composition layer (S5 Task 1/2), never the bare
  // `createNotificationStore()`: only this one wires real sound +
  // persisted on/off through `./notifications/sound.ts` (see
  // `browser-store.ts`'s module doc for why the bare factory must stay
  // safe-by-default). `getSnapshot`/`subscribe` adapt its `snapshot()`
  // method name to the `HostObservable` shape `hooks.notifications` needs;
  // `push` (and every other store method) still reach callers unchanged
  // through `notificationsStore` itself.
  const notificationsStore = createBrowserNotificationStore()
  const notificationsSource: HostObservable<AgentNotificationSnapshot> = {
    getSnapshot: () => notificationsStore.snapshot(),
    subscribe: (fn) => notificationsStore.subscribe(fn),
  }
  // S5 Task 6: the notification-center panel's open/closed flag — same
  // module-level-store shape as org/nav/level (see `panel-store.ts`'s module
  // doc for why this must NOT be local React state). The bell's click and
  // Task 7's `shell.overlay` occupant share this one instance through the
  // face below (`hooks.panel` for reads, `togglePanel` for the write).
  const panelStore = createPanelStore().create()
  // S4 Task 7: the session-DAG overlay's open/closed flag. Same
  // module-level-store reason as `panelStore` above (Ruling-S5-1) — the tab
  // bar's 「会话 DAG」 button lives inside AppFrame's stage while the overlay
  // is a `shell.overlay` seat, two disjoint React subtrees. Written through
  // the actions' `openDag`/`closeDag`, read through `hooks.dag`.
  const dagStore = createDagPanelStore().create()
  let orgClient: MatouOrgClient | undefined
  const actions = createWorkbenchActions({
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    // `ctx.uiWorkspace` 这样直接读会抛 `cannot get property "uiWorkspace" without
    // inject` —— Cordis 的守卫在**属性访问那一刻**就拦，可选链救不了。0.1.5 迁移把
    // uiWorkspace 移出 inject（见上方注释）之后，「添加工作区」按钮就一直是死的，
    // 点下去只在控制台留一个未捕获异常。`ctx.reflect.get(name)` 不走那道守卫：
    // 服务没起或没装就返回 undefined。
    pickDirectory: () => ctx.reflect.get('uiWorkspace')?.pickDirectory(),
    getOrg: () => orgClient,
    nav: navStore,
    level: levelStore,
    dag: dagStore,
    reveal: revealStore,
    // Read-only, imperative access to the same pending-interaction source
    // `useSessionPendingInteraction` binds reactively (ui-session's
    // `ctx.uiSession.pendingInteractions`, a plain HostObservable) — needed
    // by drillTo's "focus the first active child" (spec §4), which runs
    // from event handlers outside React.
    pendingInteractions: ctx.uiSession.pendingInteractions,
  })
  // Stable identity on purpose: the renderer caches the bound keyed hook by
  // this function's object identity (`keyedObservableHook`'s WeakMap), so it
  // is created once here rather than inside `workbenchFace()`.
  const sessionLifecycleOf = (sessionId: string) => ctx.sessions.binding(sessionId as SessionId)?.session
  const workbenchFace = (): WorkbenchInjected => ({
    ...actions,
    hooks: {
      org: orgStore,
      nav: navStore,
      level: levelStore,
      reveal: revealStore,
      notifications: notificationsSource,
      panel: panelStore,
      dag: dagStore,
    },
    keyedHooks: { sessionLifecycle: sessionLifecycleOf },
    pushNotification: notificationsStore.push,
    togglePanel: panelStore.actions.toggle,
    // S5 Task 7: dedicated close (`setOpen(false)`) rather than another
    // `toggle` — see `WorkbenchInjected.closePanel`'s doc for why, and for
    // the review-corrected account of the bell-click double-flip this does
    // NOT by itself prevent (that fix lives in `NotificationCenter.tsx`).
    closePanel: () => { panelStore.actions.setOpen(false) },
    removeNotification: notificationsStore.remove,
    clearNotifications: notificationsStore.clear,
    setNotificationSoundEnabled: notificationsStore.setSoundEnabled,
    // S5 Task 8's two read rules, straight off the same store instance:
    // the card click deletes that session's records, a sidebar click marks
    // the whole workspace read (码头 `TerminalPane.tsx:314` /
    // `TaskSidebar.tsx:223, 268` — see `WorkbenchInjected` for why the two
    // verbs differ).
    dismissSessionIndicator: notificationsStore.dismissSessionIndicator,
    markWorkspaceRead: notificationsStore.markWorkspaceRead,
  })
  ctx.effect(() => ctx.locale.register('matou', { zh, en }), 'matou-layout: dictionaries')
  ctx.effect(() => {
    /**
     * `usePanelInfo` 是 DSH 0.1.5 的**框架标准属性**（官方 `ui-layout` 把它声明进
     * `GlobalStandardProps`），由根上的 `panelInfo` 钩子生成。官方 `ui-sidebar-right`
     * 的 `RightbarRoot` 直接调它——不提供就是运行时 `usePanelInfo is not a function`，
     * 而渲染期抛错会中断提交阶段，连带让本框架自己的布局副作用（轮播的滚动跟随就在
     * 里面）也跑不起来。走查里的表现是：点卡片能聚焦、能变宽，**但带子完全不滚**。
     *
     * 本布局的中央永远是工作台（`main` 座位只有 `conversation` 这一个 key），
     * 所以 `activePanelId` 恒为 `null`；用一个不变的快照源即可，无需真的存状态。
     * 与 `LayoutController.selectPanel` 的语义一致：本布局没有第二个主面板。
     */
    const disposePanelInfo = ctx.slots.provideRoot({
      hooks: {
        panelInfo: {
          getSnapshot: () => PANEL_INFO,
          subscribe: () => () => {},
        },
      },
    })
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'matou',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout;
      // conversation business actions belong to their registrants.
      inject: (panelActions: PanelActions): WorkbenchInjected => {
        layout.attachPanels(panelActions)
        return workbenchFace()
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
      disposePanelInfo()
    }
  }, 'matou-layout: service + root registration')

  // The task tree seats in the official sidebar's "工作区" region: same slot
  // as the stock workspace browser, lower priority, so it renders instead —
  // the sidebar shell (brand, New Session, settings, collapse) stays stock.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -1,
    locale: 'matou',
    inject: workbenchFace,
  }, TaskSidebarSeat))

  // S5 Task 6: the sidebar-footer bell — the notification center's entry
  // point. Extracted into `registerBellSeat` (Bell.tsx) rather than inlined
  // here, mirroring `registerHeaderSeats` below, so the registration itself
  // is testable without the plugin's full service graph.
  registerBellSeat(ctx, workbenchFace)

  // S5 Task 7: the notification-center panel itself, into the frame-wide
  // `shell.overlay` list seat (`AppFrame.tsx`'s `.overlayLayer`). Same
  // registration-lives-with-the-component convention as `registerBellSeat`
  // (and `registerHeaderSeats` below) — see `NotificationCenter.tsx`'s
  // module doc.
  registerNotificationCenterSeat(ctx, workbenchFace)

  // S4 Task 12: the session-DAG overlay, a second `shell.overlay` entry beside
  // the notification center (the slot is `kind: 'list'`, so the two coexist by
  // id). It renders its own subtree through a `document.body` portal rather
  // than inside the layer — see `DagOverlay.tsx`'s module doc for why the seat
  // is kept while the DOM leaves it.
  registerDagOverlaySeat(ctx, workbenchFace)

  // 码头's card-header actions (child badge / fork-child / fork-sibling /
  // fork-peer / remove) appended into DSH's own official session header —
  // see header-seats.tsx's module doc for why this merges rather than draws
  // a second header. orgStore is the same mirror instance workbenchFace()
  // already exposes as hooks.org — one store, two consumers.
  registerHeaderSeats(ctx, orgStore, actions)
  registerImport(ctx)
  registerCapabilities(ctx)
  registerMessageFork(ctx, orgStore, actions)

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'matou-layout: theme presenter')

  // Organization mirror: mount the hand-written remote contribution, then
  // expose ctx.matouOrg over a cache-warmed store. `remote` is a declared
  // dependency (as in the official remotes assembly). The mounted namespace
  // is its own cordis service (`remote.matouLayout`) and a fiber may only
  // touch services it declares, so the client binds inside a nested inject
  // that resolves once the mount has installed it.
  ctx.effect(async () => {
    let disposeMount: (() => Promise<void>) | undefined
    try {
      disposeMount = await ctx.remote.$mount(MATOU_PLUGIN_REMOTE)
    } catch (reason: unknown) {
      // A refused mount must not take the layout down: degrade the mirror
      // (the sidebar narrates it) and leave a diagnostic for the console.
      console.error('[matou-layout] remote namespace mount failed', reason)
      orgStore.actions.degrade()
      return () => {}
    }
    const binding = ctx.inject(['remote.matouLayout'], (nsCtx) => {
      const client = createOrgClient(nsCtx.remote.matouLayout, orgStore)
      orgClient = client
      const disposeService = nsCtx.reflect.provide('matouOrg', client)
      // Warm start renders from cache; the host answer replaces it when it
      // lands. A failure leaves the degraded phase for the UI to narrate.
      void client.refresh()
      nsCtx.effect(() => () => {
        orgClient = undefined
        void disposeService()
      }, 'matou-layout: org client')
    })
    return () => {
      void binding.dispose()
      void disposeMount?.()
    }
  }, 'matou-layout: org remote mount')
}
