// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { liftCard } from '../src/client/carousel/card-lift.ts'
afterEach(() => { document.body.innerHTML = '' })
it('lifts an inert snapshot, follows the pointer in both axes, and lands without duplicate live controls', async () => {
  const slot = document.createElement('div')
  slot.dataset.sessionId = 'a'
  slot.innerHTML = '<article id="original"><button id="menu">More</button><textarea>draft</textarea></article>'
  document.body.append(slot)
  const card = slot.firstElementChild as HTMLElement
  card.getBoundingClientRect = () => ({ left: 300, top: 40, width: 470, height: 700 } as DOMRect)
  const ghost = liftCard(slot, 350, 60)!
  const overlay = document.querySelector<HTMLElement>('[data-floating-card]')!
  expect(overlay.getAttribute('aria-hidden')).toBe('true')
  expect(overlay.hasAttribute('inert')).toBe(true)
  expect(overlay.querySelectorAll('[id]')).toHaveLength(0)
  expect(overlay.querySelector('button')?.tabIndex).toBe(-1)
  expect(overlay.style.left).toBe('300px')
  ghost.move(500, 90)
  expect(overlay.style.left).toBe('450px')
  expect(overlay.style.top).toBe('62px')
  expect(document.getElementById('original')).toBe(card)
  await ghost.land(slot)
  expect(document.querySelector('[data-floating-card]')).toBeNull()
  expect(document.getElementById('original')).toBe(card)
})
it('removes the floating snapshot on cancellation', () => {
  const slot = document.createElement('div'); slot.innerHTML = '<article></article>'
  const ghost = liftCard(slot, 0, 0)!
  ghost.remove()
  expect(document.querySelector('[data-floating-card]')).toBeNull()
})
