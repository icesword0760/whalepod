import { describe, expect, it } from 'vitest'
import { EMPTY_ORG_STATE, defaultSceneId, defaultTaskId } from '../src/org/model.ts'
import type { MatouOrgState, MatouPlacement, MatouScene, MatouTask } from '../src/org/model.ts'
import { deriveOrgView } from '../src/client/org/derive.ts'

function task(partial: Partial<MatouTask> & Pick<MatouTask, 'id' | 'workspaceId' | 'title'>): MatouTask {
  return {
    status: 'planned', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1,
    ...partial,
  }
}

function scene(partial: Partial<MatouScene> & Pick<MatouScene, 'id' | 'taskId' | 'name'>): MatouScene {
  return { titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1, ...partial }
}

function placement(
  partial: Partial<MatouPlacement> & Pick<MatouPlacement, 'sessionId' | 'taskId' | 'sceneId'>,
): MatouPlacement {
  return { sortKey: 1, updatedAt: 1, ...partial }
}

const WS = { workspaceId: 'ws-1', title: '项目甲', sessionIds: ['s-1', 's-2'] }

function derive(org: MatouOrgState, options?: {
  workspaces?: typeof WS[]
  known?: string[]
}) {
  return deriveOrgView({
    workspaces: options?.workspaces ?? [WS],
    knownSessionIds: new Set(options?.known ?? ['s-1', 's-2']),
    org,
  })
}

describe('deriveOrgView', () => {
  it('synthesizes a virtual default task and scene when no org data exists', () => {
    const [workspace] = derive(EMPTY_ORG_STATE)
    expect(workspace!.ordinal).toBe(1)
    expect(workspace!.tasks).toHaveLength(1)
    const fallback = workspace!.tasks[0]!
    expect(fallback).toMatchObject({
      id: defaultTaskId('ws-1'), title: '默认', virtual: true, ordinal: 1,
    })
    expect(fallback.scenes[0]).toMatchObject({
      id: defaultSceneId(fallback.id), virtual: true, ordinal: 1,
    })
    expect(fallback.scenes[0]!.sessions.map(ref => ref.sessionId)).toEqual(['s-1', 's-2'])
    expect(fallback.scenes[0]!.sessions.map(ref => ref.ordinal)).toEqual([1, 2])
  })

  it('lets a materialized default-task row override the virtual one', () => {
    const org: MatouOrgState = {
      ...EMPTY_ORG_STATE,
      tasks: [task({ id: defaultTaskId('ws-1'), workspaceId: 'ws-1', title: '改名的默认' })],
    }
    const [workspace] = derive(org)
    expect(workspace!.tasks[0]).toMatchObject({ title: '改名的默认', virtual: false })
  })

  it('ignores placements whose session is unknown', () => {
    const org: MatouOrgState = {
      tasks: [task({ id: 't-1', workspaceId: 'ws-1', title: 'T' })],
      scenes: [scene({ id: 'sc-1', taskId: 't-1', name: 'S' })],
      placements: [placement({ sessionId: 'ghost', taskId: 't-1', sceneId: 'sc-1' })],
    }
    const [workspace] = derive(org)
    const target = workspace!.tasks.find(candidate => candidate.id === 't-1')!
    expect(target.scenes[0]!.sessions).toHaveLength(0)
  })

  it('falls a session back to the default scene when its scene is gone', () => {
    const org: MatouOrgState = {
      tasks: [task({ id: 't-1', workspaceId: 'ws-1', title: 'T' })],
      scenes: [],
      placements: [placement({ sessionId: 's-1', taskId: 't-1', sceneId: 'sc-dead' })],
    }
    const [workspace] = derive(org)
    const fallback = workspace!.tasks.find(candidate => candidate.id === defaultTaskId('ws-1'))!
    expect(fallback.scenes[0]!.sessions.map(ref => ref.sessionId)).toContain('s-1')
  })

  it('keeps unplaced sessions in workspace order under the default task', () => {
    const org: MatouOrgState = {
      tasks: [task({ id: 't-1', workspaceId: 'ws-1', title: 'T' })],
      scenes: [scene({ id: 'sc-1', taskId: 't-1', name: 'S' })],
      placements: [placement({ sessionId: 's-2', taskId: 't-1', sceneId: 'sc-1' })],
    }
    const [workspace] = derive(org)
    const fallback = workspace!.tasks.find(candidate => candidate.id === defaultTaskId('ws-1'))!
    expect(fallback.scenes[0]!.sessions.map(ref => ref.sessionId)).toEqual(['s-1'])
    const explicit = workspace!.tasks.find(candidate => candidate.id === 't-1')!
    expect(explicit.scenes[0]!.sessions.map(ref => ref.sessionId)).toEqual(['s-2'])
  })

  it('orders pinned tasks first, then by sortKey, with 1-based contiguous ordinals', () => {
    const org: MatouOrgState = {
      ...EMPTY_ORG_STATE,
      tasks: [
        task({ id: 't-a', workspaceId: 'ws-1', title: 'A', sortKey: 1 }),
        task({ id: 't-b', workspaceId: 'ws-1', title: 'B', sortKey: 2, isPinned: true }),
        task({ id: 't-c', workspaceId: 'ws-1', title: 'C', sortKey: 3 }),
      ],
    }
    const [workspace] = derive(org, { known: [] })
    expect(workspace!.tasks.map(candidate => candidate.id)).toEqual(['t-b', 't-a', 't-c'])
    expect(workspace!.tasks.map(candidate => candidate.ordinal)).toEqual([1, 2, 3])
  })

  it('omits an empty unmaterialized default task, but keeps materialized ones', () => {
    const org: MatouOrgState = {
      tasks: [task({ id: 't-1', workspaceId: 'ws-1', title: 'T' })],
      scenes: [scene({ id: 'sc-1', taskId: 't-1', name: 'S' })],
      placements: [
        placement({ sessionId: 's-1', taskId: 't-1', sceneId: 'sc-1' }),
        placement({ sessionId: 's-2', taskId: 't-1', sceneId: 'sc-1', sortKey: 2 }),
      ],
    }
    const [workspace] = derive(org)
    expect(workspace!.tasks.map(candidate => candidate.id)).toEqual(['t-1'])

    const materialized: MatouOrgState = {
      ...org,
      tasks: [...org.tasks, task({ id: defaultTaskId('ws-1'), workspaceId: 'ws-1', title: '默认', sortKey: 0 })],
    }
    const [again] = derive(materialized)
    expect(again!.tasks.map(candidate => candidate.id)).toContain(defaultTaskId('ws-1'))
  })
})
