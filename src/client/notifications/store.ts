/**
 * In-memory notification history: cooldown-gated pushes, replacement-key
 * upserts, per-session single-unread semantics, and workspace-bounded
 * retention pruning. Ported field-for-field from 码头's
 * `AgentNotificationStore.ts`, minus the team-role fields 码头 carries for
 * its own team feature — this plugin has no use for them.
 *
 * `push()`'s step order is load-bearing (a reordering changes which branch
 * wins), so every step below is numbered to match the source's own shape:
 *
 * 1. Read `now`.
 * 2. Prune first (retention + per-workspace cap), remembering whether that
 *    pruning changed anything.
 * 3. Normalize `replacementKey` and look for an existing record under it.
 * 4. A hit is an UPSERT: every field is overwritten in place (same `id`,
 *    moved to the front), it BYPASSES the cooldown check entirely and
 *    BYPASSES the per-session read flip, and returns the SAME object.
 * 5. A miss computes the cooldown key from the input's owner chain
 *    (session → scene → task → workspace → `'global'`).
 * 6. The cooldown check is `push`'s only `null`-returning path: if it fires,
 *    the step-2 prune is still reported to listeners (state may have
 *    visibly changed) even though nothing new was recorded.
 * 7. Record the cooldown timestamp.
 * 8. Per-session single-unread: any other unread record for the same
 *    session flips to read (this is what makes "at most one unread per
 *    session" true — 码头's own card-summary contract).
 * 9. Build the normalized record and put it at index 0 (newest first).
 * 10. Track the cooldown key's reference count, maybe play a sound, prune
 *     again, notify, and return the new record.
 *
 * Deliberately NOT persisted: a refresh empties the history (spec §5). The
 * only thing that survives a refresh is the sound on/off preference, carried
 * through the `loadSoundEnabled`/`persistSoundEnabled` injection points —
 * their defaults here are pure no-ops (`() => {}` / always `true`), on
 * purpose: this factory must NEVER touch a real `AudioContext` or
 * `localStorage` on its own, exactly like 码头's own `AgentNotificationStore`
 * class never does. A caller that wants working sound + persistence uses
 * `./browser-store.ts`'s `createBrowserNotificationStore`, which is the thin
 * composition layer that wires `./sound.ts`'s real implementation in — the
 * same two-layer split 码头 keeps between its class and
 * `browser-notification-store.ts`.
 *
 * Zero React/DOM dependency by design: the only places this file touches the
 * outside world are the constructor's injection points (`now`, `playSound`,
 * `loadSoundEnabled`, `persistSoundEnabled`, and the three numeric limits),
 * and none of their defaults ever resolve to a real browser API.
 * @module dsh-plugin-matou-layout/src/client/notifications/store
 */

/** 码头 lets any string flow through as a custom event category. */
export type AgentNotificationEventType = 'completed' | 'permission' | 'error' | 'waiting' | 'attention' | string

/** What a producer hands to `push()`. Every field but the first three is optional. */
export interface AgentNotificationInput {
  eventId: string
  eventType: AgentNotificationEventType
  title: string
  subtitle?: string
  body?: string
  workspaceId?: string | null
  taskId?: string | null
  sceneId?: string | null
  sessionId?: string | null
  sound?: boolean
  cooldownKey?: string
  replacementKey?: string
  isFocusedSession?: boolean
}

/**
 * A stored, fully normalized notification. No optional fields: absent
 * subtitle/body become `''`, absent hierarchy ids become `null`. `replacementKey`
 * is kept here (so a later push can find it again); `cooldownKey` is NOT —
 * it only ever lives in the store's private cooldown map.
 */
export interface AgentNotification {
  id: string
  eventId: string
  eventType: AgentNotificationEventType
  title: string
  subtitle: string
  body: string
  workspaceId: string | null
  taskId: string | null
  sceneId: string | null
  sessionId: string | null
  timestamp: number
  read: boolean
  sound: boolean
  replacementKey: string
}

/** The read-model a subscriber renders from. Reference-stable across a no-op `snapshot()`. */
export interface AgentNotificationSnapshot {
  notifications: readonly AgentNotification[]
  unreadCount: number
  soundEnabled: boolean
}

/** Injection points and limits; every field defaults to 码头's own defaults. */
export interface AgentNotificationStoreOptions {
  now?: () => number
  playSound?: () => void
  loadSoundEnabled?: () => boolean
  persistSoundEnabled?: (enabled: boolean) => void
  cooldownMs?: number
  maxPerWorkspace?: number
  readRetentionMs?: number
}

/** The store's public surface — everything a UI layer needs, and nothing else. */
export interface AgentNotificationStore {
  push(input: AgentNotificationInput): AgentNotification | null
  snapshot(): AgentNotificationSnapshot
  subscribe(listener: () => void): () => void
  unreadForWorkspace(workspaceId: string): number
  unreadForTask(taskId: string): number
  unreadForScene(sceneId: string): number
  sessionHasUnread(sessionId: string): boolean
  sessionHasVisibleIndicator(sessionId: string): boolean
  dismissSessionIndicator(sessionId: string): void
  markWorkspaceRead(workspaceId: string): void
  markSessionRead(sessionId: string): void
  markAllRead(): void
  remove(id: string): void
  removeByReplacementKey(replacementKey: string): void
  clear(): void
  setSoundEnabled(enabled: boolean): void
}

const DEFAULT_COOLDOWN_MS = 5_000
const DEFAULT_MAX_PER_WORKSPACE = 1_000
const DEFAULT_READ_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const UNASSIGNED_WORKSPACE_BUCKET = '__unassigned__'

/** Create one notification store instance. See the module doc for `push()`'s exact step order. */
export function createNotificationStore(options: AgentNotificationStoreOptions = {}): AgentNotificationStore {
  const now = options.now ?? Date.now
  const playSound = options.playSound ?? (() => {})
  const persistSoundEnabledFn = options.persistSoundEnabled ?? (() => {})
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const maxPerWorkspace = Math.max(0, Math.floor(options.maxPerWorkspace ?? DEFAULT_MAX_PER_WORKSPACE))
  const readRetentionMs = Math.max(0, options.readRetentionMs ?? DEFAULT_READ_RETENTION_MS)

  const listeners = new Set<() => void>()
  const cooldowns = new Map<string, number>()
  const cooldownKeysByNotificationId = new Map<string, string>()
  const cooldownKeyRefCounts = new Map<string, number>()
  const notifications: AgentNotification[] = []
  let soundEnabled = options.loadSoundEnabled?.() ?? true
  let sequence = 0
  let snapshotValue = buildSnapshot()

  function buildSnapshot(): AgentNotificationSnapshot {
    return {
      notifications,
      unreadCount: notifications.filter((notification) => !notification.read).length,
      soundEnabled,
    }
  }

  function emit(): void {
    snapshotValue = buildSnapshot()
    for (const listener of listeners) listener()
  }

  function cooldownKeyFor(input: AgentNotificationInput): string {
    const owner = input.sessionId ?? input.sceneId ?? input.taskId ?? input.workspaceId ?? 'global'
    return `${owner}:${input.cooldownKey ?? input.eventType}`
  }

  function trackCooldown(notificationId: string, cooldownKey: string): void {
    cooldownKeysByNotificationId.set(notificationId, cooldownKey)
    cooldownKeyRefCounts.set(cooldownKey, (cooldownKeyRefCounts.get(cooldownKey) ?? 0) + 1)
  }

  function removeAt(index: number): void {
    const [removed] = notifications.splice(index, 1)
    if (!removed) return
    const cooldownKey = cooldownKeysByNotificationId.get(removed.id)
    if (!cooldownKey) return
    cooldownKeysByNotificationId.delete(removed.id)
    const remaining = (cooldownKeyRefCounts.get(cooldownKey) ?? 1) - 1
    if (remaining > 0) {
      cooldownKeyRefCounts.set(cooldownKey, remaining)
      return
    }
    cooldownKeyRefCounts.delete(cooldownKey)
    cooldowns.delete(cooldownKey)
  }

  /** Retention + per-workspace-cap pruning. Returns whether anything was removed. */
  function prune(nowValue: number): boolean {
    const removeIds = new Set<string>()
    const buckets = new Map<string, AgentNotification[]>()
    for (const notification of notifications) {
      if (notification.read && nowValue - notification.timestamp > readRetentionMs) {
        removeIds.add(notification.id)
        continue
      }
      const bucket = notification.workspaceId ?? UNASSIGNED_WORKSPACE_BUCKET
      const bucketNotifications = buckets.get(bucket)
      if (bucketNotifications) bucketNotifications.push(notification)
      else buckets.set(bucket, [notification])
    }
    for (const bucketNotifications of buckets.values()) {
      const overflow = bucketNotifications.length - maxPerWorkspace
      if (overflow <= 0) continue
      bucketNotifications.sort(compareOldestNotification)
      for (let index = 0; index < overflow; index += 1) {
        removeIds.add(bucketNotifications[index]!.id)
      }
    }
    if (removeIds.size === 0) return false
    for (let index = notifications.length - 1; index >= 0; index -= 1) {
      if (removeIds.has(notifications[index]!.id)) removeAt(index)
    }
    return true
  }

  function markRead(predicate: (notification: AgentNotification) => boolean): void {
    let changed = prune(now())
    for (const notification of notifications) {
      if (!notification.read && predicate(notification)) {
        notification.read = true
        changed = true
      }
    }
    if (changed) emit()
  }

  function countUnread(predicate: (notification: AgentNotification) => boolean): number {
    return notifications.filter((notification) => !notification.read && predicate(notification)).length
  }

  /** `sessionHasVisibleIndicator` is the same rule under 码头's second name for it. */
  function sessionHasUnread(sessionId: string): boolean {
    return notifications.some((notification) => !notification.read && notification.sessionId === sessionId)
  }

  function push(input: AgentNotificationInput): AgentNotification | null {
    const nowValue = now()
    const prunedBeforePush = prune(nowValue)
    const replacementKey = input.replacementKey?.trim() ?? ''
    const replacementIndex = replacementKey
      ? notifications.findIndex((notification) => notification.replacementKey === replacementKey)
      : -1

    if (replacementIndex >= 0) {
      const current = notifications[replacementIndex]!
      const sessionId = input.sessionId ?? null
      Object.assign(current, {
        eventId: input.eventId,
        eventType: input.eventType,
        title: input.title,
        subtitle: input.subtitle ?? '',
        body: input.body ?? '',
        workspaceId: input.workspaceId ?? null,
        taskId: input.taskId ?? null,
        sceneId: input.sceneId ?? null,
        sessionId,
        timestamp: nowValue,
        read: input.isFocusedSession === true,
        sound: input.sound !== false,
        replacementKey,
      })
      notifications.splice(replacementIndex, 1)
      notifications.unshift(current)
      if (!input.isFocusedSession && current.sound && soundEnabled) playSound()
      prune(nowValue)
      emit()
      return current
    }

    const cooldownKey = cooldownKeyFor(input)
    const lastTime = cooldowns.get(cooldownKey)
    if (lastTime !== undefined && nowValue - lastTime < cooldownMs) {
      if (prunedBeforePush) emit()
      return null
    }
    cooldowns.set(cooldownKey, nowValue)

    const sessionId = input.sessionId ?? null
    if (sessionId) {
      for (const notification of notifications) {
        if (!notification.read && notification.sessionId === sessionId) notification.read = true
      }
    }

    const notification: AgentNotification = {
      id: `notification-${nowValue}-${++sequence}`,
      eventId: input.eventId,
      eventType: input.eventType,
      title: input.title,
      subtitle: input.subtitle ?? '',
      body: input.body ?? '',
      workspaceId: input.workspaceId ?? null,
      taskId: input.taskId ?? null,
      sceneId: input.sceneId ?? null,
      sessionId,
      timestamp: nowValue,
      read: input.isFocusedSession === true,
      sound: input.sound !== false,
      replacementKey,
    }
    notifications.unshift(notification)
    trackCooldown(notification.id, cooldownKey)
    if (!input.isFocusedSession && notification.sound && soundEnabled) playSound()
    prune(nowValue)
    emit()
    return notification
  }

  return {
    push,

    snapshot(): AgentNotificationSnapshot {
      if (prune(now())) snapshotValue = buildSnapshot()
      return snapshotValue
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    unreadForWorkspace(workspaceId: string): number {
      return countUnread((notification) => notification.workspaceId === workspaceId)
    },

    unreadForTask(taskId: string): number {
      return countUnread((notification) => notification.taskId === taskId)
    },

    unreadForScene(sceneId: string): number {
      return countUnread((notification) => notification.sceneId === sceneId)
    },

    sessionHasUnread: sessionHasUnread,

    sessionHasVisibleIndicator: sessionHasUnread,

    dismissSessionIndicator(sessionId: string): void {
      const before = notifications.length
      for (let index = notifications.length - 1; index >= 0; index -= 1) {
        if (notifications[index]?.sessionId === sessionId) removeAt(index)
      }
      if (notifications.length !== before) emit()
    },

    markWorkspaceRead(workspaceId: string): void {
      markRead((notification) => notification.workspaceId === workspaceId)
    },

    markSessionRead(sessionId: string): void {
      markRead((notification) => notification.sessionId === sessionId)
    },

    markAllRead(): void {
      markRead(() => true)
    },

    remove(id: string): void {
      const index = notifications.findIndex((notification) => notification.id === id)
      if (index < 0) return
      removeAt(index)
      emit()
    },

    removeByReplacementKey(replacementKey: string): void {
      const normalized = replacementKey.trim()
      if (!normalized) return
      const index = notifications.findIndex((notification) => notification.replacementKey === normalized)
      if (index < 0) return
      removeAt(index)
      emit()
    },

    clear(): void {
      if (notifications.length === 0) return
      notifications.splice(0)
      cooldowns.clear()
      cooldownKeysByNotificationId.clear()
      cooldownKeyRefCounts.clear()
      emit()
    },

    setSoundEnabled(enabled: boolean): void {
      if (soundEnabled === enabled) return
      soundEnabled = enabled
      persistSoundEnabledFn(enabled)
      emit()
    },
  }
}

function compareOldestNotification(left: AgentNotification, right: AgentNotification): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
  const sequenceDifference = notificationSequence(left.id) - notificationSequence(right.id)
  if (sequenceDifference !== 0) return sequenceDifference
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function notificationSequence(id: string): number {
  const suffix = id.slice(id.lastIndexOf('-') + 1)
  const sequence = Number(suffix)
  return Number.isFinite(sequence) ? sequence : 0
}
