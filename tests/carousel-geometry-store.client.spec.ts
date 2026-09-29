// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { geometryKey, readLevelGeometry, writeLevelGeometry } from '../src/client/carousel/geometry-store.ts'

beforeEach(() => localStorage.clear())

it('geometryKey 含 scene 与 parent，root 回落字面 root', () => {
  expect(geometryKey('s1', 'p1')).toBe('matou.carousel.geom:s1:p1')
  expect(geometryKey('s1', undefined)).toBe('matou.carousel.geom:s1:root')
})

it('写入后读回一致，缺失/损坏回 undefined', () => {
  expect(readLevelGeometry('s1', undefined)).toBeUndefined()
  writeLevelGeometry('s1', undefined, { scrollLeft: 120, focusedSessionId: 'a' })
  expect(readLevelGeometry('s1', undefined)).toEqual({ scrollLeft: 120, focusedSessionId: 'a' })
  localStorage.setItem(geometryKey('s1', undefined), '{bad json')
  expect(readLevelGeometry('s1', undefined)).toBeUndefined()
})

it('JSON 合法但形状不对（scrollLeft 非 number）时回 undefined', () => {
  localStorage.setItem(geometryKey('s1', undefined), JSON.stringify({ scrollLeft: 'x' }))
  expect(readLevelGeometry('s1', undefined)).toBeUndefined()
})
