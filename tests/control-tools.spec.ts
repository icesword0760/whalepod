/**
 * S7 Task 8 — the six `matou_*` session-control tools.
 *
 * What these tests are actually guarding, in order of how badly each would hurt:
 *
 * 1. **The names.** `send_message` / `interrupt_agent` exist in every agent
 *    preset (`packages/subagent/tool-subagent-control/src/index.ts:29`, `:77`,
 *    mounted at `packages/preset/agent-presets/presets/standard/agent.cordis.yml:174-178`).
 *    A host-row registration under either name is NOT a collision error — the
 *    scope layer wins by `Map.set` (`packages/core/tools/src/index.ts:1143-1184`)
 *    — so the plugin's tools would simply vanish with no error and no log. Only
 *    `run_code` throws (`:1045-1047`). Hence the `matou_` prefix, asserted here.
 * 2. **The three honest branches** around the subagent hole: a subagent target,
 *    a subagent caller, and the `session/agent-busy` a RemoteError carries when
 *    the first two miss.
 * 3. **The ordinal contract**: `matou_identify_self` hands out a
 *    `topology_revision` that must equal what `resolve.ts` recomputes, or every
 *    `sibling:N` call fails as stale.
 *
 * The host is a hand-written literal rather than a cordis context: these are
 * unit tests of the tool bodies, and `tests/package-contract.spec.ts` already
 * covers the wiring.
 */
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HostSessionSummary, HostWorkspace, WorkbenchOrgSource } from '../src/control/facts.ts'
import { CONTROL_TOOL_NAMES, createControlTools, registerControlTools } from '../src/control/tools.ts'
import type { ControlObservation, ControlPromptRequest, ControlToolsHost } from '../src/control/tools.ts'
import { topologyRevision } from '../src/control/revision.ts'
import { EMPTY_ORG_STATE } from '../src/org/model.ts'

const CALLER = 'caller'

/**
 * Names this plugin must never take. The first two are the ones that would be
 * silently shadowed; the rest are already-registered first-party names whose
 * duplicate would throw at load (`packages/core/tools/src/index.ts:718-722`,
 * `packages/session-query/tool-session-query/src/index.ts:66-121`), plus the
 * unconditionally reserved PTC transport name (`:1045-1047`).
 */
const FORBIDDEN_NAMES: readonly string[] = [
  'send_message',
  'interrupt_agent',
  'list_agents',
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  'run_code',
]

/**
 * One workbench: three root cards and one child of the caller, plus a subagent
 * child that must never become addressable. `updatedAt` disagrees with the
 * workspace's manual order on purpose, so the expected layer is
 * left-card → caller → right-card by recency and nothing else.
 */
const SUMMARIES: readonly HostSessionSummary[] = [
  {
    sessionId: 'left-card',
    updatedAt: 400,
    running: false,
    blank: false,
    cwd: '/repo/left',
    projections: { asOfSeq: 4, values: { title: 'Left card' } },
  },
  {
    sessionId: CALLER,
    updatedAt: 300,
    running: true,
    blank: false,
    cwd: '/repo/caller',
    projections: { asOfSeq: 9, values: { title: 'Caller card' } },
  },
  // No `cwd` and no turn outline: both optional-field branches live on this row.
  {
    sessionId: 'right-card',
    updatedAt: 200,
    running: true,
    blank: false,
    projections: {
      asOfSeq: 11,
      values: {
        title: 'Right card',
        turnOutline: [
          { turn: 1, seq: 2, prompt: 'first ask', response: 'first answer' },
          { turn: 2, seq: 9, prompt: 'second ask', response: 'second answer' },
          { turn: 3, seq: 20, prompt: 'third ask', response: '' },
        ],
      },
    },
  },
  {
    sessionId: 'child1',
    updatedAt: 100,
    running: false,
    blank: false,
    parentSessionId: CALLER,
    projections: { asOfSeq: 2, values: { title: 'Child card' } },
  },
  // Highest recency in the workbench, and still unaddressable.
  {
    sessionId: 'sub1',
    updatedAt: 900,
    running: true,
    blank: false,
    origin: 'subagent',
    parentSessionId: CALLER,
    projections: { asOfSeq: 3, values: { title: 'Subagent child' } },
  },
]

const WORKSPACES: readonly HostWorkspace[] = [{
  id: 'ws1',
  title: 'Workspace One',
  sessionIds: ['left-card', CALLER, 'right-card', 'child1', 'sub1'],
}]

/**
 * The revision the caller's own two ordinal-indexed sets hash to. Written as
 * literal refs rather than derived from the projection so that a change in the
 * layer's ORDER fails this file, not just `control-topology.spec.ts`.
 */
const EXPECTED_REVISION = topologyRevision(
  ['session:left-card', 'session:caller', 'session:right-card'],
  ['session:child1'],
)

/** The path every card in this fixture sits at (the virtual 默认 task and scene). */
const FIXTURE_PATH = 'Workspace One / 默认 / 默认'

const HISTORY_EVENTS = [
  { seq: 1, type: 'session/start', data: {} },
  { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'ping' }] } },
  { seq: 3, type: 'assistant/chunk', data: { text: 'ignored' } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'pong' }] } } },
]

interface HostOptions {
  readonly summaries?: readonly HostSessionSummary[]
  readonly liveAgentIds?: readonly string[]
  /** Omit the whole agent registry, as a deployment without `dsh-agent` would. */
  readonly withoutAgents?: true
  readonly promptError?: unknown
  readonly cancelError?: unknown
  readonly snapshotError?: unknown
  readonly events?: readonly { seq: number; type: string; data: unknown }[]
}

interface FakeHost extends ControlToolsHost {
  readonly registered: ToolDefinition[]
  readonly promptCalls: { request: ControlPromptRequest; signal: AbortSignal }[]
  readonly cancelCalls: { sessionId: string }[]
  readonly observeCalls: { sessionId: string; signal: AbortSignal | undefined; projectionMode: string | undefined }[]
  readonly disposals: { count: number }
}

/**
 * A structural `RemoteError`, built the way the Gateway's own detector reads it
 * (`packages/typert/protocol/src/remote-error.ts:41-47`): the marker plus a
 * string `code`, never `instanceof`. Building it by hand rather than importing
 * the class is the point — the translation must survive a cross-bundle copy.
 * @param code - the stable failure code.
 * @param message - the diagnostic DSH would carry.
 * @returns an error indistinguishable from a real one to `remoteErrorOf`.
 */
function remoteError(code: string, message: string): Error {
  const error = new Error(message) as Error & { isDSHRemoteError: true; code: string; details: unknown }
  error.name = 'RemoteError'
  error.isDSHRemoteError = true
  error.code = code
  error.details = {}
  return error
}

function fakeHost(options: HostOptions = {}): FakeHost {
  const registered: ToolDefinition[] = []
  const promptCalls: { request: ControlPromptRequest; signal: AbortSignal }[] = []
  const cancelCalls: { sessionId: string }[] = []
  const observeCalls: { sessionId: string; signal: AbortSignal | undefined; projectionMode: string | undefined }[] = []
  const disposals = { count: 0 }
  const liveAgentIds = new Set(options.liveAgentIds ?? [CALLER, 'left-card', 'right-card', 'child1'])
  const events = options.events ?? HISTORY_EVENTS
  const observation = {
    events,
    cursor: events.at(-1)?.seq ?? -1,
    [Symbol.dispose]: () => { disposals.count += 1 },
  } as unknown as ControlObservation
  return {
    registered,
    promptCalls,
    cancelCalls,
    observeCalls,
    disposals,
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition)
        return () => {}
      },
    },
    sessionController: {
      list(_request, _signal) {
        return Promise.resolve({ items: options.summaries ?? SUMMARIES })
      },
      prompt(request, signal) {
        promptCalls.push({ request, signal })
        if (options.promptError !== undefined) return Promise.reject(options.promptError)
        return Promise.resolve({ accepted: true } as const)
      },
      cancel(request) {
        cancelCalls.push({ sessionId: request.sessionId })
        if (options.cancelError !== undefined) throw options.cancelError
        return { accepted: true } as const
      },
    },
    workspaceRegistry: {
      list: () => WORKSPACES,
      archivedSessionIds: [],
    },
    sessionQuery: {
      observeSession(sessionId, observeOptions) {
        observeCalls.push({
          sessionId,
          signal: observeOptions.signal,
          projectionMode: observeOptions.projectionMode,
        })
        return Promise.resolve(observation)
      },
    },
    get(_name: 'agents') {
      if (options.withoutAgents === true) return undefined
      return { get: (sessionId: string) => (liveAgentIds.has(sessionId) ? { id: sessionId } : undefined) }
    },
  }
}

function fakeService(options: HostOptions = {}): WorkbenchOrgSource {
  return {
    snapshot() {
      if (options.snapshotError !== undefined) return Promise.reject(options.snapshotError)
      return Promise.resolve({ revision: 1, state: EMPTY_ORG_STATE })
    },
  }
}

interface ExecOptions {
  readonly sessionId?: string
  readonly cwd?: string
  readonly signal?: AbortSignal
  /** DSH types `exec.agent` as optional; this drops it (`packages/core/tools/src/index.ts:318`). */
  readonly withoutAgent?: true
}

/**
 * The slice of `ToolRunContext` these tools read: the calling agent's session
 * identity and header, plus the caller's cancellation signal.
 * @param options - who is calling and with what signal.
 * @returns an execution context accepted by a tool body.
 */
function fakeExec(options: ExecOptions = {}): ToolRunContext {
  const sessionId = options.sessionId ?? CALLER
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: { id: sessionId, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
    },
  }
  return {
    ...(options.withoutAgent === true ? {} : { agent }),
    signal: options.signal ?? new AbortController().signal,
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'matou-test',
    arguments: {},
    token: Symbol('exec'),
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

/**
 * Build the six tools against one fake host and index them by name.
 * @param options - host behaviour for this case.
 * @returns the host (for its recorders) and a lookup by tool name.
 */
function harness(options: HostOptions = {}): { host: FakeHost; tool: (name: string) => ToolDefinition } {
  const host = fakeHost(options)
  const definitions = createControlTools(host, fakeService(options))
  const byName = new Map(definitions.map(definition => [definition.name, definition]))
  return {
    host,
    tool(name: string) {
      const definition = byName.get(name)
      if (definition === undefined) throw new Error(`no such tool: ${name}`)
      return definition
    },
  }
}

/**
 * Run one tool the way the registry would, and return its canonical value.
 *
 * `defineTool` validates arguments but NOT the returned value — the registry
 * does that, at `packages/core/tools/src/index.ts:1786`, and then renders it.
 * Both steps are replayed here so a payload that violates its own
 * `additionalProperties: false` schema, or a `render` that trips over an
 * omitted optional field, fails in this file instead of in production.
 * @param definition - the tool.
 * @param args - model arguments.
 * @param exec - the calling context.
 * @returns the tool's value.
 */
async function run(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  exec: ToolRunContext = fakeExec(),
): Promise<Record<string, any>> {
  const value = await definition.execute(args, exec) as Record<string, any>
  expect(
    validateJsonSchemaValue(definition.output.schema, value, 'value'),
    `${definition.name} returned a value its own output schema rejects`,
  ).toEqual([])
  const blocks = definition.output.render(args, value as never)
  expect(blocks.length).toBeGreaterThan(0)
  // 第三轮活体走查（2026-09-07）之后加的闸门。`output.render` 产出的**就是模型
  // 读到的内容**（DSH `core/tools/src/schema.ts:494`、`index.ts:284`），而
  // `execute()` 那个 value 模型根本看不到——本文件此前所有内容断言都打在 value
  // 上，render 只断言了「非空」，于是四个工具长期只向模型吐一行计数（列不出旁边
  // 有哪些卡、读不到任何消息、拿不到 topology_revision），35 条全绿。
  //
  // 这条不变式是通用的：**value 里点名了哪张卡，渲染文本就必须把那张卡的 ref 说
  // 出来**。它拦得住「把载荷折成一句摘要」这整类写法，而不必逐工具重复断言。
  const rendered = blocks.map(b => (b as { text?: string }).text ?? '').join('\n')
  for (const ref of refsIn(value)) {
    expect(rendered, `${definition.name} 的渲染文本没提到 value 里点名的 ${ref}`).toContain(ref)
  }
  return value
}

/** 递归收集载荷里出现的每个 `session:<id>` 引用。 */
function refsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') { if (value.startsWith('session:')) found.add(value); return found }
  if (Array.isArray(value)) { for (const item of value) refsIn(item, found); return found }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) refsIn(item, found)
  }
  return found
}

describe('control tool registration surface', () => {
  it('registers exactly the six prefixed names and none of the shadowable ones', () => {
    const host = fakeHost()
    registerControlTools(host, fakeService())
    const names = host.registered.map(definition => definition.name)
    expect(names).toEqual([...CONTROL_TOOL_NAMES])
    expect(names).toHaveLength(6)
    for (const name of names) expect(name.startsWith('matou_')).toBe(true)
    for (const forbidden of FORBIDDEN_NAMES) expect(names).not.toContain(forbidden)
  })

  it('opts the four read-only tools into parallel dispatch and neither writer', () => {
    const { tool } = harness()
    // Not `{}`: `defineTool` validates arguments inside its `isConcurrencySafe`
    // wrapper (`packages/core/tools/src/schema.ts:610-615`), so a tool with a
    // required `target` reports `false` for empty arguments.
    expect(tool('matou_identify_self').isConcurrencySafe?.({})).toBe(true)
    expect(tool('matou_list_sessions').isConcurrencySafe?.({})).toBe(true)
    expect(tool('matou_read_recent').isConcurrencySafe?.({ target: 'left' })).toBe(true)
    expect(tool('matou_read_history').isConcurrencySafe?.({ target: 'left' })).toBe(true)
    // Omitted, not `false`: the registry treats anything but `true` as
    // exclusive (`packages/core/tools/src/index.ts:1267-1276`), and a sent
    // message or an interrupt must form an ordering barrier.
    expect(tool('matou_send_message').isConcurrencySafe).toBeUndefined()
    expect(tool('matou_interrupt_session').isConcurrencySafe).toBeUndefined()
  })

  it('tells every tool description how to address a target and what this surface cannot do', () => {
    const { tool } = harness()
    for (const name of CONTROL_TOOL_NAMES) {
      const { description } = tool(name)
      expect(description, `${name} must teach the selector syntax`).toContain('sibling:N')
      expect(description, `${name} must disclaim lifecycle control`).toMatch(/cannot create|does not create/i)
    }
    // Capability discovery is description-only (no system-prompt injection), so
    // these three facts have nowhere else to live.
    expect(tool('matou_send_message').description).toContain('after_current_turn')
    expect(tool('matou_send_message').description).toMatch(/order|reorder|top/i)
    expect(tool('matou_read_recent').description).toContain('matou_list_sessions')
  })
})

describe('caller identity', () => {
  it('refuses every tool when there is no calling agent', async () => {
    const { tool } = harness()
    const exec = fakeExec({ withoutAgent: true })
    const args: Record<string, Record<string, unknown>> = {
      matou_identify_self: {},
      matou_list_sessions: {},
      matou_read_recent: { target: 'left' },
      matou_read_history: { target: 'left' },
      matou_send_message: { target: 'left', message: 'hi' },
      matou_interrupt_session: { target: 'left' },
    }
    for (const name of CONTROL_TOOL_NAMES) {
      await expect(run(tool(name), args[name]!, exec), name).rejects.toThrow(/calling agent/i)
    }
  })

  it('tells a subagent caller it has no position instead of pretending it is a card', async () => {
    const { tool } = harness()
    const exec = fakeExec({ sessionId: 'sub1' })
    await expect(run(tool('matou_identify_self'), {}, exec)).rejects.toThrow(
      /^NOT_IN_WORKBENCH: you are a subagent child/,
    )
    // The same door for the surveying tool: a subagent has no level to list.
    await expect(run(tool('matou_list_sessions'), {}, exec)).rejects.toThrow(/^NOT_IN_WORKBENCH: you are a subagent child/)
  })

  it('tells a caller outside the workbench which tool to call next', async () => {
    const { tool } = harness()
    await expect(run(tool('matou_identify_self'), {}, fakeExec({ sessionId: 'stranger' })))
      .rejects.toThrow(/^NOT_IN_WORKBENCH: you are not a card in this workbench/)
  })

  it('reports the workbench as not ready rather than leaking the storage failure', async () => {
    const { tool } = harness({ snapshotError: new Error('matou-layout: durable domain is not initialized') })
    await expect(run(tool('matou_identify_self'), {})).rejects.toThrow(/^WORKBENCH_NOT_READY:/)
  })
})

describe('matou_identify_self', () => {
  it('answers where the caller sits, with the revision its ordinals are indexed by', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_identify_self'), {}, fakeExec({ cwd: '/repo/caller' }))
    expect(value['ref']).toBe('session:caller')
    expect(value['session_id']).toBe(CALLER)
    expect(value['title']).toBe('Caller card')
    expect(value['cwd']).toBe('/repo/caller')
    expect(value['workspace']).toEqual({ id: 'ws1', title: 'Workspace One', ordinal: 1 })
    expect(value['task']).toMatchObject({ title: '默认', ordinal: 1 })
    expect(value['scene']).toMatchObject({ title: '默认', ordinal: 1 })
    expect(value['depth']).toBe(0)
    expect(value['level_ordinal']).toBe(2)
    expect(value['level_size']).toBe(3)
    expect(value['parent_ref']).toBeUndefined()
    expect(value['child_refs']).toEqual(['session:child1'])
    expect((value['level'] as { ref: string }[]).map(card => card.ref))
      .toEqual(['session:left-card', 'session:caller', 'session:right-card'])
    expect((value['level'] as { is_self: boolean }[]).map(card => card.is_self)).toEqual([false, true, false])
    // The number `resolve.ts` recomputes; if these ever disagree, every
    // `sibling:N` call fails as stale.
    expect(value['topology_revision']).toBe(EXPECTED_REVISION)
    expect(value['selector_syntax']).toContain('sibling:N')
  })

  /**
   * S7 审查 E13 的另一半：邻居清单也要带 `cwd`。
   *
   * 标题回落修好之后，没有标题的卡显示成目录末段名——那正是用户屏幕上看到的
   * 字。但清单里若只有 `title` 没有 `cwd`，模型就无从判断这个标题是「用户起
   * 的名字」还是「目录名」，用户说出完整路径时也对不上号。
   * `matou_list_sessions` 早就带了 `cwd`（`listedCardOf`），只有这里的
   * `level` 数组漏了。
   */
  it('level 里的邻居卡带上 cwd（有目录的报出，没有的省略该键）', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_identify_self'), {}, fakeExec({ cwd: '/repo/caller' }))
    const cards = value['level'] as readonly Record<string, unknown>[]
    const byRef = new Map(cards.map(card => [card['ref'], card]))
    // 夹具里 left-card 有 /repo/left、caller 有 /repo/caller，right-card 没有
    expect(byRef.get('session:left-card')?.['cwd']).toBe('/repo/left')
    expect(byRef.get('session:caller')?.['cwd']).toBe('/repo/caller')
    expect('cwd' in byRef.get('session:right-card')!).toBe(false)
  })

  it('omits cwd entirely when the calling session header has none', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_identify_self'), {}, fakeExec())
    // `session.header.cwd` is optional in DSH (`packages/core/session/src/types.ts:92-130`);
    // an explicit `undefined` would be a lie about the shape, not a missing value.
    expect(Object.hasOwn(value, 'cwd')).toBe(false)
  })

  it('reports a drilled child as depth 1 under its parent ref', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_identify_self'), {}, fakeExec({ sessionId: 'child1' }))
    expect(value['depth']).toBe(1)
    expect(value['parent_ref']).toBe('session:caller')
    expect(value['level_size']).toBe(1)
    // A different layer indexes a different pair of sets, so a different number.
    expect(value['topology_revision']).not.toBe(EXPECTED_REVISION)
  })
})

describe('matou_list_sessions', () => {
  it('numbers the caller level in the order the user sees it', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_list_sessions'), {})
    expect(value['scope']).toBe('level')
    const sessions = value['sessions'] as Record<string, unknown>[]
    expect(sessions.map(card => card['ref']))
      .toEqual(['session:left-card', 'session:caller', 'session:right-card'])
    expect(sessions.map(card => card['ordinal'])).toEqual([1, 2, 3])
    expect(sessions[0]).toMatchObject({ title: 'Left card', cwd: '/repo/left', path: FIXTURE_PATH, is_self: false })
    // `right-card` has no cwd in its list row; the key must be absent, not null.
    expect(Object.hasOwn(sessions[2]!, 'cwd')).toBe(false)
    expect(value['topology_revision']).toBe(EXPECTED_REVISION)
  })

  it('gives the whole workbench refs and paths but no addressable ordinals', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_list_sessions'), { scope: 'all' })
    expect(value['scope']).toBe('all')
    const sessions = value['sessions'] as Record<string, unknown>[]
    expect(sessions.map(card => card['ref'])).toEqual([
      'session:left-card',
      'session:caller',
      'session:right-card',
      'session:child1',
    ])
    // `sibling:N` has no meaning outside the caller's own layer, so an ordinal
    // in this payload could only be misread (D-S7-3).
    for (const card of sessions) expect(Object.hasOwn(card, 'ordinal')).toBe(false)
    for (const card of sessions) expect(card['path']).toBe(FIXTURE_PATH)
    expect(sessions.map(card => card['depth'])).toEqual([0, 0, 0, 1])
    // Never a card: a subagent child is not part of the workbench.
    expect(sessions.map(card => card['session_id'])).not.toContain('sub1')
  })
})

describe('addressing failures', () => {
  it('names the subagent tools when a bare id lands on a subagent child', async () => {
    const { tool } = harness()
    const failure = run(tool('matou_read_recent'), { target: 'sub1' })
    await expect(failure).rejects.toThrow(/^TARGET_IS_SUBAGENT:/)
    await expect(failure).rejects.toThrow(/send_message/)
  })

  it('rejects an ordinal selector that arrives without a revision', async () => {
    const { tool } = harness()
    await expect(run(tool('matou_read_recent'), { target: 'sibling:1' }))
      .rejects.toThrow(/^STALE_TOPOLOGY:/)
    await expect(run(tool('matou_read_recent'), { target: 'sibling:1', topology_revision: 'stale' }))
      .rejects.toThrow(/^STALE_TOPOLOGY:/)
  })

  it('accepts an ordinal selector carrying the current revision', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_read_recent'), {
      target: 'sibling:3',
      topology_revision: EXPECTED_REVISION,
    })
    expect(value['target']).toMatchObject({ ref: 'session:right-card' })
  })

  // 位置型（left/right/sibling:N/child:N）现在一律吃版本号闸门，身份型不吃：
  // 拿一个胡编的版本号配 session:<id>，应当被忽略而不是报 STALE_TOPOLOGY。
  it('ignores a revision sent with an identity selector instead of failing on it', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_read_recent'), {
      target: 'session:right-card',
      topology_revision: 'whatever',
    })
    expect(value['target']).toMatchObject({ ref: 'session:right-card' })
  })

  it('explains an unparseable target rather than guessing', async () => {
    const { tool } = harness()
    await expect(run(tool('matou_read_recent'), { target: 'sibling:abc' }))
      .rejects.toThrow(/^INVALID_TARGET: sibling needs an ordinal/)
  })
})

describe('matou_read_recent', () => {
  it('returns the newest turns of the addressed card with its projection cursor', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_read_recent'), { target: 'right', turns: 2, topology_revision: EXPECTED_REVISION })
    expect(value['target']).toEqual({ ref: 'session:right-card', title: 'Right card' })
    expect(value['turns']).toEqual([
      { turn: 2, seq: 9, prompt: 'second ask', response: 'second answer' },
      { turn: 3, seq: 20, prompt: 'third ask', response: '' },
    ])
    expect(value['total_turns']).toBe(3)
    expect(value['as_of_seq']).toBe(11)
    expect(Object.hasOwn(value, 'note')).toBe(false)
  })

  it('degrades to a note when the deployment has no turn-outline projection', async () => {
    const { tool } = harness()
    // `left-card` carries a `title` projection but no `turnOutline` key, which
    // is what a deployment without `session-turn-outline` looks like
    // (`packages/bundle/web-app/cordis.patch.yml:77-78` mounts it; others need not).
    const value = await run(tool('matou_read_recent'), { target: 'left', topology_revision: EXPECTED_REVISION })
    expect(value['turns']).toEqual([])
    expect(value['total_turns']).toBe(0)
    expect(value['note']).toMatch(/matou_read_history/)
  })
})

describe('matou_read_history', () => {
  it('reads through sessionQuery with the caller signal and releases the observation', async () => {
    const { host, tool } = harness()
    const controller = new AbortController()
    const value = await run(tool('matou_read_history'), { target: 'right', topology_revision: EXPECTED_REVISION }, fakeExec({ signal: controller.signal }))
    expect(host.observeCalls).toEqual([{
      sessionId: 'right-card',
      signal: controller.signal,
      // Reading must not compute projections: a control-plane read is a
      // side-effect-free look at another card.
      projectionMode: 'none',
    }])
    expect(host.disposals.count).toBe(1)
    expect(value['messages']).toEqual([
      { seq: 2, role: 'user', text: 'ping' },
      { seq: 4, role: 'assistant', text: 'pong' },
    ])
    expect(value['has_more']).toBe(false)
    expect(value['truncated']).toBe(false)
    expect(value['as_of_seq']).toBe(4)
  })

  it('releases the observation even when shaping the window fails', async () => {
    // A poisoned event makes the shaper throw; the lease must still be handed
    // back, or the target session stays pinned for the process lifetime.
    const poisoned = { seq: 1, get type(): string { throw new Error('boom') }, data: {} }
    const { host, tool } = harness({
      events: [poisoned as unknown as { seq: number; type: string; data: unknown }],
    })
    await expect(run(tool('matou_read_history'), { target: 'right', topology_revision: EXPECTED_REVISION })).rejects.toThrow(/boom/)
    expect(host.disposals.count).toBe(1)
  })

  it('pages backwards through an explicit cursor', async () => {
    const { tool } = harness()
    const value = await run(tool('matou_read_history'), { target: 'right', before_seq: 4, topology_revision: EXPECTED_REVISION })
    // `before_seq` is exclusive, the same sense as DSH's own
    // `SessionPageRequest.beforeSeq` (`packages/api/session-controller/src/history.ts:318-343`).
    expect(value['messages']).toEqual([{ seq: 2, role: 'user', text: 'ping' }])
  })
})

describe('matou_send_message', () => {
  it('labels the message with its sender and steers the target now by default', async () => {
    const { host, tool } = harness()
    const value = await run(tool('matou_send_message'), { target: 'right', message: 'status?', topology_revision: EXPECTED_REVISION })
    expect(host.promptCalls).toHaveLength(1)
    const { request } = host.promptCalls[0]!
    expect(request.sessionId).toBe('right-card')
    expect(request.mode).toBe('steer')
    // The prefix is host-assembled, never a parameter: DSH stamps the message
    // source as `{kind:'user'}` (`packages/api/session-controller/src/commands.ts:308-312`),
    // so the body is the only place the real sender can be told.
    expect(request.content).toEqual([{ type: 'text', text: '[from session:caller (Caller card)] status?' }])
    expect(value).toMatchObject({ delivered: true, deliver: 'now', mode: 'steer' })
    expect(value['target']).toEqual({ ref: 'session:right-card', title: 'Right card' })
  })

  it('queues behind the current turn when asked to wait', async () => {
    const { host, tool } = harness()
    const value = await run(tool('matou_send_message'), {
      target: 'right',
      topology_revision: EXPECTED_REVISION,
      message: 'later',
      deliver: 'after_current_turn',
    })
    expect(host.promptCalls[0]!.request.mode).toBe('queue')
    expect(value).toMatchObject({ deliver: 'after_current_turn', mode: 'queue' })
  })

  it('mints a fresh request id per call', async () => {
    const { host, tool } = harness()
    await run(tool('matou_send_message'), { target: 'right', message: 'one', topology_revision: EXPECTED_REVISION })
    await run(tool('matou_send_message'), { target: 'right', message: 'two', topology_revision: EXPECTED_REVISION })
    const ids = host.promptCalls.map(call => call.request.requestId)
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])
  })

  it('passes the caller cancellation straight through to the prompt', async () => {
    const { host, tool } = harness()
    const controller = new AbortController()
    await run(tool('matou_send_message'), { target: 'right', message: 'hi', topology_revision: EXPECTED_REVISION }, fakeExec({ signal: controller.signal }))
    expect(host.promptCalls[0]!.signal).toBe(controller.signal)
  })

  it('translates the subagent ownership rejection instead of forwarding a RemoteError', async () => {
    // The backstop for the structural hole: even if the projection and the
    // subagent set both missed, `sessionController` still refuses
    // (`packages/api/session-controller/src/agent.ts:80-90`,
    // `commands.ts:435-445`) and the model must read a sentence, not a code.
    const { tool } = harness({
      promptError: remoteError('session/agent-busy', 'session "right-card" is owned by subagent routing'),
    })
    const failure = run(tool('matou_send_message'), { target: 'right', message: 'hi', topology_revision: EXPECTED_REVISION })
    await expect(failure).rejects.toThrow(/^TARGET_IS_SUBAGENT:/)
    await expect(failure).rejects.toThrow(/send_message/)
  })

  it('translates a vanished session into the addressing sentence', async () => {
    const { tool } = harness({ promptError: remoteError('session/not-found', 'session "right-card" not found') })
    await expect(run(tool('matou_send_message'), { target: 'right', message: 'hi', topology_revision: EXPECTED_REVISION }))
      .rejects.toThrow(/^NOT_IN_WORKBENCH:/)
  })

  it('never hands an unmapped RemoteError to the model verbatim', async () => {
    const { tool } = harness({
      promptError: remoteError('session/model-unavailable', 'no adapter serves provider "x"'),
    })
    const failure = run(tool('matou_send_message'), { target: 'right', message: 'hi', topology_revision: EXPECTED_REVISION })
    await expect(failure).rejects.toThrow(/could not be delivered/)
    await expect(failure).rejects.toThrow(/session\/model-unavailable/)
  })
})

describe('matou_interrupt_session', () => {
  it('cancels the target through the same path as the stop button', async () => {
    const { host, tool } = harness()
    const value = await run(tool('matou_interrupt_session'), { target: 'right', topology_revision: EXPECTED_REVISION })
    expect(host.cancelCalls).toEqual([{ sessionId: 'right-card' }])
    expect(value).toMatchObject({ interrupted: true })
    expect(value['target']).toEqual({ ref: 'session:right-card', title: 'Right card' })
  })

  it('says nothing is running rather than faking a successful interrupt', async () => {
    // `agent.cancel` is a no-op on an idle agent
    // (`packages/core/agent-loop/src/agent.ts:143-149`), and `cancel` never
    // wakes a cold session (`commands.ts:435-442`).
    const { host, tool } = harness({ liveAgentIds: [CALLER] })
    await expect(run(tool('matou_interrupt_session'), { target: 'right', topology_revision: EXPECTED_REVISION }))
      .rejects.toThrow(/^TARGET_NOT_RUNNING:/)
    expect(host.cancelCalls).toEqual([])
  })

  it('says nothing is running when the deployment has no agent registry at all', async () => {
    const { host, tool } = harness({ withoutAgents: true })
    await expect(run(tool('matou_interrupt_session'), { target: 'right', topology_revision: EXPECTED_REVISION }))
      .rejects.toThrow(/^TARGET_NOT_RUNNING:/)
    expect(host.cancelCalls).toEqual([])
  })

  it('translates the subagent ownership rejection raised by cancel', async () => {
    const { tool } = harness({
      cancelError: remoteError('session/agent-busy', 'session "right-card" is owned by subagent routing'),
    })
    await expect(run(tool('matou_interrupt_session'), { target: 'right', topology_revision: EXPECTED_REVISION }))
      .rejects.toThrow(/^TARGET_IS_SUBAGENT:/)
  })

  it('treats a session that vanished between the check and the cancel as no longer running', async () => {
    const { tool } = harness({ cancelError: remoteError('session/not-found', 'not attached') })
    await expect(run(tool('matou_interrupt_session'), { target: 'right', topology_revision: EXPECTED_REVISION }))
      .rejects.toThrow(/^TARGET_NOT_RUNNING:/)
  })
})

