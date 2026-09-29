/** Address helpers: turn derived view rows into the write face's refs. */
import type { MatouSceneView, MatouTaskView } from '../org/derive.ts'
import type { SceneRef, TaskRef } from './actions.ts'

export function taskRefOf(task: MatouTaskView): TaskRef {
  return { workspaceId: task.workspaceId, taskId: task.id, virtual: task.virtual, title: task.title }
}

export function sceneRefOf(task: MatouTaskView, scene: MatouSceneView): SceneRef {
  return { ...taskRefOf(task), sceneId: scene.id, sceneVirtual: scene.virtual, name: scene.name }
}
