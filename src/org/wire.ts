/**
 * Wire vocabulary of the `matouLayout` remote namespace, shared verbatim by
 * the host service and the hand-written client contribution.
 * @module dsh-plugin-matou-layout/src/org/wire
 */

import type { MatouOrgState } from './model.ts'
import type { MatouOrgOp, MatouOrgOpFailure } from './ops.ts'

/** The document as the client reads it. */
export interface MatouOrgSnapshotValue {
  readonly revision: number
  readonly state: MatouOrgState
}

/** One atomic mutation batch against an observed revision. */
export interface MatouOrgApplyRequest {
  readonly expectedRevision: number
  readonly ops: readonly MatouOrgOp[]
}

/** Business failures of an apply; both carry enough to recover in place. */
export type MatouOrgApplyFailure =
  | { readonly code: 'revision-conflict'; readonly revision: number; readonly state: MatouOrgState }
  | MatouOrgOpFailure

export type MatouOrgApplyResult =
  | { readonly ok: true; readonly value: MatouOrgSnapshotValue }
  | { readonly ok: false; readonly error: MatouOrgApplyFailure }
