import { describe, expect, it } from 'vitest'
import type { MatouSceneView, MatouTaskView } from '../src/client/org/derive.ts'
import {
  nextNumberedName, sceneDeleteImpact, taskDeleteImpact, validateUniqueName,
} from '../src/client/org/naming.ts'

const LABELS = { empty: '名称不能为空', duplicate: '已有同名事项' }

describe('nextNumberedName', () => {
  it('returns the base when nothing is taken', () => {
    expect(nextNumberedName([], '新事项')).toBe('新事项')
  })
  it('numbers from 2 when the base is taken', () => {
    expect(nextNumberedName(['新事项'], '新事项')).toBe('新事项 2')
  })
  it('skips taken numbers', () => {
    expect(nextNumberedName(['新事项', '新事项 2', '新事项 3', '别的'], '新事项')).toBe('新事项 4')
    expect(nextNumberedName(['新事项 2'], '新事项')).toBe('新事项')
  })
})

describe('validateUniqueName', () => {
  it('rejects blank names', () => {
    expect(validateUniqueName('   ', [], LABELS)).toBe(LABELS.empty)
  })
  it('rejects duplicates after trimming and accepts a fresh name', () => {
    expect(validateUniqueName(' 修 bug ', ['修 bug'], LABELS)).toBe(LABELS.duplicate)
    expect(validateUniqueName('方案', ['修 bug'], LABELS)).toBeUndefined()
  })
})

describe('delete impact', () => {
  const scenes: MatouSceneView[] = [
    { id: 'sc-1', taskId: 't', name: 'a', titlePinned: false, virtual: false, ordinal: 1,
      sessions: [{ sessionId: 's-1', ordinal: 1 }, { sessionId: 's-2', ordinal: 2 }] },
    { id: 'sc-2', taskId: 't', name: 'b', titlePinned: false, virtual: true, ordinal: 2,
      sessions: [{ sessionId: 's-3', ordinal: 1 }] },
  ]
  const task: MatouTaskView = {
    id: 't', workspaceId: 'ws', title: 'T', status: 'planned', isPinned: false, virtual: false, ordinal: 1, scenes,
  }
  it('counts scenes and sessions under a task, virtual scenes included', () => {
    expect(taskDeleteImpact(task)).toEqual({ sceneCount: 2, sessionCount: 3 })
  })
  it('counts a single scene', () => {
    expect(sceneDeleteImpact(scenes[0]!)).toEqual({ sceneCount: 1, sessionCount: 2 })
  })
})
