import { MatouCapabilityService } from './capabilities/service.ts'
/**
 * Host half of the Matou layout plugin: the durable organization document
 * (tasks/scenes/placements — structure DSH itself does not model) behind a
 * revisioned snapshot/apply remote namespace. Dispatch relies on the
 * gateway's SRC discovery: `@Remote` markers plus the `typertRemote` binding,
 * no generated typert artifacts.
 * @module dsh-plugin-matou-layout
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MatouImportService } from './import/service.ts'
import { createMatouControlPlugin } from './control/index.ts'
import { EMPTY_ORG_STATE, sameOrgState } from './org/model.ts'
import type { MatouOrgDocument } from './org/model.ts'
import { applyOrgOps } from './org/ops.ts'
import { ORG_ROW_KEY, matouLayoutDomainSpec } from './org/spec.ts'
import type {
  MatouOrgApplyRequest,
  MatouOrgApplyResult,
  MatouOrgSnapshotValue,
} from './org/wire.ts'

export type { MatouOrgDocument, MatouOrgState, MatouTask, MatouScene, MatouPlacement, MatouTaskStatus } from './org/model.ts'
export { EMPTY_ORG_STATE, defaultSceneId, defaultTaskId, matouOrgDocumentSchema } from './org/model.ts'
export type { MatouOrgOp, MatouOrgOpFailure } from './org/ops.ts'
export { applyOrgOps } from './org/ops.ts'
export { ORG_ROW_KEY, matouLayoutDomainSpec } from './org/spec.ts'
export type * from './org/wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    matouLayout: MatouLayoutService
  }
}

const EMPTY_DOCUMENT: MatouOrgDocument = Object.freeze({
  revision: 0,
  state: EMPTY_ORG_STATE,
})

/** Structured clone detaches storage rows from wire values in both directions. */
function detached<T>(value: T): T {
  return structuredClone(value)
}

/** Durable organization document service; owns the one matou_layout domain. */
export class MatouLayoutService extends TypertRemoteService {
  static inject = ['storageDomain']

  private table?: KvTable<string, MatouOrgDocument>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'matouLayout')
    // The session-control plane is a child plugin, not a dependency: it reads
    // this document through the instance handed to it, and stays pending in
    // deployments without the session services. Mirrors how DSH composes its
    // own sub-plugins (packages/api/session-controller/src/index.ts:131-132).
    ctx.plugin(createMatouControlPlugin(this))
    ctx.plugin(MatouImportService)
    ctx.plugin(MatouCapabilityService)
  }

  /** Open and own the durable domain; drain mutations before closing it. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(matouLayoutDomainSpec)
    this.ctx.effect(() => async () => {
      await this.mutationTail
      await domain.close()
    }, 'matou-layout.domainClose')
    this.table = domain.table('org')
  }

  /** Read the current document; a missing row is the empty revision-0 document. */
  @Remote('snapshot')
  async snapshot(): Promise<MatouOrgSnapshotValue> {
    await Promise.resolve()
    return detached(this.requireTable().get(ORG_ROW_KEY) ?? EMPTY_DOCUMENT)
  }

  /**
   * Apply one op batch against an observed revision. Batches are serialized
   * behind one tail so concurrent writers race on the revision, not the row.
   * @param request - observed revision and the ops to apply atomically.
   * @returns the committed document, or a conflict carrying the current one.
   */
  @Remote('apply')
  apply(request: MatouOrgApplyRequest): Promise<MatouOrgApplyResult> {
    const run = this.mutationTail.then(async (): Promise<MatouOrgApplyResult> => {
      const table = this.requireTable()
      const current = table.get(ORG_ROW_KEY) ?? EMPTY_DOCUMENT
      if (current.revision !== request.expectedRevision) {
        return { ok: false, error: { code: 'revision-conflict', ...detached(current) } }
      }
      const outcome = applyOrgOps(current.state, request.ops, Date.now())
      if (!outcome.ok) return { ok: false, error: outcome.error }
      // 批次没改变任何东西就不推进 revision —— 见 `sameOrgState` 的文档：
      // 推进它会让「被静默忽略的 op」变成一条无限写循环，并挤掉所有其他写入。
      if (sameOrgState(outcome.state, current.state)) return { ok: true, value: detached(current) }
      const next: MatouOrgDocument = { revision: current.revision + 1, state: outcome.state }
      await table.put(ORG_ROW_KEY, detached(next))
      return { ok: true, value: detached(next) }
    })
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private requireTable(): KvTable<string, MatouOrgDocument> {
    if (this.table === undefined) {
      throw new Error('matou-layout: durable domain is not initialized')
    }
    return this.table
  }
}

export default MatouLayoutService
