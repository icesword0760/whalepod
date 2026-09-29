import { useEffect, useState } from 'react'
import { unlockNotificationSound } from './sound.ts'

/** A selected card is being watched only while its window is foreground. */
export function useWindowAttention(): boolean {
  const [active, setActive] = useState(() => document.visibilityState !== 'hidden' && document.hasFocus())
  useEffect(() => {
    const focus = () => setActive(document.visibilityState !== 'hidden' && document.hasFocus())
    const blur = () => setActive(false)
    const unlock = () => unlockNotificationSound()
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', focus)
    document.addEventListener('pointerdown', unlock, { passive: true })
    document.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', focus)
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('keydown', unlock)
    }
  }, [])
  return active
}
