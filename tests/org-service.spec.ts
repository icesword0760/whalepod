import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import MatouLayoutService from '../src/index.ts'
import type { MatouOrgOp } from '../src/org/ops.ts'

interface Scaffold {
  readonly ctx: Context
  readonly service: MatouLayoutService
  readonly root: string
  dispose(): Promise<void>
}

const cleanups: (() => Promise<void>)[] = []

async function scaffold(root?: string): Promise<Scaffold> {
  const storageRoot = root ?? await mkdtemp(join(tmpdir(), 'matou-layout-test-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MatouLayoutService)
  const built: Scaffold = {
    ctx,
    service: ctx.get('matouLayout') as MatouLayoutService,
    root: storageRoot,
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
  cleanups.push(async () => {
    await built.dispose()
    await rm(storageRoot, { recursive: true, force: true })
  })
  return built
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const SEED_OPS: readonly MatouOrgOp[] = [
  { kind: 'task/create', id: 't-1', workspaceId: 'ws-1', title: '修 bug' },
  { kind: 'scene/create', id: 'sc-1', taskId: 't-1', name: '排查' },
  { kind: 'placement/set', sessionId: 's-a', taskId: 't-1', sceneId: 'sc-1' },
]

describe('MatouLayoutService', () => {
  it('serves an empty revision-0 snapshot without writing', async () => {
    const { service } = await scaffold()
    const snapshot = await service.snapshot()
    expect(snapshot).toEqual({ revision: 0, state: { tasks: [], scenes: [], placements: [] } })
  })

  it('applies a batch and round-trips it through snapshot', async () => {
    const { service } = await scaffold()
    const result = await service.apply({ expectedRevision: 0, ops: SEED_OPS })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.revision).toBe(1)
    expect(result.value.state.tasks[0]).toMatchObject({ id: 't-1', title: '修 bug' })
    expect(await service.snapshot()).toEqual(result.value)
  })

  /**
   * 2026-09-14 桌面端走查：用户点「新会话」永远建不出来。
   *
   * 宿主有意让某些 op 在条件不满足时静默忽略——`placement/interaction` 落在一个尚未
   * 落位的会话上就什么都不做（`org/ops.ts`：为一次时序竞争拒掉整批，会连带丢掉同批
   * 里其他卡的排序键）。但那样的批次如果照样把 revision 加一，发起方就会看到「文档
   * 变了」→ 重新求值 → 发现自己要的效果仍未出现 → 再写一次 → 无限循环，并且把**所有
   * 其他写入挤掉**（新会话的 `placement/set` 每一次含重试都撞冲突）。
   *
   * 这条闸门让那类循环第一轮就停：**没改变任何状态的批次不推进 revision**。
   */
  it('批次没改变任何状态时不推进 revision（否则被静默忽略的 op 会烧出无限重写循环）', async () => {
    const { service } = await scaffold()
    const seeded = await service.apply({ expectedRevision: 0, ops: SEED_OPS })
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    const before = seeded.value.revision

    // 这个会话没有落位行 —— 宿主会静默忽略它。
    const noop = await service.apply({
      expectedRevision: before,
      ops: [{ kind: 'placement/interaction', sessionId: '从未落位的会话', at: 1234 }],
    })
    expect(noop.ok).toBe(true)
    if (!noop.ok) return
    expect(noop.value.revision).toBe(before)
    expect((await service.snapshot()).revision).toBe(before)

    // 而且原来的 expectedRevision 依然有效：别人的写入不会被这次空转挤掉。
    const next = await service.apply({
      expectedRevision: before,
      ops: [{ kind: 'scene/create', id: 'sc-2', taskId: 't-1', name: '第二个页签' }],
    })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.revision).toBe(before + 1)
  })

  it('rejects a stale revision and hands back the current document', async () => {
    const { service } = await scaffold()
    await service.apply({ expectedRevision: 0, ops: SEED_OPS })
    const stale = await service.apply({
      expectedRevision: 0,
      ops: [{ kind: 'task/create', id: 't-2', workspaceId: 'ws-1', title: 'X' }],
    })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error).toMatchObject({ code: 'revision-conflict', revision: 1 })
    if (stale.error.code !== 'revision-conflict') return
    expect(stale.error.state.tasks.map(task => task.id)).toEqual(['t-1'])
  })

  it('keeps the stored document untouched when a batch is invalid', async () => {
    const { service } = await scaffold()
    await service.apply({ expectedRevision: 0, ops: SEED_OPS })
    const bad = await service.apply({
      expectedRevision: 1,
      ops: [
        { kind: 'task/create', id: 't-2', workspaceId: 'ws-1', title: 'ok' },
        { kind: 'scene/create', id: 'sc-9', taskId: 'missing', name: 'X' },
      ],
    })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toMatchObject({ code: 'invalid-op', index: 1 })
    const snapshot = await service.snapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.state.tasks.map(task => task.id)).toEqual(['t-1'])
  })

  it('persists across a service restart on the same root', async () => {
    const first = await scaffold()
    await first.service.apply({ expectedRevision: 0, ops: SEED_OPS })
    const root = first.root
    await first.dispose()

    const second = await scaffold(root)
    const snapshot = await second.service.snapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.state.placements[0]).toMatchObject({ sessionId: 's-a' })
  })

  it('serializes concurrent applies: the loser sees a revision conflict', async () => {
    const { service } = await scaffold()
    const [left, right] = await Promise.all([
      service.apply({
        expectedRevision: 0,
        ops: [{ kind: 'task/create', id: 't-l', workspaceId: 'ws-1', title: 'L' }],
      }),
      service.apply({
        expectedRevision: 0,
        ops: [{ kind: 'task/create', id: 't-r', workspaceId: 'ws-1', title: 'R' }],
      }),
    ])
    const outcomes = [left, right]
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1)
    const loser = outcomes.find(outcome => !outcome.ok)
    expect(loser).toBeDefined()
    if (loser === undefined || loser.ok) return
    expect(loser.error.code).toBe('revision-conflict')
    const snapshot = await service.snapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.state.tasks).toHaveLength(1)
  })
})
