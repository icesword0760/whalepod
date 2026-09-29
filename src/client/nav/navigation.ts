/**
 * Navigation memory over the four-level view: which workspace is active and,
 * per level, which child was last chosen. Pure functions — the store that
 * persists the memory and the effects that act on it live elsewhere.
 *
 * The linkage rule (spec §2.3-9): switching an upper level brings back that
 * level's remembered lower selections; switching a lower level never touches
 * the levels above it.
 * @module dsh-plugin-matou-layout/src/client/nav/navigation
 */

import type { MatouSceneView, MatouTaskView, MatouWorkspaceOrgView } from '../org/derive.ts'

export interface NavMemory {
  activeWorkspaceId?: string | undefined
  taskByWorkspace: Record<string, string>
  sceneByTask: Record<string, string>
  sessionByScene: Record<string, string>
}

export const EMPTY_NAV: NavMemory = Object.freeze({
  taskByWorkspace: Object.freeze({}),
  sceneByTask: Object.freeze({}),
  sessionByScene: Object.freeze({}),
}) as NavMemory

export interface ActiveSelection {
  workspace?: MatouWorkspaceOrgView
  task?: MatouTaskView
  scene?: MatouSceneView
  sessionId?: string
}

export interface NavTarget {
  workspaceId: string
  taskId?: string
  sceneId?: string
  sessionId?: string
}

/** Pick `remembered` if it is one of `candidates`, else the first candidate. */
function pick<T>(candidates: readonly T[], remembered: string | undefined, idOf: (item: T) => string): T | undefined {
  if (remembered !== undefined) {
    const hit = candidates.find(item => idOf(item) === remembered)
    if (hit !== undefined) return hit
  }
  return candidates[0]
}

/**
 * Resolve the active selection from memory, level by level, with a stale
 * memory entry falling back to that level's first item.
 * @param view - derived workbench view.
 * @param memory - navigation memory.
 * @returns the active selection; levels are undefined when nothing exists.
 */
export function resolveActive(view: readonly MatouWorkspaceOrgView[], memory: NavMemory): ActiveSelection {
  const workspace = pick(view, memory.activeWorkspaceId, item => item.workspaceId)
  if (workspace === undefined) return {}
  const task = pick(workspace.tasks, memory.taskByWorkspace[workspace.workspaceId], item => item.id)
  if (task === undefined) return { workspace }
  const scene = pick(task.scenes, memory.sceneByTask[task.id], item => item.id)
  if (scene === undefined) return { workspace, task }
  const session = pick(scene.sessions, memory.sessionByScene[scene.id], item => item.sessionId)
  return {
    workspace,
    task,
    scene,
    ...(session === undefined ? {} : { sessionId: session.sessionId }),
  }
}

/**
 * Record a navigation target. Only the levels named in `target` are written;
 * an upper-level switch therefore re-surfaces whatever the lower levels
 * remembered last time. Never mutates `memory`.
 * @param memory - previous memory.
 * @param target - the levels the user (or a sync) selected.
 * @returns the next memory.
 */
export function remember(memory: NavMemory, target: NavTarget): NavMemory {
  return {
    activeWorkspaceId: target.workspaceId,
    taskByWorkspace: target.taskId === undefined
      ? memory.taskByWorkspace
      : { ...memory.taskByWorkspace, [target.workspaceId]: target.taskId },
    sceneByTask: target.taskId === undefined || target.sceneId === undefined
      ? memory.sceneByTask
      : { ...memory.sceneByTask, [target.taskId]: target.sceneId },
    sessionByScene: target.sceneId === undefined || target.sessionId === undefined
      ? memory.sessionByScene
      : { ...memory.sessionByScene, [target.sceneId]: target.sessionId },
  }
}

/**
 * Reverse lookup: the workspace/task/scene that currently holds a session.
 * @param view - derived workbench view.
 * @param sessionId - session to locate.
 * @returns the owning levels, or undefined when the session is not shown.
 */
export function locateSession(
  view: readonly MatouWorkspaceOrgView[],
  sessionId: string,
): { workspaceId: string; taskId: string; sceneId: string } | undefined {
  for (const workspace of view) {
    for (const task of workspace.tasks) {
      for (const scene of task.scenes) {
        if (scene.sessions.some(ref => ref.sessionId === sessionId)) {
          return { workspaceId: workspace.workspaceId, taskId: task.id, sceneId: scene.id }
        }
      }
    }
  }
  return undefined
}
