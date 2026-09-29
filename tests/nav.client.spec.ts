import { describe, expect, it } from 'vitest'
import type { MatouSceneView, MatouTaskView, MatouWorkspaceOrgView } from '../src/client/org/derive.ts'
import { EMPTY_NAV, locateSession, remember, resolveActive } from '../src/client/nav/navigation.ts'
import type { NavMemory } from '../src/client/nav/navigation.ts'

function scene(id: string, taskId: string, sessions: readonly string[]): MatouSceneView {
  return {
    id, taskId, name: id, titlePinned: false, virtual: false, ordinal: 1,
    sessions: sessions.map((sessionId, index) => ({ sessionId, ordinal: index + 1 })),
  }
}

function task(id: string, workspaceId: string, scenes: readonly MatouSceneView[]): MatouTaskView {
  return {
    id, workspaceId, title: id, status: 'planned', isPinned: false, virtual: false, ordinal: 1, scenes,
  }
}

const VIEW: readonly MatouWorkspaceOrgView[] = [
  {
    workspaceId: 'ws-a', title: 'A', ordinal: 1,
    tasks: [
      task('t-a1', 'ws-a', [scene('sc-a1x', 't-a1', ['s-1', 's-2']), scene('sc-a1y', 't-a1', ['s-3'])]),
      task('t-a2', 'ws-a', [scene('sc-a2x', 't-a2', ['s-4'])]),
    ],
  },
  {
    workspaceId: 'ws-b', title: 'B', ordinal: 2,
    tasks: [task('t-b1', 'ws-b', [scene('sc-b1x', 't-b1', [])])],
  },
]

describe('resolveActive', () => {
  it('walks the first branch when memory is empty', () => {
    const active = resolveActive(VIEW, EMPTY_NAV)
    expect(active.workspace?.workspaceId).toBe('ws-a')
    expect(active.task?.id).toBe('t-a1')
    expect(active.scene?.id).toBe('sc-a1x')
    expect(active.sessionId).toBe('s-1')
  })

  it('follows memory level by level', () => {
    const memory: NavMemory = {
      activeWorkspaceId: 'ws-a',
      taskByWorkspace: { 'ws-a': 't-a1' },
      sceneByTask: { 't-a1': 'sc-a1y' },
      sessionByScene: { 'sc-a1y': 's-3' },
    }
    const active = resolveActive(VIEW, memory)
    expect(active.task?.id).toBe('t-a1')
    expect(active.scene?.id).toBe('sc-a1y')
    expect(active.sessionId).toBe('s-3')
  })

  it('falls back to the first item at the level whose memory is stale, then keeps trying memory below', () => {
    const memory: NavMemory = {
      activeWorkspaceId: 'ws-a',
      taskByWorkspace: { 'ws-a': 't-gone' },
      sceneByTask: { 't-a1': 'sc-a1y' },
      sessionByScene: { 'sc-a1y': 's-gone' },
    }
    const active = resolveActive(VIEW, memory)
    expect(active.task?.id).toBe('t-a1')
    expect(active.scene?.id).toBe('sc-a1y')
    expect(active.sessionId).toBe('s-3')
  })

  it('yields undefined levels for an empty view or an empty scene', () => {
    expect(resolveActive([], EMPTY_NAV)).toEqual({})
    const active = resolveActive(VIEW, { ...EMPTY_NAV, activeWorkspaceId: 'ws-b' })
    expect(active.scene?.id).toBe('sc-b1x')
    expect(active.sessionId).toBeUndefined()
  })
})

describe('remember', () => {
  it('switching the workspace writes only the workspace; lower levels ride on old memory', () => {
    const before: NavMemory = {
      activeWorkspaceId: 'ws-a',
      taskByWorkspace: { 'ws-b': 't-b1' },
      sceneByTask: {},
      sessionByScene: {},
    }
    const after = remember(before, { workspaceId: 'ws-b' })
    expect(after.activeWorkspaceId).toBe('ws-b')
    expect(after.taskByWorkspace).toEqual({ 'ws-b': 't-b1' })
    expect(before.activeWorkspaceId).toBe('ws-a')
  })

  it('switching a task or scene or session writes that level and leaves the levels above untouched', () => {
    const step1 = remember(EMPTY_NAV, { workspaceId: 'ws-a', taskId: 't-a2' })
    expect(step1.taskByWorkspace['ws-a']).toBe('t-a2')
    const step2 = remember(step1, { workspaceId: 'ws-a', taskId: 't-a2', sceneId: 'sc-a2x' })
    expect(step2.sceneByTask['t-a2']).toBe('sc-a2x')
    const step3 = remember(step2, { workspaceId: 'ws-a', taskId: 't-a2', sceneId: 'sc-a2x', sessionId: 's-4' })
    expect(step3.sessionByScene['sc-a2x']).toBe('s-4')
    expect(step3.activeWorkspaceId).toBe('ws-a')
    expect(step3.taskByWorkspace['ws-a']).toBe('t-a2')
  })
})

describe('locateSession', () => {
  it('finds the three levels owning a session', () => {
    expect(locateSession(VIEW, 's-3')).toEqual({ workspaceId: 'ws-a', taskId: 't-a1', sceneId: 'sc-a1y' })
  })

  it('returns undefined for an unknown session', () => {
    expect(locateSession(VIEW, 'nope')).toBeUndefined()
  })
})
