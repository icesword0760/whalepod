// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDagPanelStore } from '../src/client/dag/panel-store.ts'

afterEach(() => { localStorage.clear() })

describe('createDagPanelStore', () => {
  it('starts closed', () => {
    expect(createDagPanelStore().create().getSnapshot()).toEqual({ open: false })
  })

  it('setOpen writes the value it is given, in both directions', () => {
    const store = createDagPanelStore().create()
    store.actions.setOpen(true)
    expect(store.getSnapshot().open).toBe(true)
    store.actions.setOpen(false)
    expect(store.getSnapshot().open).toBe(false)
  })

  /**
   * The teeth of the "no toggle" decision (plan Task 7): a `setOpen` that
   * ignored its argument and flipped instead would pass the round-trip above
   * and only fail here.
   */
  it('setOpen is idempotent — calling it twice with the same value does not flip back', () => {
    const store = createDagPanelStore().create()
    store.actions.setOpen(true)
    store.actions.setOpen(true)
    expect(store.getSnapshot().open).toBe(true)
    store.actions.setOpen(false)
    store.actions.setOpen(false)
    expect(store.getSnapshot().open).toBe(false)
  })

  /**
   * `toggle` is deliberately absent (unlike `notifications/panel-store.ts`):
   * the tab-bar button and the overlay's own close paths are the only two
   * writers and they always mean one direction. Asserted on the baked action
   * table rather than on types, because `tsconfig.json` only typechecks `src`.
   */
  it('exposes exactly one action, setOpen — no toggle', () => {
    expect(Object.keys(createDagPanelStore().create().actions)).toEqual(['setOpen'])
  })

  it('notifies subscribers once per real change and not at all for a redundant write', () => {
    const store = createDagPanelStore().create()
    const seen = vi.fn()
    const off = store.subscribe(seen)
    store.actions.setOpen(true)
    expect(seen).toHaveBeenCalledTimes(1)
    store.actions.setOpen(true)
    expect(seen).toHaveBeenCalledTimes(1)
    store.actions.setOpen(false)
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    store.actions.setOpen(true)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('is not persisted: nothing reaches localStorage and a fresh instance starts closed again', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const first = createDagPanelStore().create()
    first.actions.setOpen(true)
    expect(setItem).not.toHaveBeenCalled()
    expect(createDagPanelStore().create().getSnapshot().open).toBe(false)
  })
})
