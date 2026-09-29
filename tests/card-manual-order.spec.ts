import { describe, expect, it } from 'vitest'
import { applyOrgOps } from '../src/org/ops.ts'
import { EMPTY_ORG_STATE, matouOrgStateSchema } from '../src/org/model.ts'
import { matouOrgOpSchema } from '../src/org/wire-schemas.ts'
import { childrenOfLevel } from '../src/client/carousel/graph.ts'
import { placementsBySessionOf, projectCarouselNodes } from '../src/client/carousel/nodes.ts'

it('manual ranks cross the wire, survive reload, and outrank new messages', () => {
  const result = applyOrgOps(EMPTY_ORG_STATE, [
    { kind: 'task/create', id: 't', workspaceId: 'w', title: 'T' },
    { kind: 'scene/create', id: 's', taskId: 't', name: 'S' },
    ...['a', 'b'].map(sessionId => ({ kind: 'placement/set' as const, sessionId, taskId: 't', sceneId: 's' })),
    matouOrgOpSchema.parse({ kind: 'placement/order', sessionId: 'b', order: 0 }),
    matouOrgOpSchema.parse({ kind: 'placement/order', sessionId: 'a', order: 1 }),
    { kind: 'placement/interaction', sessionId: 'a', at: 999999 },
  ], 1)
  if (!result.ok) throw Error(JSON.stringify(result))
  const state = matouOrgStateSchema.parse(JSON.parse(JSON.stringify(result.state)))
  const nodes = projectCarouselNodes({
    ids: ['a', 'b'], summaryOf: () => ({ blank: false }), placementsBySession: placementsBySessionOf(state.placements),
    interactionAtOf: id => state.placements.find(row => row.sessionId === id)?.interactionAt,
    manualOrderOf: id => state.placements.find(row => row.sessionId === id)?.manualOrder,
  })
  expect(childrenOfLevel(nodes, undefined).map(node => node.sessionId)).toEqual(['b', 'a'])
})

describe('manual order validation', () => {
  it.each([-1, 0.5, Infinity])('rejects invalid rank %s', order => {
    expect(() => matouOrgOpSchema.parse({ kind: 'placement/order', sessionId: 'a', order })).toThrow()
  })
})
