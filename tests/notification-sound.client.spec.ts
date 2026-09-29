// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSoundEnabled, persistSoundEnabled, playNotificationSound, SOUND_STORAGE_KEY } from '../src/client/notifications/sound.ts'

beforeEach(() => { localStorage.clear() })

describe('SOUND_STORAGE_KEY', () => {
  it('is this plugin’s own key, not 码头’s kc-notification-sound-enabled', () => {
    expect(SOUND_STORAGE_KEY).toBe('matou.notification.sound')
    expect(SOUND_STORAGE_KEY).not.toBe('kc-notification-sound-enabled')
  })
})

describe('loadSoundEnabled', () => {
  it('defaults to enabled when nothing has ever been stored', () => {
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBeNull()
    expect(loadSoundEnabled()).toBe(true)
  })

  it('reads disabled only from the exact literal string "false"', () => {
    localStorage.setItem(SOUND_STORAGE_KEY, 'false')
    expect(loadSoundEnabled()).toBe(false)

    localStorage.setItem(SOUND_STORAGE_KEY, 'true')
    expect(loadSoundEnabled()).toBe(true)

    // Anything else stored (including garbage from an older/foreign write) still reads enabled.
    localStorage.setItem(SOUND_STORAGE_KEY, 'nonsense')
    expect(loadSoundEnabled()).toBe(true)
  })

  it('swallows a read failure (e.g. private browsing) and falls back to the enabled default', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(loadSoundEnabled()).toBe(true)
    getItem.mockRestore()
  })
})

describe('persistSoundEnabled', () => {
  it('writes the literal strings "true"/"false", round-tripping through loadSoundEnabled', () => {
    persistSoundEnabled(false)
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe('false')
    expect(loadSoundEnabled()).toBe(false)

    persistSoundEnabled(true)
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe('true')
    expect(loadSoundEnabled()).toBe(true)
  })

  it('swallows a write failure (e.g. quota exceeded) without throwing', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    expect(() => persistSoundEnabled(false)).not.toThrow()
    setItem.mockRestore()
  })
})

interface StubOscillator {
  type: string
  connect: ReturnType<typeof vi.fn>
  frequency: { setValueAtTime: ReturnType<typeof vi.fn> }
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

interface StubGain {
  connect: ReturnType<typeof vi.fn>
  gain: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> }
}

function stubAudioContext(currentTime: number) {
  const oscillator: StubOscillator = {
    type: '',
    connect: vi.fn(),
    frequency: { setValueAtTime: vi.fn() },
    start: vi.fn(),
    stop: vi.fn(),
  }
  const gain: StubGain = {
    connect: vi.fn(),
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
  }
  const destination = {}
  const context = {
    currentTime,
    destination,
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
  }
  return { context, oscillator, gain, destination }
}

describe('playNotificationSound', () => {
  it('builds the exact two-tone chime: sine wave, 880Hz then 1047Hz at +0.1s, 0.3 gain decaying to 0.001 by +0.3s', () => {
    const { context, oscillator, gain, destination } = stubAudioContext(10)

    playNotificationSound(() => context)

    expect(context.createOscillator).toHaveBeenCalledTimes(1)
    expect(context.createGain).toHaveBeenCalledTimes(1)
    expect(oscillator.type).toBe('sine')
    expect(oscillator.connect).toHaveBeenCalledWith(gain)
    expect(gain.connect).toHaveBeenCalledWith(destination)
    expect(oscillator.frequency.setValueAtTime).toHaveBeenNthCalledWith(1, 880, 10)
    expect(oscillator.frequency.setValueAtTime).toHaveBeenNthCalledWith(2, 1047, 10.1)
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 10)
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, 10.3)
    expect(oscillator.start).toHaveBeenCalledWith(10)
    expect(oscillator.stop).toHaveBeenCalledWith(10.3)
  })

  it('wires the graph oscillator -> gain -> destination, in that order', () => {
    const { context, oscillator, gain } = stubAudioContext(0)
    const order: string[] = []
    oscillator.connect.mockImplementation(() => order.push('oscillator->gain'))
    gain.connect.mockImplementation(() => order.push('gain->destination'))

    playNotificationSound(() => context)

    expect(order).toEqual(['oscillator->gain', 'gain->destination'])
  })

  it('swallows a context-factory failure instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => playNotificationSound(() => { throw new Error('no audio hardware') })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('degrades silently with no injected factory when the environment has no WebAudio support (jsdom default)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => playNotificationSound()).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
