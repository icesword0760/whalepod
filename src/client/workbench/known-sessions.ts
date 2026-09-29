/**
 * Which DSH sessions the workbench shows. Mirrors the official sidebar's
 * filters (no subagent rows, no archived rows) with one deliberate
 * difference: a blank session stays visible while it is current OR while
 * the organization document places it — a session the user created inside a
 * scene is an artifact, not a placeholder to hide on deselection.
 */
import type { MatouOrgState } from '../../org/model.ts'

export interface KnownSessionsInput {
  readonly ids: readonly string[]
  readonly summaryOf: (id: string) => { readonly blank: boolean; readonly origin?: 'subagent' | undefined } | undefined
  readonly archivedIds: Iterable<string>
  readonly currentId: string | undefined
  readonly org: Pick<MatouOrgState, 'placements'>
}

export function selectKnownSessionIds(input: KnownSessionsInput): ReadonlySet<string> {
  const archived = new Set(input.archivedIds)
  const placed = new Set(input.org.placements.map(placement => placement.sessionId))
  const known = new Set<string>()
  for (const id of input.ids) {
    const summary = input.summaryOf(id)
    if (summary === undefined || summary.origin === 'subagent' || archived.has(id)) continue
    if (summary.blank && id !== input.currentId && !placed.has(id)) continue
    known.add(id)
  }
  return known
}
