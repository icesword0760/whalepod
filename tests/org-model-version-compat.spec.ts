/**
 * S3b Task 11c review, D3: `MatouPlacement.parentSessionId` is optional and
 * purely additive — zod strips unknown keys by default, so a v0 document
 * (from before this field existed) already satisfies the current
 * (post-bump, "v1") `matouOrgStateSchema`/`matouOrgDocumentSchema` without
 * any transformation. This is the executable proof behind the policy
 * documented on `matouLayoutDomainSpec.version` in `src/org/spec.ts`:
 * additive/optional-field changes like this one never needed a version
 * bump in the first place, because there is nothing incompatible for a
 * migration to bridge.
 *
 * Deliberately builds the fixture as a raw untyped JSON value (not via
 * `MatouOrgDocument`/`MatouPlacement`) — this is meant to stand in for a
 * document actually read back off disk from before `parentSessionId`
 * existed, not a value the current TypeScript types would even let you
 * construct without it (the field being optional in the type is not, on
 * its own, proof that a value which never mentions it survives schema
 * validation and downstream use).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { matouOrgDocumentSchema, matouOrgStateSchema } from '../src/org/model.ts'
import type { MatouOrgState } from '../src/org/model.ts'
import { applyOrgOps } from '../src/org/ops.ts'
import { EMPTY_ORG_STATE } from '../src/org/model.ts'

/** A v0-shaped organization state: placements carry no `parentSessionId` field at all. */
const V0_STATE: unknown = {
  tasks: [
    { id: 't-1', workspaceId: 'ws-1', title: '修 bug', status: 'active', isPinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 },
  ],
  scenes: [
    { id: 'sc-1', taskId: 't-1', name: '排查', titlePinned: false, sortKey: 1, createdAt: 1, updatedAt: 1 },
  ],
  placements: [
    // No `parentSessionId` anywhere — exactly what every placement looked
    // like before Task 1 added the field.
    { sessionId: 's-a', taskId: 't-1', sceneId: 'sc-1', sortKey: 1, updatedAt: 1 },
    { sessionId: 's-b', taskId: 't-1', sceneId: 'sc-1', sortKey: 2, updatedAt: 1 },
  ],
}

const V0_DOCUMENT: unknown = { revision: 5, state: V0_STATE }

describe('v0 组织文档在当前（v1）schema 下无需迁移即可读入并正常使用（D3）', () => {
  it('matouOrgStateSchema 接受不带 parentSessionId 的 placements', () => {
    const parsed = matouOrgStateSchema.parse(V0_STATE)
    expect(parsed.placements).toHaveLength(2)
    for (const placement of parsed.placements) {
      expect(placement.parentSessionId).toBeUndefined()
    }
  })

  it('matouOrgDocumentSchema（存储域实际校验的顶层文档）接受整份 v0 文档', () => {
    const parsed = matouOrgDocumentSchema.parse(V0_DOCUMENT)
    expect(parsed).toEqual(V0_DOCUMENT)
  })

  it('v0 文档解析后的状态可以正常参与后续的组织操作（不只是"能过 schema"，是"能用"）', () => {
    const state = matouOrgStateSchema.parse(V0_STATE) as MatouOrgState
    // A brand-new placement carries `parentSessionId` (today's shape);
    // applying it against v0-shaped existing state must work exactly as it
    // would against any other state — no special-casing needed anywhere.
    const outcome = applyOrgOps(state, [
      { kind: 'placement/set', sessionId: 's-c', taskId: 't-1', sceneId: 'sc-1', parentSessionId: 's-a' },
    ], 100)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const added = outcome.state.placements.find(p => p.sessionId === 's-c')
    expect(added?.parentSessionId).toBe('s-a')
    // The pre-existing v0 placements are untouched by the parse round-trip.
    expect(outcome.state.placements.find(p => p.sessionId === 's-a')?.parentSessionId).toBeUndefined()
  })
})


/**
 * S3c Task 4: `relationKind` 是新加的可选字段。这条守的是「加字段不提版本」
 * 这个前提——一份没有该字段的旧文档必须原样读得出来，用户不会因为升级插件
 * 就打不开自己的组织数据。
 */
describe('relationKind 是可选字段：旧文档照常读出（S3c Task 4）', () => {
  it('没有 relationKind 的落位行原样通过校验，且字段仍然缺席', () => {
    const legacy = {
      revision: 7,
      state: {
        tasks: [],
        scenes: [],
        placements: [{ sessionId: 's', taskId: 't', sceneId: 'sc', parentSessionId: 'p', sortKey: 0, updatedAt: 1 }],
      },
    }
    const parsed = matouOrgDocumentSchema.parse(legacy)
    expect(parsed.state.placements[0]!.parentSessionId).toBe('p')
    expect('relationKind' in parsed.state.placements[0]!).toBe(false)
  })

  it('带 relationKind 的新文档也通过校验', () => {
    const modern = {
      revision: 8,
      state: {
        tasks: [],
        scenes: [],
        placements: [{
          sessionId: 's', taskId: 't', sceneId: 'sc', parentSessionId: 'p',
          relationKind: 'forked-from', sortKey: 0, updatedAt: 1,
        }],
      },
    }
    expect(matouOrgDocumentSchema.parse(modern).state.placements[0]!.relationKind).toBe('forked-from')
  })
})


/**
 * S3c 审查 I1：向前兼容也是不变式的一半。
 *
 * `src/org/spec.ts` 白纸黑字承诺「新文档被旧代码读到时只是无害地丢掉那个
 * 字段」。而该存储域**不支持迁移**：校验一失败，整个域打不开，唯一出路是
 * 删掉 `~/.dsh/storages/matou_layout.json`——用户的全部事项、页签、卡片
 * 布局一起没。
 *
 * 把 `parentSessionId` 的值域从 `string` 放宽到 `string | null` 会破掉这条
 * 承诺：旧 schema 是 `identifier.optional()`，见到 `null` 直接 reject。所以
 * 「显式在根层」这一态改用**追加的可选字段**承载——旧代码 strip 掉它、退回
 * 旧的回落行为（降级，不是打不开）。
 *
 * 这条用例把审查用的那个旧 schema 原样重建出来当护栏。
 */
describe('新文档必须能被旧代码读出（S3c 审查 I1）', () => {
  /** S3c 之前的落位 schema，逐字重建。 */
  const legacyPlacementSchema = z.object({
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    sceneId: z.string().min(1),
    parentSessionId: z.string().min(1).optional(),
    sortKey: z.number().finite(),
    updatedAt: z.number().int().nonnegative(),
  })

  it('「显式在根层」的落位行仍然通过旧 schema（只是丢掉那个标记）', () => {
    const created = applyOrgOps(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't', workspaceId: 'w', title: 'T' },
      { kind: 'scene/create', id: 'sc', taskId: 't', name: 'S' },
      { kind: 'placement/set', sessionId: 'E', taskId: 't', sceneId: 'sc', parentSessionId: null },
    ], 1_000)
    if (!created.ok) throw new Error(created.error.reason)
    const row = created.state.placements.find(p => p.sessionId === 'E')!

    // 关键：盘上不能出现 parentSessionId: null
    expect(row.parentSessionId).toBeUndefined()
    expect(() => legacyPlacementSchema.parse(row)).not.toThrow()
  })

  it('带关系种类的落位行也通过旧 schema（纯追加）', () => {
    const created = applyOrgOps(EMPTY_ORG_STATE, [
      { kind: 'task/create', id: 't', workspaceId: 'w', title: 'T' },
      { kind: 'scene/create', id: 'sc', taskId: 't', name: 'S' },
      { kind: 'placement/set', sessionId: 'B', taskId: 't', sceneId: 'sc', parentSessionId: 'A', relationKind: 'forked-from' },
    ], 1_000)
    if (!created.ok) throw new Error(created.error.reason)
    const row = created.state.placements.find(p => p.sessionId === 'B')!
    expect(() => legacyPlacementSchema.parse(row)).not.toThrow()
  })
})
