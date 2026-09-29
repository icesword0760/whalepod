// Ported from 码头's AgentNotificationStore.test.ts (18+ cases, same wording where the
// behaviour it names is copied verbatim) — see the plan brief for the full cross-reference.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SOUND_STORAGE_KEY } from '../src/client/notifications/sound.ts'
import {
  createNotificationStore,
  type AgentNotificationInput,
  type AgentNotificationStore,
  type AgentNotificationStoreOptions,
} from '../src/client/notifications/store.ts'

// This file's global test environment is jsdom (vitest.config.ts sets it project-wide, not
// per file), so `localStorage` here is a real, writable Storage shared across every `it` in
// this file. Belt-and-suspenders alongside `createNotificationStore`'s own safe-by-default
// contract (verified below): a case that forgets to inject the sound options must not leak
// state into whichever case runs after it.
beforeEach(() => { localStorage.clear() })

// Every store in this file gets safe no-op sound injections by default, so behaviour here
// never depends on whichever real implementation `store.ts` defaults its own options to.
function createStore(overrides: AgentNotificationStoreOptions = {}): AgentNotificationStore {
  return createNotificationStore({
    playSound: () => {},
    loadSoundEnabled: () => true,
    persistSoundEnabled: () => {},
    ...overrides,
  })
}

function event(overrides: Partial<AgentNotificationInput> = {}): AgentNotificationInput {
  return {
    eventId: 'event', eventType: 'completed', title: 'Claude Code', subtitle: 'Completed', body: 'Task completed',
    workspaceId: 'workspace', taskId: 'task', sceneId: 'scene', sessionId: 'session', sound: true,
    ...overrides,
  }
}

describe('createNotificationStore safe-by-default contract', () => {
  // Locks the fix for the two-layer split: a bare `createNotificationStore()` must never
  // reach a real browser API on its own — that is `./browser-store.ts`'s job. If a future
  // change re-wires `./sound.ts`'s real implementation back in as this factory's own
  // default, this is the test that turns red.
  it('never touches localStorage when constructed and used with no options at all', () => {
    const store = createNotificationStore()
    store.push(event({ eventId: 'event-1' }))
    store.setSoundEnabled(false)

    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBeNull()
  })
})

describe('createNotificationStore', () => {
  it('keeps only the latest 1000 notifications per workspace without affecting other buckets', () => {
    let now = 1_000
    const store = createStore({ now: () => now, cooldownMs: 0 })

    for (let index = 0; index < 1_005; index += 1) {
      now += 1
      store.push(event({ eventId: `workspace-a-${index}`, workspaceId: 'workspace-a', sessionId: `workspace-a-session-${index}` }))
    }
    for (let index = 0; index < 3; index += 1) {
      now += 1
      store.push(event({ eventId: `workspace-b-${index}`, workspaceId: 'workspace-b', sessionId: `workspace-b-session-${index}` }))
    }
    for (let index = 0; index < 1_005; index += 1) {
      now += 1
      store.push(event({ eventId: `unassigned-${index}`, workspaceId: null, sessionId: `unassigned-session-${index}` }))
    }

    const notifications = store.snapshot().notifications
    const workspaceA = notifications.filter(({ workspaceId }) => workspaceId === 'workspace-a')
    const workspaceB = notifications.filter(({ workspaceId }) => workspaceId === 'workspace-b')
    const unassigned = notifications.filter(({ workspaceId }) => workspaceId === null)
    expect(workspaceA).toHaveLength(1_000)
    expect(workspaceA.map(({ eventId }) => eventId)).not.toContain('workspace-a-4')
    expect(workspaceA.map(({ eventId }) => eventId)).toContain('workspace-a-5')
    expect(workspaceA.map(({ eventId }) => eventId)).toContain('workspace-a-1004')
    expect(workspaceB).toHaveLength(3)
    expect(unassigned).toHaveLength(1_000)
    expect(unassigned.map(({ eventId }) => eventId)).not.toContain('unassigned-4')
  })

  it('evicts deterministically by timestamp, then id sequence, then id string', () => {
    const store = createStore({ now: () => 1_000, cooldownMs: 0, maxPerWorkspace: 2 })

    store.push(event({ eventId: 'first', sessionId: 'session-first' }))
    store.push(event({ eventId: 'second', sessionId: 'session-second' }))
    store.push(event({ eventId: 'third', sessionId: 'session-third' }))

    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).toEqual(['third', 'second'])
  })

  it('retains old unread notifications but prunes read notifications after 30 days', () => {
    const retention = 30 * 24 * 60 * 60 * 1_000
    let now = 1_000
    const store = createStore({ now: () => now, cooldownMs: 0 })
    store.push(event({ eventId: 'old-unread', sessionId: 'old-session' }))

    now += retention + 1
    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).toEqual(['old-unread'])

    store.markAllRead()
    expect(store.snapshot().notifications).toHaveLength(0)
  })

  it('keeps a read notification through the exact retention boundary, drops it one ms later', () => {
    const retention = 30 * 24 * 60 * 60 * 1_000
    let now = 1_000
    const store = createStore({ now: () => now, readRetentionMs: retention })
    store.push(event({ eventId: 'focused', sessionId: 'focused-session', isFocusedSession: true }))

    now += retention
    expect(store.snapshot().notifications).toHaveLength(1)
    now += 1
    expect(store.snapshot().notifications).toHaveLength(0)
  })

  it('prunes expired read history on push while preserving equally old unread history', () => {
    const retention = 30 * 24 * 60 * 60 * 1_000
    let now = 1_000
    const store = createStore({ now: () => now, cooldownMs: 0 })
    store.push(event({ eventId: 'old-read', workspaceId: 'workspace-read', sessionId: 'session-read', isFocusedSession: true }))
    store.push(event({ eventId: 'old-unread', workspaceId: 'workspace-unread', sessionId: 'session-unread' }))

    now += retention + 1
    store.push(event({ eventId: 'current', workspaceId: 'workspace-current', sessionId: 'session-current' }))

    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).toEqual(['current', 'old-unread'])
  })

  it('updates a replacement notification in place without consuming another workspace slot', () => {
    let now = 1_000
    const store = createStore({ now: () => now, cooldownMs: 0, maxPerWorkspace: 1 })
    const initial = store.push(event({ eventId: 'restore-started', sessionId: 'restore-session', replacementKey: 'restore:session' }))!

    now += 1
    const updated = store.push(event({
      eventId: 'restore-failed', eventType: 'error', sessionId: 'restore-session', replacementKey: 'restore:session',
    }))!

    expect(updated.id).toBe(initial.id)
    expect(store.snapshot().notifications).toHaveLength(1)
    expect(store.snapshot().notifications[0]?.eventId).toBe('restore-failed')
  })

  it('replacement-key upsert bypasses the cooldown check entirely', () => {
    const store = createStore({ now: () => 1_000 })
    const first = store.push(event({ eventId: 'a', replacementKey: 'shared' }))!
    // A second push sharing the same replacementKey and cooldown owner/category would be
    // cooled down as a fresh push, but the upsert branch must never even consult cooldowns.
    const second = store.push(event({ eventId: 'b', replacementKey: 'shared' }))!

    expect(second.id).toBe(first.id)
    expect(second.eventId).toBe('b')
  })

  it('releases a cooldown key reference count when its last notification is evicted or removed', () => {
    let now = 1_000
    const store = createStore({ now: () => now, maxPerWorkspace: 1 })
    const evicted = store.push(event({ eventId: 'evicted', sessionId: 'session-evicted', cooldownKey: 'capacity-key' }))!
    store.push(event({ eventId: 'replacement-slot', sessionId: 'session-other' }))
    expect(store.snapshot().notifications.map(({ id }) => id)).not.toContain(evicted.id)

    now += 1
    const afterEviction = store.push(event({ eventId: 'after-eviction', sessionId: 'session-evicted', cooldownKey: 'capacity-key' }))
    expect(afterEviction).not.toBeNull()

    store.remove(afterEviction!.id)
    now += 1
    expect(store.push(event({ eventId: 'after-removal', sessionId: 'session-evicted', cooldownKey: 'capacity-key' }))).not.toBeNull()
  })

  it('keeps several full workspace buckets bounded independently', () => {
    let now = 1_000
    const store = createStore({ now: () => now, cooldownMs: 0, maxPerWorkspace: 200 })
    for (let workspaceIndex = 0; workspaceIndex < 5; workspaceIndex += 1) {
      for (let notificationIndex = 0; notificationIndex < 200; notificationIndex += 1) {
        now += 1
        store.push(event({
          eventId: `event-${workspaceIndex}-${notificationIndex}`,
          workspaceId: `workspace-${workspaceIndex}`,
          sessionId: `session-${workspaceIndex}-${notificationIndex}`,
        }))
      }
    }

    now += 1
    store.push(event({ eventId: 'workspace-0-overflow', workspaceId: 'workspace-0', sessionId: 'workspace-0-overflow' }))

    expect(store.snapshot().notifications).toHaveLength(1_000)
    for (let workspaceIndex = 0; workspaceIndex < 5; workspaceIndex += 1) {
      expect(store.snapshot().notifications.filter(({ workspaceId }) => workspaceId === `workspace-${workspaceIndex}`))
        .toHaveLength(200)
    }
    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).not.toContain('event-0-0')
    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).toContain('workspace-0-overflow')
  })

  it('keeps the latest event as the only unread notification for one session', () => {
    let now = 1_000
    const store = createStore({ now: () => now })

    const first = store.push(event({ eventId: 'event-1', eventType: 'completed' }))
    now = 7_000
    const second = store.push(event({ eventId: 'event-2', eventType: 'permission' }))

    expect(first?.read).toBe(true)
    expect(second?.read).toBe(false)
    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).toEqual(['event-2', 'event-1'])
    expect(store.snapshot().unreadCount).toBe(1)
  })

  it('updates one recovery notification in place instead of stacking retry states', () => {
    let now = 1_000
    const store = createStore({ now: () => now })

    const failed = store.push(event({
      eventId: 'restore-failed', eventType: 'error', title: 'Restore failed', replacementKey: 'provider-restore:session',
    }))!
    now = 1_100
    const retrying = store.push(event({
      eventId: 'restore-retrying', eventType: 'attention', title: 'Restoring', replacementKey: 'provider-restore:session', sound: false,
    }))!

    expect(retrying.id).toBe(failed.id)
    expect(store.snapshot().notifications).toHaveLength(1)
    expect(store.snapshot().notifications[0]).toMatchObject({
      eventId: 'restore-retrying', title: 'Restoring', replacementKey: 'provider-restore:session',
    })

    store.removeByReplacementKey('provider-restore:session')
    expect(store.snapshot().notifications).toHaveLength(0)
  })

  it('drops a repeated event category for the same session during the five-second cooldown', () => {
    let now = 1_000
    const store = createStore({ now: () => now })

    expect(store.push(event({ eventId: 'event-1', eventType: 'waiting' }))).not.toBeNull()
    now = 5_999
    expect(store.push(event({ eventId: 'event-2', eventType: 'waiting' }))).toBeNull()
    now = 6_000
    expect(store.push(event({ eventId: 'event-3', eventType: 'waiting' }))).not.toBeNull()
  })

  it('limits cooldown independently by session and by event category', () => {
    const store = createStore({ now: () => 1_000 })

    expect(store.push(event({ eventId: 'a', eventType: 'error', sessionId: 'session-a' }))).not.toBeNull()
    expect(store.push(event({ eventId: 'b', eventType: 'permission', sessionId: 'session-a' }))).not.toBeNull()
    expect(store.push(event({ eventId: 'c', eventType: 'error', sessionId: 'session-b' }))).not.toBeNull()
  })

  it('cools down every push sharing one explicit cooldownKey as a single category', () => {
    let now = 1_000
    const store = createStore({ now: () => now })
    expect(store.push(event({ eventId: 'permission', eventType: 'permission', cooldownKey: 'shared' }))).not.toBeNull()
    now += 1_000
    expect(store.push(event({ eventId: 'error', eventType: 'error', cooldownKey: 'shared' }))).toBeNull()
    expect(store.snapshot().notifications.map(({ eventId }) => eventId)).toEqual(['permission'])
  })

  it('keeps a focused-session event read without creating an unread indicator or sound', () => {
    const playSound = vi.fn()
    const store = createStore({ now: () => 1_000, playSound })

    const notification = store.push(event({ eventId: 'focused', isFocusedSession: true }))

    expect(notification?.read).toBe(true)
    expect(store.snapshot().unreadCount).toBe(0)
    expect(store.sessionHasVisibleIndicator('session')).toBe(false)
    expect(playSound).not.toHaveBeenCalled()
  })

  it('keeps one unread count aligned with exactly one notified session', () => {
    const store = createStore({ now: () => 1_000 })
    store.push(event({ eventId: 'focused', sessionId: 'session-a', isFocusedSession: true }))
    store.push(event({ eventId: 'unread', sessionId: 'session-b', isFocusedSession: false }))

    expect(store.snapshot().unreadCount).toBe(1)
    expect(store.sessionHasVisibleIndicator('session-a')).toBe(false)
    expect(store.sessionHasVisibleIndicator('session-b')).toBe(true)
  })

  it('dismissSessionIndicator removes the whole session history, it does not mark it read', () => {
    let now = 1_000
    const store = createStore({ now: () => now })
    store.push(event({ eventId: 'first', eventType: 'completed' }))
    now += 6_000
    store.push(event({ eventId: 'second', eventType: 'permission' }))

    store.dismissSessionIndicator('session')

    expect(store.snapshot().notifications).toHaveLength(0)
    expect(store.sessionHasVisibleIndicator('session')).toBe(false)
  })

  it('marks only its own workspace read when the user switches to it', () => {
    const store = createStore({ now: () => 1_000 })
    store.push(event({ eventId: 'target', workspaceId: 'workspace-a', sessionId: 'session-a' }))
    store.push(event({ eventId: 'other', workspaceId: 'workspace-b', sessionId: 'session-b' }))

    store.markWorkspaceRead('workspace-a')

    expect(store.unreadForWorkspace('workspace-a')).toBe(0)
    expect(store.unreadForWorkspace('workspace-b')).toBe(1)
  })

  it('aggregates unread state through workspace, task, scene, and session', () => {
    const store = createStore({ now: () => 1_000 })
    store.push(event({ eventId: 'event-a', workspaceId: 'workspace-a', taskId: 'task-a', sceneId: 'scene-a', sessionId: 'session-a' }))
    store.push(event({ eventId: 'event-b', workspaceId: 'workspace-a', taskId: 'task-b', sceneId: 'scene-b', sessionId: 'session-b' }))

    expect(store.unreadForWorkspace('workspace-a')).toBe(2)
    expect(store.unreadForTask('task-a')).toBe(1)
    expect(store.unreadForScene('scene-b')).toBe(1)
    expect(store.sessionHasUnread('session-a')).toBe(true)

    store.markSessionRead('session-a')
    expect(store.unreadForWorkspace('workspace-a')).toBe(1)
    expect(store.unreadForTask('task-a')).toBe(0)
    expect(store.sessionHasUnread('session-a')).toBe(false)
  })

  it('retains an event with a fully missing hierarchy so it can still be inspected and removed', () => {
    const store = createStore({ now: () => 1_000 })
    const notification = store.push({ eventId: 'damaged-event', eventType: 'attention', title: 'Claude Code', body: 'needs attention' })

    expect(notification).toMatchObject({ workspaceId: null, taskId: null, sceneId: null, sessionId: null })
    expect(store.snapshot().notifications).toHaveLength(1)
    store.remove(notification!.id)
    expect(store.snapshot().notifications).toHaveLength(0)
  })

  it('keeps notification history session-scoped while remembering the sound preference', () => {
    let persisted: boolean | undefined
    const first = createNotificationStore({
      now: () => 1_000,
      playSound: () => {},
      loadSoundEnabled: () => persisted ?? true,
      persistSoundEnabled: (enabled) => { persisted = enabled },
    })
    first.push(event({ eventId: 'event-1' }))
    first.setSoundEnabled(false)

    const nextAppSession = createNotificationStore({
      now: () => 2_000,
      playSound: () => {},
      loadSoundEnabled: () => persisted ?? true,
      persistSoundEnabled: (enabled) => { persisted = enabled },
    })
    expect(nextAppSession.snapshot().notifications).toHaveLength(0)
    expect(nextAppSession.snapshot().soundEnabled).toBe(false)
  })

  it('plays a sound only when the event and the global preference both allow it', () => {
    let now = 1_000
    const playSound = vi.fn()
    const store = createStore({ now: () => now, playSound })

    store.push(event({ eventId: 'audible', eventType: 'completed' }))
    now += 6_000
    store.push(event({ eventId: 'silent-event', eventType: 'completed', sound: false }))
    store.setSoundEnabled(false)
    now += 6_000
    store.push(event({ eventId: 'muted-globally', eventType: 'completed' }))

    expect(playSound).toHaveBeenCalledTimes(1)
  })

  it('keeps an external-store snapshot reference stable until visible state changes', () => {
    const store = createStore({ now: () => 1_000 })
    const before = store.snapshot()
    expect(store.snapshot()).toBe(before)

    store.push(event({ eventId: 'event-1' }))

    expect(store.snapshot()).not.toBe(before)
    expect(store.snapshot()).toBe(store.snapshot())
  })

  it('notifies subscribers exactly once per push, markAllRead, remove, and setSoundEnabled', () => {
    const store = createStore({ now: () => 1_000 })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    const notification = store.push(event({ eventId: 'event-1' }))!
    store.markAllRead()
    store.remove(notification.id)
    store.setSoundEnabled(false)
    unsubscribe()
    store.clear()

    expect(listener).toHaveBeenCalledTimes(4)
  })
})
