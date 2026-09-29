import { describe, expect, it } from 'vitest'
import { selectKnownSessionIds } from '../src/client/workbench/known-sessions.ts'

const rows: Record<string, { blank: boolean; origin?: 'subagent' }> = {
  's-live': { blank: false },
  's-blank': { blank: true },
  's-placed-blank': { blank: true },
  's-sub': { blank: false, origin: 'subagent' },
  's-archived': { blank: false },
}

function select(currentId: string | undefined) {
  return selectKnownSessionIds({
    ids: Object.keys(rows),
    summaryOf: id => rows[id],
    archivedIds: ['s-archived'],
    currentId,
    org: { placements: [{ sessionId: 's-placed-blank', taskId: 't', sceneId: 'sc', sortKey: 1, updatedAt: 1 }] },
  })
}

describe('selectKnownSessionIds', () => {
  it('drops subagent and archived rows, keeps live rows', () => {
    const known = select(undefined)
    expect(known.has('s-live')).toBe(true)
    expect(known.has('s-sub')).toBe(false)
    expect(known.has('s-archived')).toBe(false)
  })

  it('hides an unplaced blank session unless it is current', () => {
    expect(select(undefined).has('s-blank')).toBe(false)
    expect(select('s-blank').has('s-blank')).toBe(true)
  })

  it('keeps a placed blank session visible even when it is not current', () => {
    expect(select(undefined).has('s-placed-blank')).toBe(true)
  })
})
