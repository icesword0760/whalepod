import { liftCard } from './card-lift.ts'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, MouseEvent, KeyboardEvent } from 'react'
import { cardIndexAt, DEFAULT_CARD_WIDTH, moveCard, readCardWidths, saveCardWidths } from './card-layout.ts'

const HEADER = '[data-card-header],[data-slot="conversation.session.header"]'
const CONTROL = 'button:not(:disabled),input,textarea,select,a,[contenteditable="true"],[role="menuitem"]'
interface Gesture {
  kind: 'press' | 'sort' | 'resize'
  id: string
  pointer: number
  x: number
  y: number
  width: number
  element: HTMLElement
  original: string[]
}
/** Header gestures own their pointer, never the chat editor or header buttons. */
export function useCardLayout(ids: readonly string[], scope: string,
  onFocus: (id: string) => void, onReorder?: (ids: readonly string[]) => Promise<void>) {
  const [widths, setWidths] = useState(readCardWidths)
  const widthsRef = useRef(widths); widthsRef.current = widths
  const [draft, setDraft] = useState<string[] | null>(null)
  const draftRef = useRef(draft); draftRef.current = draft
  const [active, setActive] = useState<{ id: string; kind: 'press' | 'resize' | 'sort' | 'settle' } | null>(null)
  const [error, setError] = useState<string>()
  const gesture = useRef<Gesture | null>(null)
  const ghost = useRef<ReturnType<typeof liftCard>>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const frame = useRef<number | undefined>(undefined)
  const pointerX = useRef(0)
  const saving = useRef(false)
  const lastHeaderClick = useRef<{ id: string; at: number } | null>(null)
  const latest = useRef({ ids, onFocus, onReorder }); latest.current = { ids, onFocus, onReorder }
  const width = (id: string) => widthsRef.current[id] ?? DEFAULT_CARD_WIDTH
  const stop = () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    timer.current = undefined; frame.current = undefined
  }
  const cancel = () => {
    stop()
    const g = gesture.current; gesture.current = null
    if (g?.kind === 'resize') setWidths(readCardWidths())
    if (g?.element.hasPointerCapture?.(g.pointer)) g.element.releasePointerCapture(g.pointer)
    ghost.current?.remove(); ghost.current = undefined
    setActive(null); setDraft(null)
  }
  useEffect(() => { cancel(); return stop }, [scope]) // scope changes cancel unsaved gestures
  useEffect(() => () => { gesture.current = null; stop(); ghost.current?.remove() }, [])

  const resize = (id: string, value: number) => {
    const next = { ...widthsRef.current, [id]: Math.max(DEFAULT_CARD_WIDTH, Math.round(value)) }
    widthsRef.current = next; setWidths(next)
  }
  const persistWidth = () => {
    try { saveCardWidths(widthsRef.current); setError(undefined) }
    catch { setWidths(readCardWidths()); setError('宽度保存失败，请重试。') }
  }
  const updateSort = () => {
    const g = gesture.current
    if (!g || g.kind !== 'sort') return
    const order = draftRef.current ?? g.original
    const offset = pointerX.current - g.element.getBoundingClientRect().left + g.element.scrollLeft - 10
    const index = cardIndexAt(order.map(width), offset)
    const next = moveCard(order, g.id, index)
    draftRef.current = next; setDraft(next)
  }
  const autoScroll = () => {
    const g = gesture.current
    if (!g || g.kind !== 'sort') return
    const rect = g.element.getBoundingClientRect()
    const delta = pointerX.current < rect.left + 48 ? -12 : pointerX.current > rect.right - 48 ? 12 : 0
    if (delta !== 0) { g.element.scrollLeft += delta; updateSort() }
    frame.current = requestAnimationFrame(autoScroll)
  }
  return {
    widths, order: draft ?? ids, active, error,
    handlers: {
      onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || gesture.current || saving.current || ghost.current) return
        const target = event.target as HTMLElement
        const handle = target.closest<HTMLElement>('[data-card-resize]')
        if (!handle && (!target.closest(HEADER) || target.closest(CONTROL))) return
        const slot = target.closest<HTMLElement>('[data-session-id]')
        const id = slot?.dataset.sessionId
        if (!id) return
        event.preventDefault(); event.stopPropagation(); setError(undefined)
        const g: Gesture = { kind: handle ? 'resize' : 'press', id, pointer: event.pointerId,
          x: event.clientX, y: event.clientY, width: width(id), element: event.currentTarget, original: [...latest.current.ids] }
        gesture.current = g; pointerX.current = event.clientX
        event.currentTarget.setPointerCapture?.(event.pointerId)
        if (handle) setActive({ id, kind: 'resize' })
        else {
          setActive({ id, kind: 'press' })
          timer.current = setTimeout(() => {
          if (gesture.current !== g || !latest.current.onReorder) return
          g.kind = 'sort'; draftRef.current = g.original; setDraft(g.original)
          ghost.current = liftCard(slot!, g.x, g.y)
          setActive({ id, kind: 'sort' }); frame.current = requestAnimationFrame(autoScroll)
        }, 400)
        }
      },
      onPointerMoveCapture(event: PointerEvent<HTMLDivElement>) {
        const g = gesture.current
        if (!g || event.pointerId !== g.pointer) return
        event.stopPropagation(); event.preventDefault(); pointerX.current = event.clientX
        if (g.kind === 'press' && Math.hypot(event.clientX - g.x, event.clientY - g.y) > 6) cancel()
        else if (g.kind === 'resize') resize(g.id, g.width + event.clientX - g.x)
        else if (g.kind === 'sort') { ghost.current?.move(event.clientX, event.clientY); updateSort() }
      },
      onPointerUpCapture(event: PointerEvent<HTMLDivElement>) {
        const g = gesture.current
        if (!g || g.pointer !== event.pointerId) return
        event.stopPropagation(); stop(); gesture.current = null
        setActive(g.kind === 'sort' ? { id: g.id, kind: 'settle' } : null)
        if (g.element.hasPointerCapture?.(g.pointer)) g.element.releasePointerCapture(g.pointer)
        if (g.kind === 'resize') persistWidth()
        else if (g.kind === 'press') {
          const previous = lastHeaderClick.current
          const at = performance.now()
          if (previous?.id === g.id && at - previous.at < 400) {
            const next = { ...widthsRef.current }; delete next[g.id]
            widthsRef.current = next; setWidths(next); persistWidth()
            lastHeaderClick.current = null
          } else lastHeaderClick.current = { id: g.id, at }
          latest.current.onFocus(g.id)
        }
        else {
          const order = draftRef.current ?? g.original
          const lifted = ghost.current
          const settle = async () => {
            const target = Array.from(g.element.querySelectorAll<HTMLElement>('[data-session-id]'))
              .find(element => element.dataset.sessionId === g.id) ?? null
            await lifted?.land(target)
            if (ghost.current === lifted) { ghost.current = undefined; setActive(null); setDraft(null) }
          }
          if (order.join('\0') === g.original.join('\0')) { void settle(); return }
          saving.current = true
          void latest.current.onReorder?.(order).then(settle, (reason: unknown) => {
            lifted?.remove(); ghost.current = undefined
            setActive(null); setDraft(null); setError(reason instanceof Error ? reason.message : '排序保存失败，请重试。')
          }).finally(() => { saving.current = false })
        }
      },
      onPointerCancelCapture() { cancel() },
      onLostPointerCapture() { if (gesture.current) cancel() },
      onDoubleClickCapture(event: MouseEvent<HTMLDivElement>) {
        const target = event.target as HTMLElement
        if (!target.closest(HEADER) || target.closest(CONTROL)) return
        const id = target.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId
        if (!id) return
        event.stopPropagation(); cancel()
        const next = { ...widthsRef.current }; delete next[id]
        widthsRef.current = next; setWidths(next); persistWidth()
      },
      onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape' && gesture.current) { event.stopPropagation(); cancel() }
        const target = event.target as HTMLElement
        const id = target.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId
        if (target.matches('[data-card-resize]') && id && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation()
          resize(id, event.key === 'Home' ? DEFAULT_CARD_WIDTH : width(id) + (event.key === 'ArrowRight' ? 20 : -20)); persistWidth()
        }
      },
    },
  }
}
