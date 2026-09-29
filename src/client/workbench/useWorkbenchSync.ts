/**
 * Two-way sync between the workbench's navigation memory and DSH's current
 * session. Rule A: a user-driven scene change opens that scene's remembered
 * session (or clears the selection when the scene is empty). Rule B: an
 * external current-session change (the DSH rail's New Session, archiving,
 * a fork) relocates navigation to wherever that session now lives.
 * On mount, B wins: the page follows the session DSH restored.
 */
import { useEffect, useRef } from 'react'
import type { MatouWorkspaceOrgView } from '../org/derive.ts'
import { locateSession } from '../nav/navigation.ts'
import type { ActiveSelection } from '../nav/navigation.ts'
import type { WorkbenchActions } from './actions.ts'

export interface WorkbenchSyncInput {
  readonly view: readonly MatouWorkspaceOrgView[]
  readonly active: ActiveSelection
  readonly currentSessionId: string | undefined
  readonly actions: Pick<WorkbenchActions, 'openSession' | 'clearSession' | 'navigate'>
}

export function useWorkbenchSync({ view, active, currentSessionId, actions }: WorkbenchSyncInput): void {
  const latest = useRef({ view, active, currentSessionId })
  latest.current = { view, active, currentSessionId }
  const lastSceneId = useRef<string | undefined | null>(null)

  // Rule B: follow DSH's current session into its task/scene.
  useEffect(() => {
    const { view: currentView, active: currentActive } = latest.current
    if (currentSessionId === undefined) return
    const location = locateSession(currentView, currentSessionId)
    if (location === undefined) return
    if (location.sceneId !== currentActive.scene?.id || currentActive.sessionId !== currentSessionId) {
      actions.navigate({ ...location, sessionId: currentSessionId })
    }
  }, [currentSessionId, actions])

  // Rule A: a scene change (user navigation) opens what the scene remembers.
  const sceneId = active.scene?.id
  useEffect(() => {
    const firstRun = lastSceneId.current === null
    lastSceneId.current = sceneId
    const { active: currentActive, currentSessionId: current } = latest.current
    // On mount only step in when DSH has nothing selected; otherwise rule B
    // has already pulled navigation to the restored session.
    if (firstRun && current !== undefined) return
    if (sceneId === undefined) return
    const target = currentActive.sessionId
    if (target === current) return
    if (target === undefined) actions.clearSession()
    else actions.openSession(target)
  }, [sceneId, actions])
}
