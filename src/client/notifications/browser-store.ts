/**
 * The runtime notification store: `createNotificationStore` (pure logic,
 * always safe-by-default) composed with `./sound.ts`'s real WebAudio +
 * localStorage implementation. Mirrors 码头's own split between
 * `AgentNotificationStore.ts` (the class) and `browser-notification-store.ts`
 * (the composition) — kept as two files here for the same reason 码头 keeps
 * them separate: the pure store must never accidentally reach a real
 * `AudioContext` or `localStorage` on its own (see `./store.ts`'s module
 * doc), so wiring the real implementation in is this file's entire job.
 *
 * Callers that want working sound + a persisted on/off preference use
 * `createBrowserNotificationStore` from here, never the bare
 * `createNotificationStore`.
 * @module dsh-plugin-matou-layout/src/client/notifications/browser-store
 */

import { createNotificationStore } from './store.ts'
import type { AgentNotificationStore, AgentNotificationStoreOptions } from './store.ts'
import { loadSoundEnabled, persistSoundEnabled, playNotificationSound } from './sound.ts'

/** Everything but the three sound-related injection points, which this factory always supplies. */
export type BrowserNotificationStoreOptions = Omit<
  AgentNotificationStoreOptions,
  'playSound' | 'loadSoundEnabled' | 'persistSoundEnabled'
>

/**
 * Create a notification store wired to the real browser sound + persistence
 * implementation. `options` may still override `now`/`cooldownMs`/
 * `maxPerWorkspace`/`readRetentionMs` (tests do); the sound-related points
 * are fixed to `./sound.ts`'s real functions on purpose.
 */
export function createBrowserNotificationStore(
  options: BrowserNotificationStoreOptions = {},
): AgentNotificationStore {
  return createNotificationStore({
    ...options,
    playSound: playNotificationSound,
    loadSoundEnabled,
    persistSoundEnabled,
  })
}
