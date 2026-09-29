import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWindowAttention } from '../src/client/notifications/attention.ts'
import { deriveNotificationEvents } from '../src/client/notifications/derive.ts'
afterEach(cleanup)
it('stops treating the selected card as watched when the app loses focus', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const hook = renderHook(useWindowAttention)
  expect(hook.result.current).toBe(true)
  act(() => { window.dispatchEvent(new Event('blur')) })
  expect(hook.result.current).toBe(false)
  act(() => { window.dispatchEvent(new Event('focus')) })
  expect(hook.result.current).toBe(true)
})
it('produces one unread end event when selected DSH session ends in the background without completed flag', () => {
  const prev = { sessions: { a: { running: true } }, pending: new Map() }
  const next = { sessions: { a: { running: false } }, pending: new Map() }
  const locate = () => ({ workspaceId: 'w', taskId: 't', sceneId: 's' })
  const events = deriveNotificationEvents(prev, next, undefined, locate)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ title: '本轮已结束', isFocusedSession: false, workspaceId: 'w', taskId: 't' })
  expect(deriveNotificationEvents(next, next, undefined, locate)).toEqual([])
  expect(deriveNotificationEvents(prev, next, 'a', locate)).toEqual([])
})
it('waiting for approval is not reported as an ended run', () => {
  const prev = { sessions: { a: { running: true } }, pending: new Map() }
  const next = { sessions: { a: { running: false } }, pending: new Map([['a', { key: 'q', sessionId: 'a', kind: 'approval' }]]) }
  const events = deriveNotificationEvents(prev, next, undefined, () => ({ workspaceId: 'w', taskId: 't', sceneId: 's' }))
  expect(events.map(e => e.eventType)).toEqual(['permission'])
})
