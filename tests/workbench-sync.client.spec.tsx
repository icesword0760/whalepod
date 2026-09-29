// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { MatouWorkspaceOrgView } from '../src/client/org/derive.ts'
import { EMPTY_NAV, resolveActive } from '../src/client/nav/navigation.ts'
import type { NavMemory } from '../src/client/nav/navigation.ts'
import { useWorkbenchSync } from '../src/client/workbench/useWorkbenchSync.ts'

const VIEW: readonly MatouWorkspaceOrgView[] = [{
  workspaceId: 'ws', title: 'W', ordinal: 1,
  tasks: [{
    id: 't-1', workspaceId: 'ws', title: 'T', status: 'planned', isPinned: false, virtual: false, ordinal: 1,
    scenes: [
      { id: 'sc-a', taskId: 't-1', name: 'A', titlePinned: false, virtual: false, ordinal: 1,
        sessions: [{ sessionId: 's-1', ordinal: 1 }] },
      { id: 'sc-b', taskId: 't-1', name: 'B', titlePinned: false, virtual: false, ordinal: 2,
        sessions: [{ sessionId: 's-2', ordinal: 1 }] },
      { id: 'sc-empty', taskId: 't-1', name: 'E', titlePinned: false, virtual: false, ordinal: 3, sessions: [] },
    ],
  }],
}]

function Probe(props: { nav: NavMemory; current: string | undefined; actions: Parameters<typeof useWorkbenchSync>[0]['actions'] }) {
  const active = resolveActive(VIEW, props.nav)
  useWorkbenchSync({ view: VIEW, active, currentSessionId: props.current, actions: props.actions })
  return null
}

function actionsDouble() {
  return { openSession: vi.fn(), clearSession: vi.fn(), navigate: vi.fn() }
}

afterEach(cleanup)

describe('useWorkbenchSync', () => {
  it('on mount follows DSH current session into its scene (rule B wins)', () => {
    const actions = actionsDouble()
    render(<Probe nav={EMPTY_NAV} current="s-2" actions={actions} />)
    expect(actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1', sceneId: 'sc-b', sessionId: 's-2' })
    expect(actions.openSession).not.toHaveBeenCalled()
  })

  it('on mount with no current session opens the resolved scene session', () => {
    const actions = actionsDouble()
    render(<Probe nav={EMPTY_NAV} current={undefined} actions={actions} />)
    expect(actions.openSession).toHaveBeenCalledWith('s-1')
  })

  it('a user scene change opens the remembered session, and an empty scene clears', () => {
    const actions = actionsDouble()
    const navA: NavMemory = { ...EMPTY_NAV, activeWorkspaceId: 'ws', taskByWorkspace: { ws: 't-1' }, sceneByTask: { 't-1': 'sc-a' } }
    const { rerender } = render(<Probe nav={navA} current="s-1" actions={actions} />)
    const navB: NavMemory = { ...navA, sceneByTask: { 't-1': 'sc-b' } }
    rerender(<Probe nav={navB} current="s-1" actions={actions} />)
    expect(actions.openSession).toHaveBeenCalledWith('s-2')
    const navE: NavMemory = { ...navA, sceneByTask: { 't-1': 'sc-empty' } }
    rerender(<Probe nav={navE} current="s-2" actions={actions} />)
    expect(actions.clearSession).toHaveBeenCalledOnce()
  })

  it('an external current change relocates navigation without reopening', () => {
    const actions = actionsDouble()
    const navA: NavMemory = { ...EMPTY_NAV, activeWorkspaceId: 'ws', taskByWorkspace: { ws: 't-1' }, sceneByTask: { 't-1': 'sc-a' }, sessionByScene: { 'sc-a': 's-1' } }
    const { rerender } = render(<Probe nav={navA} current="s-1" actions={actions} />)
    actions.navigate.mockClear()
    rerender(<Probe nav={navA} current="s-2" actions={actions} />)
    expect(actions.navigate).toHaveBeenCalledWith({ workspaceId: 'ws', taskId: 't-1', sceneId: 'sc-b', sessionId: 's-2' })
    expect(actions.openSession).not.toHaveBeenCalled()
  })
})
