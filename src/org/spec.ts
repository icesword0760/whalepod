/**
 * Durable storage-domain declaration for the organization document. One table,
 * one row: the structure is small, and a single revisioned document keeps
 * every apply atomic.
 * @module dsh-plugin-matou-layout/src/org/spec
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { matouOrgDocumentSchema } from './model.ts'
import type { MatouOrgDocument } from './model.ts'

/** The one row key the whole document lives under. */
export const ORG_ROW_KEY = 'root'

/** Durable domain owned by this plugin's host half. */
export const matouLayoutDomainSpec = defineDomain({
  name: 'matou_layout',
  /**
   * `@deepseek-ai/dsh-storage-domain` has NO migration mechanism: a stored
   * document whose version differs from this one rejects at open with
   * `StorageError: unit 'matou_layout': stored version <n> != expected
   * <m>` — the whole domain fails to open, not just the affected records
   * (see the package's own README, "已知限制与延期工作": "没有数据迁移").
   * The only recovery today is deleting the stored medium
   * (`~/.dsh/storages/matou_layout.json`) — see the README's "已知限制"
   * section — which discards every user's saved task/scene/placement
   * layout.
   *
   * Bump this ONLY for a schema change that is genuinely INCOMPATIBLE with
   * documents already on disk (a field renamed/retyped/required-added in a
   * way an old document can no longer satisfy). Do NOT bump it for a purely
   * additive, optional field: zod strips unknown keys by default, so an old
   * (lower-version) document already validates fine against a schema that
   * only grew an optional field, and a newer document read by older code
   * just loses that field harmlessly — no incompatibility exists, so there
   * is nothing to guard against.
   *
   * WIDENING A FIELD'S VALUE DOMAIN IS NOT THE SAME THING and does NOT get
   * that guarantee: `string` -> `string | null` leaves old code rejecting the
   * null (its `identifier.optional()` is not nullable), and a rejection here
   * means the WHOLE domain fails to open — see this file's opening note. S3c
   * hit exactly this while modelling "explicitly at the root layer" and
   * backed out to an additive optional flag (`MatouPlacement.explicitRoot`)
   * for that reason; do the same for any future three-state field.
   * (History: `parentSessionId` on
   * `MatouPlacement` bumped this 0 -> 1 by mistake — S3b Task 11c review D3
   * — even though it is exactly this harmless-additive case; the version
   * stays at 1 rather than reverting, since existing on-disk documents have
   * already been stamped 1 and reverting would break THEM the same way.
   * `tests/org-model-version-compat.spec.ts` locks in that a v0-shaped
   * document — no `parentSessionId` anywhere — still validates under the
   * current schema, which is the executable proof this kind of change never
   * needed a bump.)
   */
  version: 1,
  tables: {
    org: domainTable<string, MatouOrgDocument>(matouOrgDocumentSchema),
  },
})
