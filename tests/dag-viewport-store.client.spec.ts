// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clampDagScale } from '../src/client/dag/viewport.ts'
import {
  DAG_VIEWPORT_KEY_PREFIX,
  dagViewportKey,
  readDagViewport,
  writeDagViewport,
} from '../src/client/dag/viewport-store.ts'

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

/** A `localStorage` replacement whose every access throws, standing in for private browsing / storage disabled. */
function stubHostileStorage(): void {
  vi.stubGlobal('localStorage', {
    getItem() { throw new DOMException('storage disabled', 'SecurityError') },
    setItem() { throw new DOMException('quota exceeded', 'QuotaExceededError') },
  })
}

it('dagViewportKey 按页签一条：不掺窗口、不掺会话', () => {
  expect(DAG_VIEWPORT_KEY_PREFIX).toBe('matou.dag.viewport')
  expect(dagViewportKey('scene-1')).toBe('matou.dag.viewport:scene-1')
  expect(dagViewportKey('scene-2')).toBe('matou.dag.viewport:scene-2')
})

it('写入后读回一致，且每个页签读到的是它自己的视口', () => {
  expect(readDagViewport('s1')).toBeUndefined()
  writeDagViewport('s1', { x: -320.5, y: 88, scale: 1.75 })
  writeDagViewport('s2', { x: 70, y: 40, scale: 1 })
  expect(readDagViewport('s1')).toEqual({ x: -320.5, y: 88, scale: 1.75 })
  expect(readDagViewport('s2')).toEqual({ x: 70, y: 40, scale: 1 })
})

it('落盘的就是 DagTransform 自己的三个字段，不是码头的 panX/panY/zoom', () => {
  writeDagViewport('s1', { x: 70, y: 40, scale: 1 })
  const raw = localStorage.getItem(dagViewportKey('s1'))
  expect(raw).not.toBeNull()
  expect(JSON.parse(raw ?? 'null')).toEqual({ x: 70, y: 40, scale: 1 })
})

it('缺键回 undefined', () => {
  expect(readDagViewport('never-written')).toBeUndefined()
})

it('坏 JSON 回 undefined', () => {
  localStorage.setItem(dagViewportKey('s1'), '{bad json')
  expect(readDagViewport('s1')).toBeUndefined()
})

it('JSON 合法但形状不对（缺字段 / scale 是字符串 / 不是对象）一律回 undefined', () => {
  const key = dagViewportKey('s1')
  localStorage.setItem(key, JSON.stringify({ x: 12, y: 8 }))
  expect(readDagViewport('s1')).toBeUndefined()
  localStorage.setItem(key, JSON.stringify({ x: 12, scale: 1 }))
  expect(readDagViewport('s1')).toBeUndefined()
  localStorage.setItem(key, JSON.stringify({ x: 12, y: 8, scale: '1.5' }))
  expect(readDagViewport('s1')).toBeUndefined()
  localStorage.setItem(key, JSON.stringify(null))
  expect(readDagViewport('s1')).toBeUndefined()
  localStorage.setItem(key, JSON.stringify([70, 40, 1]))
  expect(readDagViewport('s1')).toBeUndefined()
})

it('非有限的平移量回 undefined —— JSON 里的 1e999 会 parse 成 Infinity', () => {
  localStorage.setItem(dagViewportKey('s1'), '{"x":1e999,"y":40,"scale":1}')
  expect(readDagViewport('s1')).toBeUndefined()
})

it('读回来的 scale 经过 clampDagScale，手改 localStorage 塞的越界值搞不白画布', () => {
  const key = dagViewportKey('s1')
  localStorage.setItem(key, JSON.stringify({ x: 70, y: 40, scale: 50 }))
  expect(readDagViewport('s1')?.scale).toBe(clampDagScale(50))
  expect(readDagViewport('s1')).toEqual({ x: 70, y: 40, scale: 2 })
  localStorage.setItem(key, JSON.stringify({ x: 70, y: 40, scale: 0.01 }))
  expect(readDagViewport('s1')).toEqual({ x: 70, y: 40, scale: 0.4 })
})

it('范围内的 scale 不被夹动', () => {
  localStorage.setItem(dagViewportKey('s1'), JSON.stringify({ x: 70, y: 40, scale: 1.25 }))
  expect(readDagViewport('s1')?.scale).toBe(1.25)
})

it('localStorage.setItem 抛错时 writeDagViewport 不抛', () => {
  stubHostileStorage()
  expect(() => writeDagViewport('s1', { x: 1, y: 2, scale: 1 })).not.toThrow()
})

it('localStorage.getItem 抛错时 readDagViewport 回 undefined 而不是把错扔给调用方', () => {
  stubHostileStorage()
  expect(readDagViewport('s1')).toBeUndefined()
})
