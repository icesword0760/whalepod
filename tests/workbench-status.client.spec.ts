import { describe, expect, it } from 'vitest'
import { sessionDotState } from '../src/client/workbench/status.ts'

describe('sessionDotState', () => {
  it('ranks waiting > running > completed and hides idle', () => {
    expect(sessionDotState({ running: true, completed: true, pending: true })).toBe('warning')
    expect(sessionDotState({ running: true, completed: true, pending: false })).toBe('ongoing')
    expect(sessionDotState({ running: false, completed: true, pending: false })).toBe('done')
    expect(sessionDotState({ running: false, pending: false })).toBeUndefined()
  })
})
