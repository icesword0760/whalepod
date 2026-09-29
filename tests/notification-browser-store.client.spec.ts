// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { createBrowserNotificationStore } from '../src/client/notifications/browser-store.ts'
import { SOUND_STORAGE_KEY } from '../src/client/notifications/sound.ts'

beforeEach(() => { localStorage.clear() })

it('wires the real persistence implementation: setSoundEnabled writes this plugin’s own storage key', () => {
  const store = createBrowserNotificationStore({ now: () => 1_000 })

  store.setSoundEnabled(false)

  expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe('false')
})

it('loads a previously persisted sound preference into a fresh store instance', () => {
  localStorage.setItem(SOUND_STORAGE_KEY, 'false')

  const store = createBrowserNotificationStore({ now: () => 1_000 })

  expect(store.snapshot().soundEnabled).toBe(false)
})

it('degrades silently when playing a sound in an environment with no WebAudio support (jsdom)', () => {
  const store = createBrowserNotificationStore({ now: () => 1_000 })

  expect(() => store.push({ eventId: 'event-1', eventType: 'completed', title: 'Claude Code' })).not.toThrow()
})
