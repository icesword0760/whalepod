/**
 * Pure predicates over an `AgentNotificationSnapshot`'s `notifications`
 * array — the same rules `store.ts`'s `sessionHasUnread`/`unreadForTask`
 * closures apply internally, restated as free functions so a surface that
 * only ever receives the read-only `useNotifications` selector hook (never
 * the store instance itself — the `hooks` compartment is rebound away from
 * imperative methods, see `workbench/face.ts`'s module doc) can still ask the
 * exact same "does this session/task have unread?" questions the store
 * answers for itself.
 *
 * S5 Task 5's four-level lighting (spec §5's 点亮层级 row) consumes these:
 * - Card ring + "新通知" pill (`AppFrame.tsx`'s `cards` projection):
 *   `sessionHasUnread` for that card's own session.
 * - Scene tab dot (`SceneTabBar.tsx`): **not** `store.ts`'s own
 *   `unreadForScene` — per Ruling (码头 `SceneTabBar.tsx:121-125`), a scene
 *   lights up when ANY session currently MOUNTED under it (the org-derived
 *   placement set — `MatouSceneView.sessions` — not a notification's own
 *   recorded `sceneId`) has unread. The caller runs `sessionHasUnread` once
 *   per mounted session id itself; this module has no scene-shaped helper on
 *   purpose, so that substitution stays visible at the call site instead of
 *   hiding behind a same-named wrapper.
 * - Task row badge (`TaskSidebar.tsx`): `unreadForTask`, capped to "99+" by
 *   the caller (this module reports the true, uncapped count).
 * - Workspace row: deliberately NOT lit — spec §5's Ruling matches 码头
 *   source, which never marks the workspace row itself. No selector for it
 *   exists here on purpose; do not add one.
 * @module dsh-plugin-matou-layout/src/client/notifications/selectors
 */
import type { AgentNotification } from './store.ts'

/** Whether a session carries at least one unread notification record. */
export function sessionHasUnread(notifications: readonly AgentNotification[], sessionId: string): boolean {
  return notifications.some(notification => !notification.read && notification.sessionId === sessionId)
}

/** Unread notification count recorded against a task (uncapped — callers apply the display's 99+ cap). */
export function unreadForTask(notifications: readonly AgentNotification[], taskId: string): number {
  let count = 0
  for (const notification of notifications) {
    if (!notification.read && notification.taskId === taskId) count += 1
  }
  return count
}
