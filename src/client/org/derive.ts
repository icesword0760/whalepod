/**
 * Pure derivation of the four-level workbench view: DSH workspaces and
 * sessions joined with the plugin's organization document. Virtual "默认"
 * tasks and scenes catch everything the document does not place, dirty
 * references are dropped quietly, and every visible row carries a stable
 * 1-based ordinal — the "第 N 个" contract later consumed by cross-session
 * control.
 * @module dsh-plugin-matou-layout/src/client/org/derive
 */

import { defaultSceneId, defaultTaskId } from '../../org/model.ts'
import type { MatouOrgState, MatouTaskStatus } from '../../org/model.ts'

export interface MatouSessionRef {
  readonly sessionId: string
  readonly ordinal: number
}

export interface MatouSceneView {
  readonly id: string
  readonly taskId: string
  readonly name: string
  readonly titlePinned: boolean
  readonly virtual: boolean
  readonly ordinal: number
  readonly sessions: readonly MatouSessionRef[]
}

export interface MatouTaskView {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: MatouTaskStatus
  readonly isPinned: boolean
  readonly virtual: boolean
  readonly ordinal: number
  readonly scenes: readonly MatouSceneView[]
}

export interface MatouWorkspaceOrgView {
  readonly workspaceId: string
  readonly title: string
  readonly ordinal: number
  readonly tasks: readonly MatouTaskView[]
}

export interface DeriveOrgInput {
  readonly workspaces: readonly {
    readonly workspaceId: string
    readonly title: string
    readonly sessionIds: readonly string[]
  }[]
  readonly knownSessionIds: ReadonlySet<string>
  readonly org: MatouOrgState
}

/** The display name of an unmaterialized default task or scene. */
export const DEFAULT_GROUP_TITLE = '默认'

interface SceneDraft {
  id: string
  taskId: string
  name: string
  titlePinned: boolean
  virtual: boolean
  sortKey: number
  sessions: { sessionId: string; sortKey: number }[]
}

/**
 * Derive the workbench view.
 * @param input - DSH workspaces/sessions plus the organization document.
 * @returns one view per workspace, in the given workspace order.
 */
export function deriveOrgView(input: DeriveOrgInput): readonly MatouWorkspaceOrgView[] {
  const sceneById = new Map(input.org.scenes.map(scene => [scene.id, scene]))
  const taskById = new Map(input.org.tasks.map(task => [task.id, task]))

  return input.workspaces.map((workspace, workspaceIndex) => {
    const fallbackTaskId = defaultTaskId(workspace.workspaceId)
    const fallbackSceneId = defaultSceneId(fallbackTaskId)

    // Scene drafts for every stored scene of this workspace's tasks, plus one
    // per-task virtual default scene ready to catch fallbacks.
    const drafts = new Map<string, SceneDraft>()
    const defaultSceneOf = (taskId: string): SceneDraft => {
      const id = defaultSceneId(taskId)
      const stored = sceneById.get(id)
      let draft = drafts.get(id)
      if (draft === undefined) {
        draft = {
          id,
          taskId,
          name: stored?.name ?? DEFAULT_GROUP_TITLE,
          titlePinned: stored?.titlePinned ?? false,
          virtual: stored === undefined,
          sortKey: stored?.sortKey ?? 0,
          sessions: [],
        }
        drafts.set(id, draft)
      }
      return draft
    }
    for (const scene of input.org.scenes) {
      const owner = taskById.get(scene.taskId)
      if (owner === undefined || owner.workspaceId !== workspace.workspaceId) continue
      drafts.set(scene.id, {
        id: scene.id,
        taskId: scene.taskId,
        name: scene.name,
        titlePinned: scene.titlePinned,
        virtual: false,
        sortKey: scene.sortKey,
        sessions: [],
      })
    }

    // Route each known session: an intact placement wins; a dead scene or a
    // missing placement falls back to the owning (or workspace default)
    // task's default scene, in workspace session order.
    const placementBySession = new Map(input.org.placements.map(
      placement => [placement.sessionId, placement],
    ))
    let fallbackCounter = 0
    for (const sessionId of workspace.sessionIds) {
      if (!input.knownSessionIds.has(sessionId)) continue
      const placementRow = placementBySession.get(sessionId)
      fallbackCounter += 1
      const target = placementRow === undefined ? undefined : drafts.get(placementRow.sceneId)
      if (target !== undefined) {
        target.sessions.push({ sessionId, sortKey: placementRow!.sortKey })
        continue
      }
      // No placement, or one whose scene no longer exists: treat as unplaced
      // and route to this workspace's default task/scene in workspace order.
      defaultSceneOf(fallbackTaskId).sessions.push({ sessionId, sortKey: fallbackCounter })
    }

    // Assemble tasks: stored rows of this workspace plus the virtual default
    // when it holds sessions or was materialized. An empty unmaterialized
    // default renders nothing (no empty-state nodes).
    const storedTasks = input.org.tasks.filter(
      task => task.workspaceId === workspace.workspaceId,
    )
    const hasStoredDefault = storedTasks.some(task => task.id === fallbackTaskId)
    const fallbackHasSessions = (drafts.get(fallbackSceneId)?.sessions.length ?? 0) > 0
    const taskDrafts = storedTasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      isPinned: task.isPinned,
      virtual: false,
      sortKey: task.sortKey,
    }))
    if (!hasStoredDefault && fallbackHasSessions) {
      taskDrafts.push({
        id: fallbackTaskId,
        title: DEFAULT_GROUP_TITLE,
        status: 'planned',
        isPinned: false,
        virtual: true,
        sortKey: Number.NEGATIVE_INFINITY,
      })
    }

    const orderedTasks = taskDrafts
      .sort((left, right) => (Number(right.isPinned) - Number(left.isPinned))
        || (left.sortKey - right.sortKey))
      .map((draft, index): MatouTaskView => {
        const scenes = [...drafts.values()]
          .filter(scene => scene.taskId === draft.id)
          .filter(scene => !scene.virtual || scene.sessions.length > 0)
        if (scenes.length === 0 && draft.id !== fallbackTaskId) {
          // A task with no stored scene still shows its (virtual) default
          // canvas so "当前画布没有活跃会话" has somewhere to live.
          scenes.push(defaultSceneOf(draft.id))
        }
        const orderedScenes = scenes
          .sort((left, right) => left.sortKey - right.sortKey)
          .map((scene, sceneIndex): MatouSceneView => ({
            id: scene.id,
            taskId: scene.taskId,
            name: scene.name,
            titlePinned: scene.titlePinned,
            virtual: scene.virtual,
            ordinal: sceneIndex + 1,
            sessions: scene.sessions
              .sort((left, right) => left.sortKey - right.sortKey)
              .map((session, sessionIndex): MatouSessionRef => ({
                sessionId: session.sessionId,
                ordinal: sessionIndex + 1,
              })),
          }))
        return {
          id: draft.id,
          workspaceId: workspace.workspaceId,
          title: draft.title,
          status: draft.status,
          isPinned: draft.isPinned,
          virtual: draft.virtual,
          ordinal: index + 1,
          scenes: orderedScenes,
        }
      })

    return {
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      ordinal: workspaceIndex + 1,
      tasks: orderedTasks,
    }
  })
}
