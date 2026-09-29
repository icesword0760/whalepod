import { useState } from 'react'
import css from './AppFrame.module.css'
interface DesktopChromeBridge { integratedTitlebar?: boolean; showAppMenu?: () => Promise<void> }
export function desktopChromeBridge(): DesktopChromeBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { dshDesktop?: DesktopChromeBridge }).dshDesktop
}
/** Native window controls occupy the left 78px; only empty chrome drags. */
export function DesktopChrome({ width }: { width: number }) {
  const [error, setError] = useState(false)
  const bridge = desktopChromeBridge()
  if (!bridge?.integratedTitlebar) return null
  return <div className={css.desktopChrome} style={{ width: Math.max(112, width) }} data-desktop-chrome>
    <button type="button" aria-label="应用菜单" title={error ? '菜单打开失败，点击重试' : '应用菜单'} onClick={() => {
      setError(false)
      void bridge.showAppMenu?.().catch(() => setError(true))
    }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button>
  </div>
}
