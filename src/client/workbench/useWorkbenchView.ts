/**
 * The derived workbench view and the stable actions object, shared by every
 * surface that renders it (the stage frame and the sidebar seat). Both are
 * pure projections of framework props; no surface owns the state.
 */
import { useMemo } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { LevelState } from '../carousel/level-store.ts'
import type { NavMemory } from '../nav/navigation.ts'
import { resolveActive } from '../nav/navigation.ts'
import type { ActiveSelection } from '../nav/navigation.ts'
import { deriveOrgView } from '../org/derive.ts'
import type { MatouWorkspaceOrgView } from '../org/derive.ts'
import type { OrgMirrorState } from '../org/store.ts'
import type { WorkbenchActions } from './actions.ts'
import { selectKnownSessionIds } from './known-sessions.ts'

export interface WorkbenchViewHooks {
  readonly useSessions: SnapshotSelectorHook<SessionListState>
  readonly useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  readonly useOrg: SnapshotSelectorHook<OrgMirrorState>
  readonly useNav: SnapshotSelectorHook<NavMemory>
  readonly useLevel: SnapshotSelectorHook<LevelState>
}

export interface WorkbenchView {
  readonly sessions: SessionListState
  readonly org: OrgMirrorState
  readonly view: readonly MatouWorkspaceOrgView[]
  readonly active: ActiveSelection
  readonly level: LevelState
  /**
   * DSH's archived session ids, surfaced (not just consumed internally by
   * `selectKnownSessionIds`) because the shared node projection
   * (`carousel/nodes.ts`) needs the same exclusion set every other surface
   * uses — see Ruling-20.
   */
  readonly archivedSessionIds: readonly string[]
}

export function useWorkbenchView(hooks: WorkbenchViewHooks): WorkbenchView {
  const sessions = hooks.useSessions(s => s)
  const workspaces = hooks.useWorkspaces(s => s.items)
  const archivedSessionIds = hooks.useWorkspaces(s => s.archivedSessionIds)
  const org = hooks.useOrg(s => s)
  const nav = hooks.useNav(s => s)
  const level = hooks.useLevel(s => s)
  const current = sessions.current
  const knownSessionIds = useMemo(() => selectKnownSessionIds({
    ids: sessions.ids,
    summaryOf: id => sessions.byId[id as never],
    archivedIds: archivedSessionIds,
    currentId: current,
    org: org.org,
  }), [sessions.ids, sessions.byId, archivedSessionIds, current, org.org])
  const view = useMemo(
    () => deriveOrgView({ workspaces, knownSessionIds, org: org.org }),
    [workspaces, knownSessionIds, org.org],
  )
  const active = useMemo(() => resolveActive(view, nav), [view, nav])
  return { sessions, org, view, active, level, archivedSessionIds }
}

/** The inject face's functions are created once; memo over them keeps identity stable. */
export function useWorkbenchActions(props: WorkbenchActions): WorkbenchActions {
  const {
    addWorkspace, createTask, renameTask, setTaskPinned, deleteTask, createScene, renameScene, deleteScene,
    reorderCards, newSessionNextTo, newSession, openSession, clearSession, pinSession, unpinSession, renameSession, archiveSession, navigate,
    revealSession, drillTo, returnToParent, forkChild, forkSibling, forkPeer, removeCard, commitInteractions, openDag, closeDag,
  } = props
  return useMemo<WorkbenchActions>(() => ({
    addWorkspace, createTask, renameTask, setTaskPinned, deleteTask, createScene, renameScene, deleteScene,
    reorderCards, newSessionNextTo, newSession, openSession, clearSession, pinSession, unpinSession, renameSession, archiveSession, navigate,
    revealSession, drillTo, returnToParent, forkChild, forkSibling, forkPeer, removeCard, commitInteractions, openDag, closeDag,
  }), [addWorkspace, createTask, renameTask, setTaskPinned, deleteTask, createScene, renameScene, deleteScene,
    reorderCards, newSessionNextTo, newSession, openSession, clearSession, pinSession, unpinSession, renameSession, archiveSession, navigate,
    revealSession, drillTo, returnToParent, forkChild, forkSibling, forkPeer, removeCard, commitInteractions, openDag, closeDag])
}
