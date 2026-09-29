/**
 * Notification chime plus its persisted on/off preference, ported from
 * 码头's `notification-sound.ts` (and the persistence half of its
 * `browser-notification-store.ts`).
 *
 * The storage key is this plugin's OWN (`matou.notification.sound`) —
 * deliberately not 码头's `kc-notification-sound-enabled`. The two apps
 * must never share a browser storage namespace.
 *
 * Every localStorage read/write and every WebAudio call is wrapped in
 * try/catch: private browsing, a disabled/exhausted storage quota, and a
 * browser with no WebAudio support must all degrade silently rather than
 * throw at the caller.
 * @module dsh-plugin-matou-layout/src/client/notifications/sound
 */

/** This plugin's own persistence key for the sound on/off preference. */
export const SOUND_STORAGE_KEY = 'matou.notification.sound'

/**
 * Read the persisted sound preference. Defaults to enabled: a key that was
 * never written (`null`) or holds anything other than the literal string
 * `'false'` reads as enabled. Any thrown error (storage unavailable) falls
 * back to the same default.
 */
export function loadSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SOUND_STORAGE_KEY)
    return stored === null ? true : stored !== 'false'
  } catch {
    return true
  }
}

/** Persist the sound preference as the literal string `'true'`/`'false'`. */
export function persistSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Swallowed: private-browsing storage or quota exhaustion must not break
    // the caller over a persistence nicety — the in-memory preference still
    // works for the rest of the session.
  }
}

/**
 * The minimal WebAudio surface `playNotificationSound` needs, factored out
 * so a test can inject a stub instead of a real `AudioContext` (jsdom has
 * none).
 */
interface NotificationAudioContext {
  state?: string
  resume?: () => Promise<void>
  currentTime: number
  destination: unknown
  createOscillator(): {
    type: string
    connect(destination: unknown): void
    frequency: { setValueAtTime(value: number, time: number): void }
    start(time: number): void
    stop(time: number): void
  }
  createGain(): {
    connect(destination: unknown): void
    gain: {
      setValueAtTime(value: number, time: number): void
      exponentialRampToValueAtTime(value: number, time: number): void
    }
  }
}

let audioContext: NotificationAudioContext | undefined

/**
 * Play the two-tone notification chime: a sine oscillator sweeping from
 * 880Hz to 1047Hz 0.1s in, under a gain envelope that starts at 0.3 and
 * decays exponentially to near-silence (0.001) over 0.3s total.
 * @param contextFactory - injection point for tests; defaults to the lazily
 *   constructed singleton `AudioContext` (falling back to
 *   `webkitAudioContext` on browsers that still need it).
 */
export function playNotificationSound(
  contextFactory: () => NotificationAudioContext = browserAudioContext,
): void {
  try {
    const context = contextFactory()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, context.currentTime)
    oscillator.frequency.setValueAtTime(1047, context.currentTime + 0.1)
    gain.gain.setValueAtTime(0.3, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.3)
    oscillator.start(context.currentTime)
    oscillator.stop(context.currentTime + 0.3)
  } catch (error) {
    console.warn('[notifications/sound] failed to play notification sound:', error)
  }
}

function browserAudioContext(): NotificationAudioContext {
  if (audioContext) return audioContext
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) throw new Error('WebAudio is unavailable')
  audioContext = new AudioContextClass() as unknown as NotificationAudioContext
  return audioContext
}

/** Unlock WebAudio on a real gesture so later background notifications can sound. */
export function unlockNotificationSound(): void {
  if (!loadSoundEnabled()) return
  try {
    const context = browserAudioContext()
    if (context.state === 'suspended') void context.resume?.().catch(() => {})
  } catch { /* Bell and unread markers remain usable without audio support. */ }
}
