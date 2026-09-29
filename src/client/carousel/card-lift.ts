import css from './carousel.module.css'

/** Inert visual snapshot: never mount a second live conversation while dragging. */
export function liftCard(slot: HTMLElement, x: number, y: number) {
  const card = slot.querySelector<HTMLElement>('article')
  if (!card) return undefined
  const rect = card.getBoundingClientRect()
  const overlay = document.createElement('div')
  overlay.className = css.floatingGhost!
  overlay.dataset.floatingCard = slot.dataset.sessionId ?? ''
  overlay.setAttribute('aria-hidden', 'true')
  overlay.setAttribute('inert', '')
  Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top - 8}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  const snapshot = card.cloneNode(true) as HTMLElement
  snapshot.removeAttribute('id')
  snapshot.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
  snapshot.querySelectorAll<HTMLElement>('*').forEach(element => {
    if (element.tabIndex >= 0) element.tabIndex = -1
  })
  snapshot.style.transformOrigin = `${x - rect.left}px ${y - rect.top}px`
  overlay.append(snapshot)
  document.body.append(overlay)
  if (typeof snapshot.animate === 'function' && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    snapshot.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.025)' }], { duration: 140, easing: 'ease-out' })
  }
  const position = { x: rect.left, y: rect.top - 8 }
  return {
    move(px: number, py: number) {
      position.x = rect.left + px - x; position.y = rect.top + py - y - 8
      overlay.style.left = `${position.x}px`; overlay.style.top = `${position.y}px`
    },
    remove() { overlay.remove() },
    async land(target: HTMLElement | null) {
      const destination = target?.querySelector('article')?.getBoundingClientRect()
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      if (destination && typeof overlay.animate === 'function' && !reduced) {
        const motion = overlay.animate([
          { transform: 'translate(0, 0)' },
          { transform: `translate(${destination.left - position.x}px, ${destination.top - position.y}px)` },
        ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' })
        snapshot.style.transform = 'scale(1)'
        try { await motion.finished } catch { /* Unmount/cancel may interrupt the landing. */ }
      }
      overlay.remove()
    },
  }
}
