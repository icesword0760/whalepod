/**
 * The inject face the root registration hands to AppFrame: the write actions
 * plus observable hooks (org mirror, navigation memory, carousel drill layer,
 * per-scene forced-recenter requests, notification history,
 * notification-center panel open/closed, session-DAG overlay open/closed) the
 * renderer binds as `useOrg` / `useNav` / `useLevel` / `useReveal`
 * / `useNotifications` / `usePanel` / `useDag` props, plus
 * `pushNotification`, `togglePanel`, `closePanel`,
 * `removeNotification`, `clearNotifications`, and
 * `setNotificationSoundEnabled` — plain passthrough members (outside the
 * `hooks` compartment the renderer strips down to read-only selector hooks)
 * so AppFrame's derived-signal subscription (S5 Task 4), the sidebar bell
 * (S5 Task 6, `notifications/Bell.tsx`), and the notification-center panel
 * (S5 Task 7, `notifications/NotificationCenter.tsx`) can call each store's
 * imperative write directly. The SAME face factory is handed to `root`,
 * `sidebar.workspaces`, `sidebar.footer.action`, and `shell.overlay` — see
 * `index.ts`'s `workbenchFace`.
 * @module dsh-plugin-matou-layout/src/client/workbench/face
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLifecycleFacts } from '../carousel/CardShell.tsx'
import type { LevelState } from '../carousel/level-store.ts'
import type { RevealState } from '../carousel/reveal-store.ts'
import type { NavMemory } from '../nav/navigation.ts'
import type { OrgMirrorState } from '../org/store.ts'
import type { DagPanelState } from '../dag/panel-store.ts'
import type { AgentNotification, AgentNotificationInput, AgentNotificationSnapshot } from '../notifications/store.ts'
import type { PanelState } from '../notifications/panel-store.ts'
import type { WorkbenchActions } from './actions.ts'

export interface WorkbenchInjected extends WorkbenchActions {
  readonly hooks: {
    readonly org: HostObservable<OrgMirrorState>
    readonly nav: HostObservable<NavMemory>
    /** Current carousel drill layer per scene (`level-store.ts`); not persisted. */
    readonly level: HostObservable<LevelState>
    /**
     * Per-scene forced-recenter requests (S4 Task 8, `carousel/reveal-store.ts`).
     * Read-only side of the one store instance `revealSession` writes; the
     * writer is that action, not a member here, so there is no imperative
     * counterpart to hoist out of `hooks` (unlike `togglePanel` below).
     *
     * `AppFrame` reads this hook directly — NOT through `useWorkbenchView`,
     * which projects the org/nav/level triple every surface shares. This one
     * has exactly one consumer (the `Carousel` element in `AppFrame`), same
     * as `useNotifications`.
     */
    readonly reveal: HostObservable<RevealState>
    /** Notification history read model (S5); the store instance itself lives in `index.ts`. */
    readonly notifications: HostObservable<AgentNotificationSnapshot>
    /**
     * Notification-center panel open/closed (S5 Task 6, `notifications/panel-store.ts`).
     * The bell's own click never reads this — only `togglePanel` below — but
     * S5 Task 7's `shell.overlay` occupant needs a read model to decide
     * whether to render the panel at all, and it is the same module-level
     * store instance the bell's `togglePanel` writes to (Ruling-S5-1: the two
     * are different seats in different React subtrees).
     */
    readonly panel: HostObservable<PanelState>
    /**
     * Session-DAG overlay open/closed (S4 Task 7, `dag/panel-store.ts`).
     * Read-only side of the same one store instance the tab bar's button
     * writes through `openDag` — the two are different seats in different
     * React subtrees (Ruling-S5-1), exactly like `panel` above.
     *
     * Its WRITES are NOT here: `openDag`/`closeDag` are plain members of
     * {@link WorkbenchActions}, which this interface extends, so they arrive
     * at the top level and survive the renderer's rebinding of the `hooks`
     * compartment into read-only selector hooks — the same reason
     * `pushNotification`/`closePanel` below are top-level.
     */
    readonly dag: HostObservable<DagPanelState>
  }
  /**
   * The notification store's imperative write side. NOT under `hooks`
   * (that compartment is rebound into a read-only `useNotifications`
   * selector hook by the renderer — see `bindInjectSources` in
   * `ui-renderer/client/scoped-slots.tsx` — so an imperative method placed
   * there would vanish from the component's props entirely). Kept as a
   * plain top-level member instead, exactly like `WorkbenchActions`'s own
   * methods, so it survives that transform unchanged.
   */
  pushNotification(input: AgentNotificationInput): AgentNotification | null
  /**
   * Flip the notification-center panel open/closed (`panel-store.ts`'s
   * `toggle`). Same reasoning as `pushNotification`: a top-level passthrough
   * so the write survives the renderer's `hooks`-compartment rebinding.
   */
  togglePanel(): void
  /**
   * Close the notification-center panel unconditionally (`panel-store.ts`'s
   * `setOpen(false)`) — S5 Task 7's Esc/click-outside/close-button paths use
   * this rather than `togglePanel` simply because those paths mean "closed",
   * never "flip": using the honest verb keeps the intent legible at each
   * call site, even though (CORRECTION, S5 Task 7 review) it does NOT by
   * itself prevent any double-flip. `closePanel` only ever runs while `open`
   * is already `true` — `NotificationCenter.tsx`'s outside-click effect is
   * scoped to `open` — so at that instant `setOpen(false)` and `toggle()`
   * produce the identical result; an earlier version of this doc claimed
   * otherwise and was wrong. The REAL bell-click double-flip this project
   * once had (pointerdown on the bell closes the panel via this file's
   * outside-click path, the bell's own subsequent `click` → `togglePanel()`
   * then reopens it, since it now reads `open === false`) is fixed in
   * `NotificationCenter.tsx` by excluding the bell from that outside-click
   * check entirely (`Bell.tsx`'s `BELL_ANCHOR_ATTR`) — see that file's
   * module doc for the full sequence. Top-level passthrough for the same
   * `hooks`-rebinding reason as `pushNotification`/`togglePanel`.
   */
  closePanel(): void
  /**
   * Remove one notification record (`store.ts`'s `remove`). Top-level
   * passthrough — same `hooks`-rebinding reason as `pushNotification`: the
   * component layer only ever gets the read-only `useNotifications` selector
   * hook from `hooks.notifications`, never the store instance itself.
   */
  removeNotification(id: string): void
  /** Clear every notification record (`store.ts`'s `clear`). Same passthrough reasoning. */
  clearNotifications(): void
  /**
   * Delete every notification recorded against one session (`store.ts`'s
   * `dismissSessionIndicator`) — S5 Task 8's 「点击卡片任意处删除该会话全部
   * 通知」, ported from 码头 `hierarchy/TerminalPane.tsx:314`. A DELETE, not a
   * mark-read: 码头 removes the records outright here, which is what lets the
   * card's ring, the tab dot, the task badge and the bell all go dark at once
   * without any of them re-deriving a lingering read row.
   *
   * Reaches `AppFrame` as a plain prop (top-level, like `pushNotification`)
   * and is handed to `Carousel`'s `onDismissNotifications`.
   */
  dismissSessionIndicator(sessionId: string): void
  /**
   * Mark every notification in one workspace read (`store.ts`'s
   * `markWorkspaceRead`) — S5 Task 8's 「点事项行或工作区头 = 整个工作区已
   * 读」, ported from 码头 `hierarchy/TaskSidebar.tsx:223, 268`. Note the
   * asymmetry with `dismissSessionIndicator` above, which is 码头's own: the
   * card click DELETES that session's rows, while a sidebar click only marks
   * the workspace READ, so the notification center still lists them.
   *
   * Workspace-scoped even from a task row — the store has no `markTaskRead`,
   * and 码头 never asks for one.
   */
  markWorkspaceRead(workspaceId: string): void
  /** Toggle the persisted sound preference (`store.ts`'s `setSoundEnabled`). Same passthrough reasoning. */
  setNotificationSoundEnabled(enabled: boolean): void
  /**
   * Open-key source families (the framework binds each into a
   * `use<Name>(key, selector)` prop — see `InjectFace`/`PropsKeyedHooks`).
   */
  readonly keyedHooks: {
    /**
     * One session's LIVE lifecycle snapshot, straight off DSH's own session
     * instance (`ctx.sessions.binding(id)?.session`, an
     * `ObservableSnapshot<SessionSnapshot>`). This is the same source DSH's
     * `ConversationSessionHeader` reads to decide whether to draw itself, and
     * a card needs it for exactly that question (I4): the session LIST's
     * `blank` lags it by a full prompt round trip, which is how the card and
     * DSH's own header ended up both drawn at once. Absent for a session with
     * no binding yet; the hook then reports `undefined` and callers fall back
     * to the list projection.
     */
    readonly sessionLifecycle: (sessionId: string) => HostObservable<SessionLifecycleFacts> | undefined
  }
}
