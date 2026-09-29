/**
 * Client mirror of the host organization document: one persisted store (the
 * localStorage copy is a warm-start cache, never the source of truth) plus a
 * thin client that talks to `ctx.remote.matouLayout`. Writes are pessimistic:
 * the store only moves on what the host actually committed, and a revision
 * conflict re-syncs from the document the failure carries.
 * @module dsh-plugin-matou-layout/src/client/org/store
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle, StoreInstance } from '@deepseek-ai/dsh-client-store'
import { EMPTY_ORG_STATE } from '../../org/model.ts'
import type { MatouOrgState } from '../../org/model.ts'
import type { MatouOrgOp } from '../../org/ops.ts'
import type { MatouOrgApplyResult, MatouOrgSnapshotValue } from '../../org/wire.ts'
import type { MatouLayoutRemoteFace } from './remote-contribution.ts'

/**
 * Mirror state. `phase` narrates trust in the data: 'cold' = cache or empty
 * (host not consulted yet), 'ready' = host-confirmed, 'error' = the last
 * refresh failed and the shown data may be stale (kept, per the quiet
 * degradation principle).
 */
export interface OrgMirrorState {
  phase: 'cold' | 'ready' | 'error'
  revision: number
  org: MatouOrgState
}

type OrgMirrorActions = {
  hydrate: (draft: OrgMirrorState, document: MatouOrgSnapshotValue) => void
  degrade: (draft: OrgMirrorState) => void
}

/** Persist key version-suffixed so a schema change starts a fresh cache. */
const PERSIST_KEY = 'dsh-plugin-matou-layout.org.v1'

/** Create the mirror store handle; instances are owned by the plugin apply. */
export function createOrgMirrorStore(): EngineStoreHandle<OrgMirrorState, OrgMirrorActions> {
  return defineStore({
    init: (): OrgMirrorState => ({ phase: 'cold', revision: 0, org: EMPTY_ORG_STATE }),
    persist: PERSIST_KEY,
    actions: {
      hydrate: (draft, document: MatouOrgSnapshotValue) => {
        draft.phase = 'ready'
        draft.revision = document.revision
        draft.org = document.state
      },
      degrade: (draft) => {
        draft.phase = 'error'
      },
    },
  })
}

/** The org client the rest of the plugin (and later slices' UI) consumes. */
export interface MatouOrgClient {
  readonly store: StoreInstance<OrgMirrorState, OrgMirrorActions>
  /** Pull the host document into the mirror; a failure degrades quietly. */
  refresh(): Promise<void>
  /**
   * Apply ops against the mirrored revision. A commit or a revision conflict
   * both re-sync the mirror; a transport failure degrades and rethrows.
   */
  apply(ops: readonly MatouOrgOp[]): Promise<MatouOrgApplyResult>
}

/**
 * Build the client over a remote face and an owned store instance.
 * @param face - `ctx.remote.matouLayout` (or a scripted stand-in in tests).
 * @param store - mirror instance whose lifecycle the caller owns.
 * @returns the org client.
 */
export function createOrgClient(
  face: MatouLayoutRemoteFace,
  store: StoreInstance<OrgMirrorState, OrgMirrorActions>,
): MatouOrgClient {
  return {
    store,
    async refresh() {
      const result = await face.snapshot()
      if (!result.ok) {
        store.actions.degrade()
        return
      }
      store.actions.hydrate(result.value)
    },
    async apply(ops) {
      const result = await face.apply({
        expectedRevision: store.getSnapshot().revision,
        ops,
      })
      if (!result.ok) {
        store.actions.degrade()
        throw result.error
      }
      const outcome = result.value
      if (outcome.ok) {
        store.actions.hydrate(outcome.value)
      } else if (outcome.error.code === 'revision-conflict') {
        store.actions.hydrate({ revision: outcome.error.revision, state: outcome.error.state })
      }
      return outcome
    },
  }
}
