import { CAPABILITY_REMOTE } from '../capabilities/remote.ts'
/**
 * Hand-written client contribution for the `matouLayout` remote namespace —
 * the exact shape the typert generator would emit, kept in sync with the host
 * service's `@Remote` surface by the package contract test. Mounted through
 * `ctx.remote.$mount`; the host dispatches these endpoints via SRC discovery.
 * @module dsh-plugin-matou-layout/src/client/org/remote-contribution
 */

import { IMPORT_REMOTE } from '../import/remote.ts'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  matouOrgApplyRequestSchema,
  matouOrgApplyResultSchema,
  matouOrgSnapshotValueSchema,
} from '../../org/wire-schemas.ts'
import type {
  MatouOrgApplyRequest,
  MatouOrgApplyResult,
  MatouOrgSnapshotValue,
} from '../../org/wire.ts'

/** The typed face `ctx.remote.matouLayout` exposes to client callers. */
export interface MatouLayoutRemoteFace {
  snapshot: () => Promise<RemoteResult<MatouOrgSnapshotValue>>
  apply: (request: MatouOrgApplyRequest) => Promise<RemoteResult<MatouOrgApplyResult>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'matouLayout/snapshot': MatouLayoutRemoteFace['snapshot']
    'matouLayout/apply': MatouLayoutRemoteFace['apply']
  }
  interface TypertRemoteNamespaceMap {
    matouLayout: MatouLayoutRemoteFace
  }
}

const PACKAGE = 'dsh-plugin-matou-layout'

export const MATOU_LAYOUT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#matouLayout/snapshot`,
      service: 'matouLayout',
      namespace: 'matouLayout',
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/src/org/wire#MatouOrgSnapshotValue`,
        schema: matouOrgSnapshotValueSchema,
      },
    },
    {
      id: `${PACKAGE}#matouLayout/apply`,
      service: 'matouLayout',
      namespace: 'matouLayout',
      method: 'apply',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}/src/org/wire#MatouOrgApplyRequest`,
            schema: matouOrgApplyRequestSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}/src/org/wire#MatouOrgApplyResult`,
        schema: matouOrgApplyResultSchema,
      },
    },
  ],
}

/** One package registration owns both namespaces; duplicate package mounts reject. */
export const MATOU_PLUGIN_REMOTE: TypertRemoteContribution = { ...MATOU_LAYOUT_REMOTE, descriptors: [...MATOU_LAYOUT_REMOTE.descriptors, ...IMPORT_REMOTE.descriptors, ...CAPABILITY_REMOTE.descriptors] }
