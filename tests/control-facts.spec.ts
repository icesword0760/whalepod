/**
 * S7 Task 7 — the host fact adapter, this slice's ONLY IO convergence point.
 *
 * Three sources meet here and nowhere else: DSH's `sessionController.list()`,
 * DSH's `workspaceRegistry` (order + archive set), and this plugin's own
 * organization document. The tests below pin the three joins that can silently
 * go wrong — the workspace entity's `id`/`workspaceId` rename, the title
 * fallback chain, and the subagent set that must NOT become an addressable
 * card — plus the two failure shapes a model would otherwise see raw: a
 * not-yet-open storage domain and an already-aborted call.
 */
import { describe, expect, it, vi } from 'vitest'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { readWorkbenchFacts } from '../src/control/facts.ts'
import type { HostSessionSummary, WorkbenchFactsHost, WorkbenchOrgSource } from '../src/control/facts.ts'
import { projectControlTargets } from '../src/control/topology.ts'
import type { ControlSessionFacts, ControlTarget } from '../src/control/topology.ts'
import { EMPTY_ORG_STATE } from '../src/org/model.ts'
import type { MatouOrgState } from '../src/org/model.ts'

const WORKSPACE_ID = 'ws1'
const WORKSPACE_TITLE = '工作区一'

/**
 * The rows `SessionController.list()` would return
 * (`packages/api/session-controller/src/types.ts:155-165`). The recency values
 * disagree with the workspace's manual order on purpose: the expected layer is
 * `b` before `a`, so an adapter that just forwarded the workspace order — or
 * dropped `updatedAt` on the way through — fails loudly.
 */
const SUMMARIES: readonly HostSessionSummary[] = [
  {
    sessionId: 'a',
    updatedAt: 100,
    running: true,
    blank: false,
    cwd: '/repo/a',
    projections: { asOfSeq: 7, values: { title: 'Alpha' } },
  },
  // No `projections` at all: the deployment may not compose `session-title`.
  { sessionId: 'b', updatedAt: 300, running: false, blank: false },
  // DSH's own parent link, with no placement to override it → child of `a`.
  {
    sessionId: 'c',
    updatedAt: 200,
    running: false,
    blank: false,
    parentSessionId: 'a',
    projections: { asOfSeq: 9, values: { title: 'Cee' } },
  },
  // Highest recency of all, and yet it must never be an addressable card.
  {
    sessionId: 'sub1',
    updatedAt: 999,
    running: true,
    blank: false,
    origin: 'subagent',
    parentSessionId: 'a',
    projections: { asOfSeq: 3, values: { title: 'Subagent' } },
  },
  { sessionId: 'arch1', updatedAt: 800, running: false, blank: false },
]

const WORKSPACE_SESSION_IDS: readonly string[] = ['a', 'b', 'c', 'sub1', 'arch1']
const ARCHIVED: readonly string[] = ['arch1']

/** The same three sources, restated as Task 2's own input, to compare against. */
const EXPECTED_FACTS: Record<string, ControlSessionFacts> = {
  a: { updatedAt: 100, running: true, blank: false, cwd: '/repo/a', title: 'Alpha' },
  // 没有投影标题、也没有 cwd —— 三级回落的最后一级是会话 id（S7 审查 E13）
  b: { updatedAt: 300, running: false, blank: false, title: 'b' },
  c: { updatedAt: 200, running: false, blank: false, parentId: 'a', title: 'Cee' },
  sub1: { updatedAt: 999, running: true, blank: false, origin: 'subagent', parentId: 'a', title: 'Subagent' },
  arch1: { updatedAt: 800, running: false, blank: false, title: 'arch1' },
}

interface FakeHost extends WorkbenchFactsHost {
  readonly listCalls: { readonly request: unknown; readonly signal: AbortSignal }[]
  readonly archiveReads: { count: number }
}

interface HostOptions {
  readonly summaries?: readonly HostSessionSummary[]
  readonly sessionIds?: readonly string[]
  readonly archivedSessionIds?: readonly string[]
  readonly workspaceTitle?: string
}

function fakeHost(options: HostOptions = {}): FakeHost {
  const listCalls: { request: unknown; signal: AbortSignal }[] = []
  const archiveReads = { count: 0 }
  const summaries = options.summaries ?? SUMMARIES
  return {
    listCalls,
    archiveReads,
    sessionController: {
      list(request, signal) {
        listCalls.push({ request, signal })
        return Promise.resolve({ items: summaries })
      },
    },
    workspaceRegistry: {
      list() {
        // DSH's `Workspace` entity names the field `id`, not `workspaceId`
        // (`packages/workspace/workspace/src/entity.ts:79`, `:89`, `:101`).
        return [{
          id: WORKSPACE_ID,
          title: options.workspaceTitle ?? WORKSPACE_TITLE,
          sessionIds: options.sessionIds ?? WORKSPACE_SESSION_IDS,
        }]
      },
      get archivedSessionIds() {
        archiveReads.count += 1
        return options.archivedSessionIds ?? ARCHIVED
      },
    },
  }
}

function fakeService(state: MatouOrgState = EMPTY_ORG_STATE): WorkbenchOrgSource {
  return { snapshot: () => Promise.resolve({ revision: 3, state }) }
}

function idsOf(targets: readonly ControlTarget[]): string[] {
  return targets.map(target => target.sessionId)
}

function targetOf(targets: readonly ControlTarget[], sessionId: string): ControlTarget {
  const found = targets.find(target => target.sessionId === sessionId)
  if (found === undefined) throw new Error(`no target for ${sessionId}`)
  return found
}

describe('readWorkbenchFacts', () => {
  it('joins the three host sources into exactly the projection Task 2 would build', async () => {
    const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)

    const expected = projectControlTargets({
      workspaces: [{ workspaceId: WORKSPACE_ID, title: WORKSPACE_TITLE, sessionIds: WORKSPACE_SESSION_IDS }],
      summaryOf: (id: string) => EXPECTED_FACTS[id],
      archivedSessionIds: ARCHIVED,
      org: EMPTY_ORG_STATE,
    })
    expect(facts.targets).toEqual(expected)
    // Recency order, not workspace order: `b` (300) outranks `a` (100), and
    // `c` is one layer down under `a`.
    expect(idsOf(facts.targets)).toEqual(['b', 'a', 'c'])
    expect(targetOf(facts.targets, 'c').parentRef).toBe('session:a')
  })

  it('renames the workspace entity field and carries its title and order through', async () => {
    const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)

    const target = targetOf(facts.targets, 'b')
    expect(target.workspace).toEqual({ id: WORKSPACE_ID, title: WORKSPACE_TITLE, ordinal: 1 })
  })

  it('reads the archive set from the registry getter so archived cards never project', async () => {
    const host = fakeHost()
    const facts = await readWorkbenchFacts(host, fakeService(), new AbortController().signal)

    expect(host.archiveReads.count).toBeGreaterThan(0)
    expect(idsOf(facts.targets)).not.toContain('arch1')
  })

  it('passes the caller signal and an empty list request straight to sessionController.list', async () => {
    const host = fakeHost()
    const signal = new AbortController().signal

    await readWorkbenchFacts(host, fakeService(), signal)

    expect(host.listCalls).toHaveLength(1)
    expect(host.listCalls[0]?.signal).toBe(signal)
    expect(host.listCalls[0]?.request).toEqual({})
  })

  describe('title fallback', () => {
    it('prefers the session-title projection value', async () => {
      const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)
      expect(targetOf(facts.targets, 'a').title).toBe('Alpha')
    })

    /**
     * S7 审查 E13 之前，这条断言的是四个空串——那锁住的正是要修的行为：
     * 投影标题拿不到就交白卷，而用户屏幕上那时显示的是目录名或会话 id。
     * 现在断言三级回落的最后一级（这四条都没有 cwd，所以落到会话 id）。
     */
    it('投影标题缺席/为 null/类型不对时，回落到目录名或会话 id（不是空串）', async () => {
      const summaries: readonly HostSessionSummary[] = [
        { sessionId: 'noProjections', updatedAt: 4, running: false, blank: false },
        { sessionId: 'noKey', updatedAt: 3, running: false, blank: false, projections: { asOfSeq: 1, values: {} } },
        {
          sessionId: 'nullTitle',
          updatedAt: 2,
          running: false,
          blank: false,
          // `title` is `string | null` before the first title lands
          // (`packages/session/session-title/src/types.ts:86-96`).
          projections: { asOfSeq: 1, values: { title: null } },
        },
        {
          sessionId: 'wrongType',
          updatedAt: 1,
          running: false,
          blank: false,
          // `values` is an open JSON record, so a non-string is representable.
          projections: { asOfSeq: 1, values: { title: 42 } },
        },
      ]
      const ids = summaries.map(summary => summary.sessionId)

      const facts = await readWorkbenchFacts(
        fakeHost({ summaries, sessionIds: ids, archivedSessionIds: [] }),
        fakeService(),
        new AbortController().signal,
      )

      expect(facts.targets.map(target => target.title)).toEqual(ids)
      expect(idsOf(facts.targets)).toEqual(ids)
    })
  })

  describe('cwd', () => {
    it('carries a present cwd onto the target', async () => {
      const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)
      expect(targetOf(facts.targets, 'a').cwd).toBe('/repo/a')
    })

    it('omits the key entirely when the header has no cwd', async () => {
      const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)
      // `session.header.cwd` is optional in DSH
      // (`packages/core/session/src/types.ts:92-130`); an `undefined` VALUE
      // would leak into every tool payload, so the key must be absent.
      expect(Object.hasOwn(targetOf(facts.targets, 'b'), 'cwd')).toBe(false)
    })
  })

  describe('subagent sessions', () => {
    it('reports them as a separate set, never as addressable cards', async () => {
      const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)

      expect([...facts.subagentSessionIds]).toEqual(['sub1'])
      expect(idsOf(facts.targets)).not.toContain('sub1')
    })

    it('collects them from the whole session list, not just placed sessions', async () => {
      const summaries: readonly HostSessionSummary[] = [
        { sessionId: 'root', updatedAt: 2, running: false, blank: false },
        { sessionId: 'loose-sub', updatedAt: 1, running: false, blank: false, origin: 'subagent' },
      ]

      const facts = await readWorkbenchFacts(
        // `loose-sub` is in NO workspace, so a set built from the workspace
        // rosters would miss it — and a bare-id caller would then be told
        // "not in this workbench" instead of "that is a subagent child".
        fakeHost({ summaries, sessionIds: ['root'], archivedSessionIds: [] }),
        fakeService(),
        new AbortController().signal,
      )

      expect(facts.subagentSessionIds.has('loose-sub')).toBe(true)
      expect(idsOf(facts.targets)).toEqual(['root'])
    })
  })

  it('exposes the raw summaries so the reading tools need no second list call', async () => {
    const facts = await readWorkbenchFacts(fakeHost(), fakeService(), new AbortController().signal)

    expect(facts.summaryOf('a')?.projections?.asOfSeq).toBe(7)
    expect(facts.summaryOf('nobody')).toBeUndefined()
  })

  it('re-reads every source on every call so an ordinal can never be resolved against a stale layer', async () => {
    let summaries: readonly HostSessionSummary[] = SUMMARIES
    const host: WorkbenchFactsHost = {
      sessionController: { list: () => Promise.resolve({ items: summaries }) },
      workspaceRegistry: {
        list: () => [{ id: WORKSPACE_ID, title: WORKSPACE_TITLE, sessionIds: WORKSPACE_SESSION_IDS }],
        archivedSessionIds: ARCHIVED,
      },
    }
    const service = fakeService()

    const first = await readWorkbenchFacts(host, service, new AbortController().signal)
    expect(idsOf(first.targets)).toEqual(['b', 'a', 'c'])

    summaries = SUMMARIES.map(summary => (summary.sessionId === 'a' ? { ...summary, updatedAt: 5000 } : summary))
    const second = await readWorkbenchFacts(host, service, new AbortController().signal)

    expect(idsOf(second.targets)).toEqual(['a', 'b', 'c'])
  })

  describe('failures', () => {
    it('turns an unopened organization document into WORKBENCH_NOT_READY without leaking the internal message', async () => {
      const internal = 'matou-layout: durable domain is not initialized'
      const service: WorkbenchOrgSource = { snapshot: () => Promise.reject(new Error(internal)) }

      const error = await readWorkbenchFacts(fakeHost(), service, new AbortController().signal)
        .then(() => undefined, (caught: unknown) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as { code?: unknown }).code).toBe('WORKBENCH_NOT_READY')
      expect((error as Error).message).toMatch(/^WORKBENCH_NOT_READY: /)
      expect((error as Error).message).not.toContain(internal)
      // Kept for the host log, out of the sentence the model reads.
      expect((error as Error).cause).toBeInstanceOf(Error)
    })

    it('translates a synchronously thrown snapshot the same way', async () => {
      const service = {
        snapshot: () => {
          throw new Error('domain closed')
        },
      } as unknown as WorkbenchOrgSource

      const error = await readWorkbenchFacts(fakeHost(), service, new AbortController().signal)
        .then(() => undefined, (caught: unknown) => caught)

      expect((error as { code?: unknown }).code).toBe('WORKBENCH_NOT_READY')
    })

    it('does not start any host read when the signal is already aborted', async () => {
      const host = fakeHost()
      const snapshot = vi.fn(() => Promise.resolve({ revision: 0, state: EMPTY_ORG_STATE }))
      const controller = new AbortController()
      controller.abort()

      const error = await readWorkbenchFacts(host, { snapshot }, controller.signal)
        .then(() => undefined, (caught: unknown) => caught)

      expect(error).toBeInstanceOf(Error)
      // Cancellation is DSH's own; it must NOT be dressed up as a control error.
      expect((error as { code?: unknown }).code).not.toBe('WORKBENCH_NOT_READY')
      expect(host.listCalls).toHaveLength(0)
      expect(snapshot).not.toHaveBeenCalled()
    })
  })
})


/**
 * S7 审查 E13：控制面报给模型的卡片标题，必须与用户屏幕上看到的是同一个。
 *
 * 用户屏幕上的标题来自 DSH 客户端的 `displayTitle`，它有**三级回落**：
 * 持久标题 → 工作目录的末段名 → 会话 id
 * （`api/session-controller/src/client/sessions/service.ts:148-155`）。
 * 宿主侧此前只认第一级，缺了后两级。
 *
 * 后果不是「功能坏了」而是「AI 认不出用户说的是哪张卡」：两张还没生成标题
 * 的卡在屏幕上显示成 `dsh-plug` 和 `deepseek-harness`（目录名），用户说
 * 「告诉 deepseek-harness 那张……」，模型 list 回来却是两行空标题，对不上。
 * 这种情形不只是「标题生成前的一瞬间」——标题模型不可用、或部署没挂标题
 * 生成组合时，它是**永久**的。
 *
 * 所以这里不重写一遍末段名算法，而是 import DSH 自己那份
 * （`workspaceTitleOf`）：两份实现必然漂移，而漂移在这里没有任何症状能
 * 提醒人。
 */
describe('readWorkbenchFacts — 标题与用户看到的同源（S7 审查 E13）', () => {
  /** 逐字镜像 DSH 客户端的 displayTitleOf，用来对拍。 */
  const clientDisplayTitle = (title: string | undefined, cwd: string | undefined, id: string): string => {
    if (title !== undefined) return title
    if (cwd !== undefined && cwd !== '') {
      const base = workspaceTitleOf(cwd)
      if (base !== '') return base
    }
    return id
  }

  const CASES: readonly { id: string; title?: string; cwd?: string; expected: string }[] = [
    { id: 's-1', title: 'Alpha', cwd: '/home/u/proj', expected: 'Alpha' },
    // 没有标题：落到目录末段名 —— 这正是用户屏幕上看到的字
    { id: 's-2', cwd: '/Users/example/Documents/AIProjects/dsh-plug', expected: 'dsh-plug' },
    // 末尾有斜杠也要正确取末段（DSH 的 workspaceTitleOf 先剪尾斜杠）
    { id: 's-3', cwd: '/home/u/deepseek-harness/', expected: 'deepseek-harness' },
    // Windows 分隔符
    { id: 's-4', cwd: 'C:\\work\\thing', expected: 'thing' },
    // 目录也没有：落到会话 id
    { id: 's-5', expected: 's-5' },
    // 目录是空串：等同没有
    { id: 's-6', cwd: '', expected: 's-6' },
    // 目录是根：末段为空，继续落到 id
    { id: 's-7', cwd: '/', expected: 's-7' },
  ]

  it.each(CASES)('$id 的标题走完三级回落，且与客户端逐字相同', async ({ id, title, cwd, expected }) => {
    const host = fakeHost({
      summaries: [{
        sessionId: id as never, updatedAt: 1, running: false, blank: false,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { projections: { asOfSeq: 1, values: { title } } }),
      }],
      sessionIds: [id],
    })
    const facts = await readWorkbenchFacts(host, fakeService(), new AbortController().signal)
    const card = facts.targets.find(target => target.sessionId === id)
    expect(card?.title).toBe(expected)
    // 同源断言：宿主算出来的，必须等于客户端对同一行算出来的
    expect(card?.title).toBe(clientDisplayTitle(title, cwd, id))
  })
})
