/**
 * The workbench's write face: every user action that changes the organization
 * document, the navigation memory, or a DSH session goes through here. Virtual
 * default tasks/scenes are materialized on first write (same deterministic id,
 * so the derived view swaps the virtual row for the stored one seamlessly).
 * @module dsh-plugin-matou-layout/src/client/workbench/actions
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { StoreInstance } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defaultSceneId, defaultTaskId } from '../../org/model.ts'
import type { MatouOrgOp } from '../../org/ops.ts'
import type { MatouOrgApplyResult } from '../../org/wire.ts'
import { childrenOfLevel } from '../carousel/graph.ts'
import type { CarouselNode } from '../carousel/graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from '../carousel/nodes.ts'
import type { LevelActions, LevelState } from '../carousel/level-store.ts'
import type { RevealActions, RevealState } from '../carousel/reveal-store.ts'
import type { DagPanelActions, DagPanelState } from '../dag/panel-store.ts'
import { DEFAULT_GROUP_TITLE, deriveOrgView } from '../org/derive.ts'
import { locateSession } from '../nav/navigation.ts'
import type { NavMemory, NavTarget } from '../nav/navigation.ts'
import type { NavActions } from '../nav/store.ts'
import type { MatouOrgClient } from '../org/store.ts'
import { selectKnownSessionIds } from './known-sessions.ts'
import { CHILD_STATE_PRIORITY, sessionDotState } from './status.ts'

/** A task as the UI addresses it: virtual rows carry the title to materialize with. */
export interface TaskRef {
  readonly workspaceId: string
  readonly taskId: string
  readonly virtual: boolean
  readonly title: string
}

/** A scene plus its owning task, both possibly virtual. */
export interface SceneRef extends TaskRef {
  readonly sceneId: string
  readonly sceneVirtual: boolean
  readonly name: string
}

export interface WorkbenchDeps {
  readonly sessions: Pick<ISessions, 'create' | 'open' | 'clear' | 'binding' | 'pin' | 'unpin' | 'fork' | 'list'>
  readonly workspaces: Pick<IWorkspaces, 'archiveSession' | 'create' | 'list'>
  /**
   * DSH's own directory picker (native OS chooser on the Host), resolved
   * **at call time** rather than captured at assembly.
   *
   * Why lazily: DSH 0.1.5 made `ui-workspace` inject `layout` (its navigation
   * calls `ctx.layout.selectPanel` / `beginNavigation`). This plugin PROVIDES
   * `layout`, so listing `uiWorkspace` among its own required services
   * deadlocks the boot — `ui-workspace` waits for `layout`, this plugin waits
   * for `uiWorkspace`, and neither activates. The web client then boots with
   * 15 dead entries and no workbench at all.
   *
   * Nothing here needs the picker until the user clicks 「添加工作区」, long
   * after both plugins are up, so the dependency does not belong in `inject`.
   * Returns `undefined` when the service is genuinely absent, which the
   * caller turns into an honest failure rather than a silent no-op.
   */
  readonly pickDirectory: () => Promise<string | null> | undefined
  /** The org client appears once the remote namespace is mounted. */
  readonly getOrg: () => MatouOrgClient | undefined
  readonly nav: StoreInstance<NavMemory, NavActions>
  /** Which layer of the carousel each scene currently shows (`level-store.ts`); not persisted. */
  readonly level: StoreInstance<LevelState, LevelActions>
  /** Whether the session-DAG overlay is open (`dag/panel-store.ts`); not persisted. */
  readonly dag: StoreInstance<DagPanelState, DagPanelActions>
  /**
   * Per-scene "force the carousel back onto this session" requests
   * (`carousel/reveal-store.ts`); not persisted. Written by
   * {@link WorkbenchActions.revealSession} only, on its success path.
   */
  readonly reveal: StoreInstance<RevealState, RevealActions>
  /**
   * Imperative read of the same source `useSessionPendingInteraction` binds
   * reactively (`ctx.uiSession.pendingInteractions`) — `drillTo`'s
   * "focus the first active child" (spec §4) needs the 等待输入 signal and
   * runs outside React. Narrowed to just the read shape actually used.
   */
  readonly pendingInteractions: { getSnapshot(): { has(sessionId: string): boolean } }
  readonly newId?: () => string
}

export interface WorkbenchActions {
  /** Pick a directory with DSH's picker and register it; a cancel is a no-op. */
  addWorkspace(): Promise<void>
  createTask(workspaceId: string, title: string): Promise<string>
  renameTask(task: TaskRef, title: string): Promise<void>
  setTaskPinned(task: TaskRef, pinned: boolean): Promise<void>
  deleteTask(task: TaskRef): Promise<void>
  createScene(task: TaskRef, name: string): Promise<string>
  renameScene(scene: SceneRef, name: string): Promise<void>
  deleteScene(scene: SceneRef): Promise<void>
  /**
   * `parentSessionId` places the new session under the current drill layer's
   * parent (spec §4 "页签内'新会话'"); omitted (or the scene's root layer)
   * leaves it unparented.
   */
  newSession(scene: SceneRef, parentSessionId?: string): Promise<void>
  newSessionNextTo(sessionId: string): Promise<void>
  reorderCards?: ((sessionIds: readonly string[]) => Promise<void>) | undefined
  openSession(sessionId: string): void
  clearSession(): void
  /** Keep a session's window open beside the current one (multi-pane); DSH patch `matou/multi-stage`. */
  pinSession(sessionId: string): void
  unpinSession(sessionId: string): void
  renameSession(sessionId: string, title: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  navigate(target: NavTarget): void
  /**
   * Bring one session back on screen — 码头 `TaskSidebar.tsx:159-182`'s
   * `navigateNotification` body, which S5 Task 8's notification rows call
   * ("点条目跳转"). 码头 runs four separate activations (workspace → task →
   * scene → session) and then `HierarchyShell.tsx:1040-1055`'s
   * `onRevealSession`, which resets that scene's layer to the target's own
   * `parentSessionId ?? null` — otherwise a session sitting one layer down
   * simply is not rendered by the layer the user is looking at. Here that is
   * {@link navigate} (this repo's nav memory writes all four levels in one
   * call), `setLevel`, and `sessions.open` (码头's `activateSession`: nav
   * memory alone does not move DSH's current session when the scene does not
   * change).
   *
   * Deliberate divergences from 码头, both recorded as rulings:
   *
   * - **No "detached to another window" branch (Ruling-S5-7).** 码头 refuses
   *   to reveal a pane that was torn off into a second native window; DSH has
   *   no such dimension, so no equivalent is invented.
   * - **One failure, not two (Ruling-S5-8).** 码头 answers "workspace gone"
   *   with a bare `return` — a dead click: no feedback, the panel still open.
   *   Here every unreachable target is the same `false`, and the caller
   *   (`notifications/NotificationCenter.tsx`) gives them all the same toast.
   *
   * There is also no three-tier task fallback (码头 falls back to the
   * workspace's last-active task, then its first task, so a jump still lands
   * SOMEWHERE when only the task is gone). This plugin's notifications always
   * name a session, and {@link locateSession} answers with a complete
   * workspace/task/scene home or nothing at all — there is no middle state to
   * fall back through.
   *
   * A fourth write joins those three on success (S4 Task 8, 裁定 T-5): a
   * per-scene reveal request (`carousel/reveal-store.ts`) whose counter the
   * carousel re-centers on unconditionally. It is what makes revealing the
   * ALREADY-focused session visible — 码头 carries the same `sequence`
   * (`HierarchyShell.tsx:1047-1054`) for the same reason.
   * @param sessionId - the session to activate and center.
   * @returns whether the target still exists and was revealed; `false` leaves
   * every store untouched.
   */
  revealSession(sessionId: string): boolean
  /**
   * Switch the carousel's current layer to `sessionId`'s children and focus
   * the first ACTIVE one, if any (spec §4 "点徽标下钻并聚焦首个活跃子会话"):
   * ranked by `CHILD_STATE_PRIORITY` (等待输入 > 运行中 > 已完成), falling
   * back to the first child in MRU order when every child is idle.
   */
  drillTo(sessionId: string): void
  /**
   * Pop the carousel's current layer for `sceneId` back to its parent's own
   * layer, focusing the session that was the drilled-into parent. A no-op at
   * the scene's root layer.
   */
  returnToParent(sceneId: string): void
  /**
   * 码头 spec §4 fork table, "创建子分支": fork A's state, place the child
   * under A, switch the current layer to A's children, and focus the child.
   * @param sessionId - the source card (A).
   * @param name - user-entered branch name (already validated unique in the
   * target layer by the caller — see `card-actions.tsx`); applied via rename
   * after the fork resolves.
   */
  forkChild(sessionId: string, name: string, atSeq?: number): Promise<void>
  /**
   * 码头 spec §4 fork table, "兄弟分支": fork A's EFFECTIVE PARENT's state,
   * place the child under that same parent, alongside A. Stays in the
   * current layer (no drill).
   */
  forkSibling(sessionId: string, name: string): Promise<void>
  /**
   * 码头 spec §4 fork table, right-click "⑂ Fork 会话": fork A's OWN state
   * (a copy of A's current conversation), but place the child under A's
   * effective parent (or unparented when A is itself a root session).
   */
  forkPeer(sessionId: string, name: string): Promise<void>
  /**
   * Archive `sessionId`'s card. The caller (`card-actions.tsx`) confirms
   * first, offering "仅本卡 / 含所有子代" once `sessionId` has children
   * (spec §3/§7.1). `cascade` archives the whole subtree (carousel-visible
   * descendants only — subagents are S4/DAG territory, see Ruling-4) when
   * true, just `sessionId` when false. Rejects without archiving anything
   * when the removal would leave the owning scene with zero sessions (spec
   * §3 "会清空页签时拒绝" / §7.1 "移除页签里最后一张被拒绝").
   */
  removeCard(sessionId: string, cascade: boolean): Promise<void>
  /**
   * Commit each named session's carousel sort key (`MatouPlacement.interactionAt`).
   *
   * The one write path behind spec §7.1 step 5's 「正在操作的卡不跳位」: WHICH
   * sessions to commit is decided by `carousel/interaction-commit.ts`, this
   * only puts the numbers in the document. Batched because the maintaining
   * effect discovers several at once (a tab switch commits the card being
   * left AND every card that moved while the user was away), and one document
   * write beats N.
   *
   * Unplaced sessions are ignored by the reducer rather than rejecting the
   * batch — see the op's own doc for the timing window that makes that
   * necessary.
   */
  commitInteractions(commits: readonly { readonly sessionId: string; readonly at: number }[]): Promise<void>
  /**
   * Open the session-DAG overlay (S4): `dag/panel-store.ts`'s `setOpen(true)`.
   *
   * REQUIRED, not optional. It was `openDag?()` while the overlay did not
   * exist, and the tab bar called it as `actions.openDag?.()` — which turns a
   * missing wire into a button that silently does nothing. Now the only
   * producer of a `WorkbenchActions` value is `createWorkbenchActions` below,
   * so an unwired overlay is a compile error in `src` instead.
   */
  openDag(): void
  /**
   * Close the session-DAG overlay: `setOpen(false)`. A separate verb rather
   * than a `toggle` because the two directions always come from two different
   * interactions — while the overlay is open `#root` is `inert`, so the tab
   * bar's button that opened it cannot be clicked again (see
   * `dag/panel-store.ts`'s module doc for the full argument, and
   * `face.ts`'s `closePanel` for the same "honest verb" convention on the
   * notification panel).
   */
  closeDag(): void
}

/** Ops that turn a virtual task into a stored row; empty when already stored. */
export function materializeTaskOps(task: TaskRef): MatouOrgOp[] {
  return task.virtual
    ? [{ kind: 'task/create', id: task.taskId, workspaceId: task.workspaceId, title: task.title }]
    : []
}

/** Ops that turn a virtual scene (and its task) into stored rows. */
export function materializeSceneOps(scene: SceneRef): MatouOrgOp[] {
  return [
    ...materializeTaskOps(scene),
    ...(scene.sceneVirtual
      ? [{ kind: 'scene/create' as const, id: scene.sceneId, taskId: scene.taskId, name: scene.name }]
      : []),
  ]
}

function defaultId(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

/**
 * Build the write face over live services.
 * @param deps - sessions/workspaces services, the org client getter, nav store.
 * @returns the actions the workbench components call.
 */
export function createWorkbenchActions(deps: WorkbenchDeps): WorkbenchActions {
  const newId = deps.newId ?? defaultId

  const requireOrg = (): MatouOrgClient => {
    const org = deps.getOrg()
    if (org === undefined) throw new Error('matou-layout: organization service is not ready yet')
    return org
  }

  /** One apply, retried once after a revision conflict (the client re-synced). */
  const apply = async (ops: readonly MatouOrgOp[]): Promise<void> => {
    if (ops.length === 0) return
    const org = requireOrg()
    let outcome: MatouOrgApplyResult = await org.apply(ops)
    if (!outcome.ok && outcome.error.code === 'revision-conflict') outcome = await org.apply(ops)
    if (!outcome.ok) {
      throw new Error(outcome.error.code === 'invalid-op'
        ? `matou-layout: ${outcome.error.reason}`
        : 'matou-layout: organization changed elsewhere; please retry')
    }
  }

  /**
   * The full derived workbench view, built imperatively from live snapshots
   * (not a React hook — `drillTo`/`forkChild`/etc. run from plain event
   * handlers, including ones registered outside any component, see
   * `header-seats.tsx`'s `registerHeaderSeats`). Reuses the exact same pure
   * derivation `useWorkbenchView.ts` runs reactively.
   */
  const currentView = () => {
    const org = deps.getOrg()
    const sessionsSnap = deps.sessions.list.getSnapshot()
    const workspacesSnap = deps.workspaces.list.getSnapshot()
    const orgState = org?.store.getSnapshot().org ?? { tasks: [], scenes: [], placements: [] }
    const knownSessionIds = selectKnownSessionIds({
      ids: sessionsSnap.ids,
      summaryOf: id => sessionsSnap.byId[id as never],
      archivedIds: workspacesSnap.archivedSessionIds,
      currentId: sessionsSnap.current,
      org: orgState,
    })
    return {
      view: deriveOrgView({ workspaces: workspacesSnap.items, knownSessionIds, org: orgState }),
      orgState, sessionsSnap, workspacesSnap,
    }
  }

  /** The task/scene `sessionId` is placed in, honoring the virtual-default fallback (see `nav/navigation.ts#locateSession`). */
  const locationOf = (sessionId: string) => locateSession(currentView().view, sessionId)

  /**
   * `sessionId`'s scene as a {@link SceneRef} — the addressable form
   * `placement/set` needs, carrying the `virtual`/`sceneVirtual` flags so a
   * caller can materialize a still-virtual default task/scene first
   * ({@link materializeSceneOps}). Richer than {@link locationOf}, which
   * answers only "which ids", not "do those rows exist yet".
   * @param view - the derived workbench view to search.
   * @param sessionId - the session to locate.
   * @returns the scene reference, or undefined when no scene lists the session.
   */
  const sceneRefOf = (
    view: ReturnType<typeof currentView>['view'], sessionId: string,
  ): SceneRef | undefined => {
    for (const workspace of view) {
      for (const task of workspace.tasks) {
        for (const scene of task.scenes) {
          if (!scene.sessions.some(ref => ref.sessionId === sessionId)) continue
          return {
            workspaceId: workspace.workspaceId,
            taskId: task.id,
            virtual: task.virtual,
            title: task.title,
            sceneId: scene.id,
            sceneVirtual: scene.virtual,
            name: scene.name,
          }
        }
      }
    }
    return undefined
  }

  /**
   * The graph `drillTo`/`removeCard` traverse, through the SHARED projection
   * (`carousel/nodes.ts`, Ruling-20) so it answers exactly what AppFrame's
   * carousel and the header seat answer — archived and subagent sessions out,
   * a parent that is itself gone read as "root".
   * @param sceneId - when given, restricts the graph to that scene's own
   *   sessions (M8: a descendant walk must not wander into another tab, where
   *   spec §4 forbids the parent link from pointing anyway); omitted, every
   *   known session participates.
   * @returns the projected nodes.
   */
  const nodesOf = (sceneId?: string): CarouselNode[] => {
    const { view, orgState, sessionsSnap, workspacesSnap } = currentView()
    const sceneSessions = sceneId === undefined
      ? undefined
      : view.flatMap(workspace => workspace.tasks)
        .flatMap(task => task.scenes)
        .find(scene => scene.id === sceneId)?.sessions
    return projectCarouselNodes({
      ids: sceneSessions === undefined ? sessionsSnap.ids : sceneSessions.map(ref => ref.sessionId),
      summaryOf: id => sessionsSnap.byId[id as SessionId],
      placementsBySession: placementsBySessionOf(orgState.placements),
      manualOrderOf: id => orgState.placements.find(row => row.sessionId === id)?.manualOrder,
      archivedIds: workspacesSnap.archivedSessionIds,
      ...(sceneSessions === undefined
        ? {}
        : { ordinalOf: (id: string) => sceneSessions.find(ref => ref.sessionId === id)?.ordinal ?? 0 }),
    })
  }

  /**
   * `sessionId`'s effective parent, as the SHARED projection resolves it
   * within `sessionId`'s own scene — so an archived (or cross-scene) parent
   * reads as "root", matching what the carousel actually shows.
   */
  const parentOf = (sessionId: string): string | undefined =>
    nodesOf(locationOf(sessionId)?.sceneId).find(node => node.sessionId === sessionId)?.parentId

  /**
   * The layer `sceneId` is ACTUALLY showing — the same resolution AppFrame
   * renders from (码头 `SessionCanvas.tsx:43-46`): an explicit layer when the
   * store holds one (`null` meaning the root layer), otherwise derived from
   * the current session's own parent. Anything that acts on "the layer the
   * user is looking at" has to ask this, not the raw store: after a reload
   * the store is empty while the carousel is showing a drilled layer derived
   * from the restored focus, and `returnToParent` reading the raw store there
   * would make the breadcrumb's own button a no-op.
   * @param sceneId - the scene to resolve.
   * @returns the layer's parent session id, or undefined for the root layer.
   */
  const effectiveLevelOf = (sceneId: string): string | undefined => {
    const explicit = deps.level.getSnapshot().parentBySceneId[sceneId]
    if (explicit !== undefined) return explicit ?? undefined
    const current = deps.sessions.list.getSnapshot().current
    if (current === undefined) return undefined
    return nodesOf(sceneId).find(node => node.sessionId === current)?.parentId
  }

  /** `sessionId`'s full descendant subtree (carousel-visible only — no subagents, see Ruling-4), depth-first. */
  const descendantsOf = (nodes: readonly CarouselNode[], sessionId: string): string[] =>
    childrenOfLevel(nodes, sessionId).flatMap(child => [child.sessionId, ...descendantsOf(nodes, child.sessionId)])

  /**
   * Ops that re-attach `children` to `newParentId` — 码头's own promise when
   * only one node is removed (`RemoveNodeDialog.tsx:31-35`: 「后代会话将重连到
   * 当前节点的父级」/「直接后代会话将成为根节点」). `undefined` becomes an
   * explicit `null`, which is `placement/set`'s "clear the parent" (omitting
   * the key would instead PRESERVE the soon-to-be-archived parent — the exact
   * bug this exists to prevent). Each child's own scene is addressed (and
   * materialized first when still virtual) rather than the removed card's, so
   * a child that somehow sits elsewhere is not silently moved.
   * @param view - the derived workbench view, for scene resolution.
   * @param children - the direct children to re-attach.
   * @param newParentId - the removed card's own effective parent, or undefined at the root layer.
   * @returns the ops to apply, empty when there is nothing to re-attach.
   */
  const reparentOps = (
    view: ReturnType<typeof currentView>['view'],
    children: readonly CarouselNode[],
    newParentId: string | undefined,
  ): MatouOrgOp[] => {
    const ops: MatouOrgOp[] = []
    const emittedTasks = new Set<string>()
    const emittedScenes = new Set<string>()
    for (const child of children) {
      const scene = sceneRefOf(view, child.sessionId)
      // No scene lists this child (a dangling DSH-side parent link with no
      // placement row anywhere): there is no addressable row to rewrite, and
      // inventing one would place a session the organization never adopted.
      if (scene === undefined) continue
      for (const op of materializeSceneOps(scene)) {
        if (op.kind === 'task/create') {
          if (emittedTasks.has(op.id)) continue
          emittedTasks.add(op.id)
        } else if (op.kind === 'scene/create') {
          if (emittedScenes.has(op.id)) continue
          emittedScenes.add(op.id)
        }
        ops.push(op)
      }
      ops.push({
        kind: 'placement/set',
        sessionId: child.sessionId,
        taskId: scene.taskId,
        sceneId: scene.sceneId,
        parentSessionId: newParentId ?? null,
      })
    }
    return ops
  }

  /**
   * The first ACTIVE child among `children` by `CHILD_STATE_PRIORITY`
   * (等待输入 > 运行中 > 已完成 > 空闲), falling back to the first child in
   * `children`'s own (MRU) order when every child is idle.
   */
  const pickActiveChild = (children: readonly CarouselNode[]): CarouselNode | undefined => {
    if (children.length === 0) return undefined
    const { sessionsSnap } = currentView()
    const pending = deps.pendingInteractions.getSnapshot()
    let best = children[0]
    let bestRank = -1
    for (const child of children) {
      const summary = sessionsSnap.byId[child.sessionId as SessionId]
      const state = summary === undefined
        ? undefined
        : sessionDotState({ running: summary.running, completed: summary.completed, pending: pending.has(child.sessionId) })
      const rank = state === undefined ? -1 : CHILD_STATE_PRIORITY.indexOf(state)
      if (rank > bestRank) { bestRank = rank; best = child }
    }
    return best
  }

  /** Fork `stateSourceId`'s conversation, name it, place it under `newParentId`, land it in `locationAnchorId`'s scene. */
  const performFork = async (opts: {
    stateSourceId: string
    newParentId: string | undefined
    locationAnchorId: string
    name: string
    drillInto: boolean
    atSeq?: number
  }): Promise<void> => {
    // `sceneRefOf`, not `locationOf`: the anchor may still live in a VIRTUAL
    // default task/scene, and `placement/set`'s reducer rejects outright when
    // the scene row does not exist yet (`org/ops.ts:207-208`). Every other
    // write path already prepends `materializeSceneOps` (`newSession`,
    // `removeCard`); this one used to be the sole omission — which made
    // "创建子分支" fail on the single commonest path there is (a session DSH's
    // own entry point created, still sitting in the unmaterialized default),
    // and fail DIRTILY: the fork and the rename had already happened, so a
    // real session was left stranded with no placement row.
    const scene = sceneRefOf(currentView().view, opts.locationAnchorId)
    if (scene === undefined) throw new Error('matou-layout: could not resolve the fork target\'s task/scene')
    const childId = await deps.sessions.fork({ sessionId: opts.stateSourceId as SessionId, ...(opts.atSeq === undefined ? {} : { atSeq: opts.atSeq }) })
    const face = deps.sessions.binding(childId)?.session
    if (face !== undefined) {
      const renamed = await face.rename(opts.name)
      if (!renamed.ok) throw renamed.error
    }
    await apply([
      ...materializeSceneOps(scene),
      {
        kind: 'placement/set',
        sessionId: childId,
        taskId: scene.taskId,
        sceneId: scene.sceneId,
        parentSessionId: opts.newParentId ?? null,
        // 种类由已有的两个字段推出，不另开参数（S3c Task 4）：新会话复制的
        // 正是它父亲的状态 → forked-from（创建子分支、兄弟分支）；只是结构
        // 上挂在那儿、状态另有来源 → derived-from（⑂ Fork 会话）。根层的
        // 平级 Fork 没有父边，也就没有边可标。
        ...(opts.newParentId === undefined
          ? {}
          : { relationKind: opts.newParentId === opts.stateSourceId ? 'forked-from' as const : 'derived-from' as const }),
      },
    ])
    // Explicit: the user asked for this layer (`null` = the root layer).
    if (opts.drillInto) deps.level.actions.setLevel(scene.sceneId, opts.newParentId ?? null)
    deps.nav.actions.navigate({
      workspaceId: scene.workspaceId, taskId: scene.taskId, sceneId: scene.sceneId, sessionId: childId,
    })
    deps.sessions.open(childId)
  }

  return {
    async addWorkspace() {
      const picking = deps.pickDirectory()
      if (picking === undefined) {
        throw new Error('matou-layout: the directory picker is unavailable (ui-workspace is not loaded)')
      }
      const path = await picking
      if (path === null) return
      const workspace = await deps.workspaces.create({ path })
      // 同一条不变量：刚添加的工作区也不该是一张空画布。默认事项/页签本来是
      // 「写入时才物化」的虚行，这里把它们连同第一张卡一次写实。
      const taskId = defaultTaskId(workspace.workspaceId)
      const sceneId = defaultSceneId(taskId)
      const sessionId = await deps.sessions.create({ workspaceId: workspace.workspaceId })
      await apply([
        { kind: 'task/create', id: taskId, workspaceId: workspace.workspaceId, title: DEFAULT_GROUP_TITLE },
        { kind: 'scene/create', id: sceneId, taskId, name: DEFAULT_GROUP_TITLE },
        { kind: 'placement/set', sessionId, taskId, sceneId },
      ])
      deps.nav.actions.navigate({
        workspaceId: workspace.workspaceId, taskId, sceneId, sessionId,
      })
      deps.sessions.open(sessionId)
    },
    /**
     * 码头的不变量：**不存在「有事项/页签但没有会话卡」的状态**。
     *
     * `hierarchy-application-service.ts` 的 `#createTaskHierarchy` 在**同一个事务**里
     * 一次性插入 执行上下文 → 事项 → 画布 → 根节点 → 会话 → 会话挂载；`createScene`
     * 同样带一条 `INSERT INTO sessions`；连删掉最后一个事项时它都会立刻补建一个默认
     * 事项（`:915-925`）。也就是说空画布在码头里根本到不了。
     *
     * 本插件此前只写 `task/create` / `scene/create`，于是新建出来的事项是一张写着
     * 「当前画布没有活跃会话」的空页——用户 2026-09-14 报的就是这个。
     *
     * 会话先建、再**一次 apply** 把三条 op 一起写下去：中间不出现空状态，也不会多
     * 推进一次 revision（落位文档的版本号是所有写入者共享的，见 `org/model.ts` 的
     * `sameOrgState`）。
     */
    async createTask(workspaceId, title) {
      const id = newId()
      const sceneId = defaultSceneId(id)
      const sessionId = await deps.sessions.create({ workspaceId: workspaceId as WorkspaceId })
      await apply([
        { kind: 'task/create', id, workspaceId, title },
        { kind: 'scene/create', id: sceneId, taskId: id, name: DEFAULT_GROUP_TITLE },
        { kind: 'placement/set', sessionId, taskId: id, sceneId },
      ])
      deps.nav.actions.navigate({ workspaceId, taskId: id, sceneId, sessionId })
      deps.sessions.open(sessionId)
      return id
    },
    async renameTask(task, title) {
      await apply(task.virtual
        ? [{ kind: 'task/create', id: task.taskId, workspaceId: task.workspaceId, title }]
        : [{ kind: 'task/update', id: task.taskId, patch: { title } }])
    },
    async setTaskPinned(task, pinned) {
      await apply([
        ...materializeTaskOps(task),
        { kind: 'task/update', id: task.taskId, patch: { isPinned: pinned } },
      ])
    },
    async deleteTask(task) {
      const { view, sessionsSnap } = currentView()
      const workspace = view.find(item => item.workspaceId === task.workspaceId)
      const target = workspace?.tasks.find(item => item.id === task.taskId)
      if (target === undefined) return
      const ids = [...new Set(target.scenes.flatMap(scene => scene.sessions.map(ref => ref.sessionId)))]
      // Keep active work intact; DSH archival does not terminate an agent run.
      if (ids.some(id => sessionsSnap.byId[id as SessionId]?.running)) {
        throw new Error('事项内仍有会话运行中，请先停止运行，再删除事项。')
      }
      // Materialize the fallback row so a partial failure keeps a retry target.
      if (target.virtual) await apply(materializeTaskOps(task))
      // Archive first: failed requests must not drop organization or move survivors
      // into Default. Retrying reads the live snapshot and skips archived sessions.
      for (const id of ids) await deps.workspaces.archiveSession(id as SessionId)
      const nextTask = workspace?.tasks.find(item => item.id !== task.taskId)
      const ops: MatouOrgOp[] = [{ kind: 'task/delete', id: task.taskId }]
      const nextId = nextTask?.id ?? newId()
      let replacement: SessionId | undefined
      const sceneId = defaultSceneId(nextId)
      if (nextTask === undefined) {
        replacement = await deps.sessions.create({ workspaceId: task.workspaceId as WorkspaceId })
        ops.push(
          { kind: 'task/create', id: nextId, workspaceId: task.workspaceId, title: '默认' },
          { kind: 'scene/create', id: sceneId, taskId: nextId, name: '默认' },
          { kind: 'placement/set', sessionId: replacement, taskId: nextId, sceneId },
        )
      }
      try {
        await apply(ops)
      } catch (error) {
        // A replacement that failed to attach must not surface in another task.
        if (replacement !== undefined) await deps.workspaces.archiveSession(replacement)
        throw error
      }
      if (sessionsSnap.current !== undefined && ids.includes(sessionsSnap.current)) deps.sessions.clear()
      if (replacement !== undefined) {
        deps.nav.actions.navigate({ workspaceId: task.workspaceId, taskId: nextId, sceneId, sessionId: replacement })
        deps.sessions.open(replacement)
      } else {
        deps.nav.actions.navigate({ workspaceId: task.workspaceId, taskId: nextId })
      }
    },
    /** 同 `createTask`：新页签一并带一张会话卡，不留空画布（码头 `createScene:1080`）。 */
    async createScene(task, name) {
      const id = newId()
      const sessionId = await deps.sessions.create({ workspaceId: task.workspaceId as WorkspaceId })
      await apply([
        ...materializeTaskOps(task),
        { kind: 'scene/create', id, taskId: task.taskId, name },
        { kind: 'placement/set', sessionId, taskId: task.taskId, sceneId: id },
      ])
      deps.nav.actions.navigate({
        workspaceId: task.workspaceId, taskId: task.taskId, sceneId: id, sessionId,
      })
      deps.sessions.open(sessionId)
      return id
    },
    async renameScene(scene, name) {
      await apply([
        ...materializeTaskOps(scene),
        ...(scene.sceneVirtual
          ? [{ kind: 'scene/create' as const, id: scene.sceneId, taskId: scene.taskId, name, titlePinned: true }]
          : [{ kind: 'scene/update' as const, id: scene.sceneId, patch: { name, titlePinned: true } }]),
      ])
    },
    async deleteScene(scene) {
      if (scene.sceneVirtual) return
      await apply([{ kind: 'scene/delete', id: scene.sceneId }])
    },
    async reorderCards(ids) {
      if (ids.length < 2 || new Set(ids).size !== ids.length) return
      const { view } = currentView()
      const scene = sceneRefOf(view, ids[0]!)
      if (scene === undefined) throw new Error('会话已变更，请重试')
      const nodes = nodesOf(scene.sceneId)
      const parent = nodes.find(node => node.sessionId === ids[0])?.parentId
      const siblings = childrenOfLevel(nodes, parent)
      if (siblings.length !== ids.length || ids.some(id => !siblings.some(node => node.sessionId === id))) {
        throw new Error('会话列表已变更，请重新拖动')
      }
      await apply([
        ...materializeSceneOps(scene),
        ...ids.map((id): MatouOrgOp => ({ kind: 'placement/set', sessionId: id, taskId: scene.taskId,
          sceneId: scene.sceneId, parentSessionId: parent ?? null })),
        ...ids.map((id, order): MatouOrgOp => ({ kind: 'placement/order', sessionId: id, order })),
      ])
    },
    async newSessionNextTo(anchorId) {
      const { view, orgState } = currentView()
      const scene = sceneRefOf(view, anchorId)
      if (scene === undefined) throw new Error('matou-layout: session is no longer available')
      const refs = view.flatMap(ws => ws.tasks).flatMap(task => task.scenes)
        .find(item => item.id === scene.sceneId)!.sessions
      const nodes = nodesOf(scene.sceneId)
      const anchor = nodes.find(node => node.sessionId === anchorId)
      if (anchor === undefined) throw new Error('matou-layout: session is no longer available')
      const sessionId = await deps.sessions.create({ workspaceId: scene.workspaceId as WorkspaceId })
      // Materialize fallback rows in their existing order before using a placement anchor.
      // Keep DSH conversations intact; this writes only the plugin's card arrangement.
      const ops: MatouOrgOp[] = [...materializeSceneOps(scene)]
      for (const ref of refs) {
        ops.push({ kind: 'placement/set', sessionId: ref.sessionId, taskId: scene.taskId, sceneId: scene.sceneId })
      }
      const next = refs[refs.findIndex(ref => ref.sessionId === anchorId) + 1]
      ops.push({
        kind: 'placement/set', sessionId, taskId: scene.taskId, sceneId: scene.sceneId,
        beforeSessionId: next?.sessionId ?? null,
        parentSessionId: anchor.parentId ?? null,
        ...(anchor.parentId === undefined ? {} : { relationKind: 'derived-from' as const }),
      })
      const siblings = childrenOfLevel(nodes, anchor.parentId)
      if (siblings.some(node => node.manualOrder !== undefined)) {
        const order = siblings.map(node => node.sessionId)
        order.splice(order.indexOf(anchorId) + 1, 0, sessionId)
        ops.push(...order.map((id, index): MatouOrgOp => ({ kind: 'placement/order', sessionId: id, order: index })))
      }
      // Equal interaction keys make the placement order the tie-breaker: directly right,
      // not at the beginning/end of the recently-used layer. Later prompts retain MRU rules.
      const interactionAt = Math.max(orgState.placements.find(row => row.sessionId === anchorId)?.interactionAt
        ?? 0, anchor.lastInteractionAt)
      ops.push({ kind: 'placement/interaction', sessionId: anchorId, at: interactionAt })
      ops.push({ kind: 'placement/interaction', sessionId, at: interactionAt })
      await apply(ops)
      deps.level.actions.setLevel(scene.sceneId, anchor.parentId ?? null)
      deps.nav.actions.navigate({ workspaceId: scene.workspaceId, taskId: scene.taskId, sceneId: scene.sceneId, sessionId })
      deps.sessions.open(sessionId)
    },
    async newSession(scene, parentSessionId) {
      const sessionId = await deps.sessions.create({ workspaceId: scene.workspaceId as WorkspaceId })
      await apply([
        ...materializeSceneOps(scene),
        {
          kind: 'placement/set', sessionId, taskId: scene.taskId, sceneId: scene.sceneId,
          // 全新会话没有复制任何人的状态，所以它与父的边是纯结构关联
          // （S3c Task 4）。根层新建则没有父边，也就没有边可标。
          ...(parentSessionId === undefined
            ? {}
            : { parentSessionId, relationKind: 'derived-from' as const }),
        },
      ])
      deps.nav.actions.navigate({
        workspaceId: scene.workspaceId,
        taskId: scene.taskId,
        sceneId: scene.sceneId,
        sessionId,
      })
      deps.sessions.open(sessionId)
    },
    openSession(sessionId) {
      deps.sessions.open(sessionId as SessionId)
    },
    clearSession() {
      deps.sessions.clear()
    },
    pinSession(sessionId) {
      deps.sessions.pin(sessionId as SessionId)
    },
    unpinSession(sessionId) {
      deps.sessions.unpin(sessionId as SessionId)
    },
    async renameSession(sessionId, title) {
      const face = deps.sessions.binding(sessionId as SessionId)?.session
      if (face === undefined) throw new Error('matou-layout: session is not available for renaming')
      const result = await face.rename(title)
      if (!result.ok) throw result.error
    },
    async archiveSession(sessionId) {
      await deps.workspaces.archiveSession(sessionId as SessionId)
    },
    navigate(target) {
      deps.nav.actions.navigate(target)
    },
    revealSession(sessionId) {
      const location = locationOf(sessionId)
      // The single "target is gone" answer (Ruling-S5-8): `locationOf` runs
      // over the org-derived view, whose session set has already dropped
      // archived and subagent rows (`known-sessions.ts`) and whose workspaces
      // are DSH's live ones — so a vanished workspace, an archived session and
      // an id that was never placed all arrive here as the same `undefined`.
      if (location === undefined) return false
      // 码头 `HierarchyShell.tsx:1042-1046`: the revealed session's layer is
      // its own parent's. Read through the SHARED projection `drillTo` and
      // `removeCard` use (Ruling-20, see `nodesOf`), so the layer this lands
      // on is the one those two would agree the card lives in — and written
      // EXPLICITLY (`null` = the root layer), never left unset, for the same
      // reason `returnToParent` does: unset hands the layer back to focus
      // derivation, which is not what an explicit navigation means.
      // `parentOf` (not an inline `nodesOf(...).find(...)`): it is the SAME
      // expression `drillTo` and `removeCard` resolve parents with, and its
      // doc carries the answer to the question this call raises — an archived
      // or cross-scene parent reads as "root", so the layer this lands on is
      // always one the carousel actually renders.
      deps.level.actions.setLevel(location.sceneId, parentOf(sessionId) ?? null)
      deps.nav.actions.navigate({ ...location, sessionId })
      deps.sessions.open(sessionId as SessionId)
      // S4 Task 8 (裁定 T-5), LAST and only on the success path: the three
      // writes above are all no-ops when the target is ALREADY the current
      // session in the current layer of the current tab — which is exactly
      // what the DAG's "click the node you are looking at" (spec §7.3 step 6)
      // and the notification center's "click the row for the current session"
      // both do. `useCarouselController`'s centering effect keys on
      // `focusedSessionId` and returns early when it did not change, so
      // without this bump the screen does not move at all. The counter IS the
      // observable change; see `carousel/reveal-store.ts` and 码头's identical
      // `sequence` at `HierarchyShell.tsx:1047-1054`.
      //
      // Deliberately NOT written on the failure branch above: a reveal that
      // could not place its target must leave the carousel exactly where the
      // user left it (Ruling-S5-8 — one failure, no partial navigation).
      deps.reveal.actions.request(location.sceneId, sessionId)
      return true
    },
    drillTo(sessionId) {
      const location = locationOf(sessionId)
      if (location === undefined) return
      deps.level.actions.setLevel(location.sceneId, sessionId)
      const active = pickActiveChild(childrenOfLevel(nodesOf(location.sceneId), sessionId))
      if (active !== undefined) deps.sessions.open(active.sessionId as SessionId)
    },
    returnToParent(sceneId) {
      // The layer the user can actually see, which after a reload is derived
      // rather than stored — see `effectiveLevelOf`.
      const currentParentId = effectiveLevelOf(sceneId)
      if (currentParentId === undefined) return
      // Popping is an explicit navigation, so the new layer is explicit too:
      // `null` for the root, never "unset" (which would hand the layer back
      // to focus derivation and undo the pop on the very next render).
      deps.level.actions.setLevel(
        sceneId, nodesOf(sceneId).find(node => node.sessionId === currentParentId)?.parentId ?? null,
      )
      deps.sessions.open(currentParentId as SessionId)
    },
    async forkChild(sessionId, name, atSeq) {
      await performFork({
        stateSourceId: sessionId, newParentId: sessionId, locationAnchorId: sessionId, name, drillInto: true, ...(atSeq === undefined ? {} : { atSeq }),
      })
    },
    async forkSibling(sessionId, name) {
      const parentId = parentOf(sessionId)
      if (parentId === undefined) throw new Error('matou-layout: session has no effective parent to fork a sibling from')
      await performFork({
        stateSourceId: parentId, newParentId: parentId, locationAnchorId: parentId, name, drillInto: false,
      })
    },
    async forkPeer(sessionId, name) {
      const parentId = parentOf(sessionId)
      await performFork({
        stateSourceId: sessionId, newParentId: parentId, locationAnchorId: parentId ?? sessionId, name, drillInto: false,
      })
    },
    async commitInteractions(commits) {
      await apply(commits.map(commit => ({
        kind: 'placement/interaction' as const, sessionId: commit.sessionId, at: commit.at,
      })))
    },
    async removeCard(sessionId, cascade) {
      const { view } = currentView()
      const location = locateSession(view, sessionId)
      // Scene-scoped (M8): the descendant walk that feeds both the archive
      // list AND the empty-tab guard must stay inside the tab being counted.
      const nodes = nodesOf(location?.sceneId)
      const targets = cascade ? [sessionId, ...descendantsOf(nodes, sessionId)] : [sessionId]
      if (location !== undefined) {
        const scene = view
          .flatMap(workspace => workspace.tasks)
          .flatMap(task => task.scenes)
          .find(candidate => candidate.id === location.sceneId)
        const sceneSessionCount = scene?.sessions.length ?? targets.length
        if (targets.length >= sceneSessionCount) {
          throw new Error('matou-layout: removing this would leave the tab with no sessions; keep at least one')
        }
      }
      // "仅本卡" must re-attach the direct children first, or they keep
      // pointing at a session that is about to be archived out of every
      // projection — leaving them with no card, no badge to drill through,
      // and no persisted level to reload into (see `reparentOps`' doc). On a
      // cascade the whole subtree is leaving, so there is nothing to re-attach.
      if (!cascade) {
        const removed = nodes.find(node => node.sessionId === sessionId)
        await apply(reparentOps(view, childrenOfLevel(nodes, sessionId), removed?.parentId))
      }
      for (const id of targets) await deps.workspaces.archiveSession(id as SessionId)
    },
    openDag() {
      deps.dag.actions.setOpen(true)
    },
    closeDag() {
      deps.dag.actions.setOpen(false)
    },
  }
}
