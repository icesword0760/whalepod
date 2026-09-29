import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { EMPTY_ORG_STATE } from '../src/org/model.ts'
import type { MatouOrgState } from '../src/org/model.ts'
import type { MatouOrgApplyResult, MatouOrgSnapshotValue } from '../src/org/wire.ts'
import type { MatouLayoutRemoteFace } from '../src/client/org/remote-contribution.ts'
import { createOrgClient, createOrgMirrorStore } from '../src/client/org/store.ts'

const STATE_ONE: MatouOrgState = {
  tasks: [{
    id: 't-1', workspaceId: 'ws-1', title: '修 bug', status: 'planned',
    isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1,
  }],
  scenes: [],
  placements: [],
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value } as RemoteResult<T>
}

function transportFailure<T>(): RemoteResult<T> {
  return { ok: false, error: Object.assign(new Error('gone'), { code: 'gateway/internal' }) } as unknown as RemoteResult<T>
}

function scriptedFace(script: {
  snapshot?: () => RemoteResult<MatouOrgSnapshotValue>
  apply?: (request: { expectedRevision: number }) => RemoteResult<MatouOrgApplyResult>
}): MatouLayoutRemoteFace {
  return {
    snapshot: async () => script.snapshot?.() ?? ok({ revision: 0, state: EMPTY_ORG_STATE }),
    apply: async request => script.apply?.(request) ?? ok<MatouOrgApplyResult>({
      ok: true,
      value: { revision: request.expectedRevision + 1, state: EMPTY_ORG_STATE },
    }),
  }
}

describe('org mirror store', () => {
  it('starts cold and empty, then hydrates from a refresh', async () => {
    const store = createOrgMirrorStore().create()
    expect(store.getSnapshot()).toMatchObject({ phase: 'cold', revision: 0 })
    const client = createOrgClient(scriptedFace({
      snapshot: () => ok({ revision: 4, state: STATE_ONE }),
    }), store)
    await client.refresh()
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', revision: 4 })
    expect(store.getSnapshot().org.tasks[0]!.id).toBe('t-1')
    store.clearPersisted()
  })

  it('warm-starts from the persisted cache under the same key', async () => {
    const first = createOrgMirrorStore().create()
    const client = createOrgClient(scriptedFace({
      snapshot: () => ok({ revision: 2, state: STATE_ONE }),
    }), first)
    await client.refresh()

    const second = createOrgMirrorStore().create()
    expect(second.getSnapshot().revision).toBe(2)
    expect(second.getSnapshot().org.tasks).toHaveLength(1)
    second.clearPersisted()
  })

  it('degrades quietly on a failed refresh and keeps the shown data', async () => {
    const store = createOrgMirrorStore().create()
    const good = createOrgClient(scriptedFace({
      snapshot: () => ok({ revision: 1, state: STATE_ONE }),
    }), store)
    await good.refresh()
    const bad = createOrgClient(scriptedFace({
      snapshot: () => transportFailure(),
    }), store)
    await bad.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.revision).toBe(1)
    expect(snapshot.org.tasks).toHaveLength(1)
    store.clearPersisted()
  })

  it('advances the revision on a committed apply', async () => {
    const store = createOrgMirrorStore().create()
    const client = createOrgClient(scriptedFace({
      apply: request => ok<MatouOrgApplyResult>({
        ok: true,
        value: { revision: request.expectedRevision + 1, state: STATE_ONE },
      }),
    }), store)
    const outcome = await client.apply([{ kind: 'task/create', id: 't-1', workspaceId: 'ws-1', title: 'X' }])
    expect(outcome.ok).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', revision: 1 })
    store.clearPersisted()
  })

  it('re-syncs from the document a revision conflict carries and surfaces the failure', async () => {
    const store = createOrgMirrorStore().create()
    const client = createOrgClient(scriptedFace({
      apply: () => ok<MatouOrgApplyResult>({
        ok: false,
        error: { code: 'revision-conflict', revision: 7, state: STATE_ONE },
      }),
    }), store)
    const outcome = await client.apply([{ kind: 'placement/remove', sessionId: 's-x' }])
    expect(outcome.ok).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', revision: 7 })
    store.clearPersisted()
  })

  it('degrades and rethrows on a transport failure during apply', async () => {
    const store = createOrgMirrorStore().create()
    const client = createOrgClient(scriptedFace({
      apply: () => transportFailure(),
    }), store)
    await expect(client.apply([{ kind: 'placement/remove', sessionId: 's-x' }])).rejects.toThrow('gone')
    expect(store.getSnapshot().phase).toBe('error')
    store.clearPersisted()
  })
})
