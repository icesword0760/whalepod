/**
 * The host fact adapter: the one place in this slice that touches IO.
 *
 * Everything else under `src/control/` is a pure function over data. This
 * module is what hands them that data, joining the three — and only three —
 * sources the control plane is allowed to know about:
 *
 * 1. `ctx.sessionController.list({}, signal)` — every visible session with the
 *    fields the projection sorts by (`packages/api/session-controller/src/index.ts:213-216`,
 *    `types.ts:155-165`). Reading it does not resume an Agent, so a cold card is
 *    projected exactly like a warm one.
 * 2. `ctx.workspaceRegistry.list()` and `.archivedSessionIds` — the durable
 *    workspace order and the registry-global archive set
 *    (`packages/workspace/workspace/src/index.ts:181`, `:233-235`).
 * 3. This plugin's own organization document — tasks, scenes and placements,
 *    the structure DSH does not model (`src/index.ts` `snapshot()`).
 *
 * **Why the host has all three.** The S7 survey claimed the sort inputs
 * (`parentSessionId` / `origin` / `blank` / recency) existed only on the
 * client; the 「事后更正」 section retracts that — `SessionSummary` carries them
 * itself, and the client list is a mirror of this very call. So no
 * client-to-host state channel is needed, and the projection belongs on the
 * host next to the identity it must bind to (D-S7-2).
 *
 * **Nothing is cached, deliberately.** Every tool call re-reads all three.
 * A cache would let `sibling:3` resolve against a layer the user has already
 * changed, which is precisely the failure `topology_revision` exists to make
 * impossible — caching here would quietly disarm it.
 *
 * **Provider-agnostic.** Not one field read below is specific to a provider,
 * and nothing here may ever branch on one: 码头 only ever hosts Claude Code, so
 * every provider-shaped assumption of its control plane is left behind.
 * @module dsh-plugin-matou-layout/src/control/facts
 */

import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type { MatouLayoutService } from '../index.ts'
import type { MatouOrgState } from '../org/model.ts'
import { controlError } from './errors.ts'
import { projectControlTargets } from './topology.ts'
import type { ControlSessionFacts, ControlTarget, ControlWorkspaceFacts } from './topology.ts'

/**
 * The `SessionSummary` fields this plugin reads
 * (`packages/api/session-controller/src/types.ts:155-165`), restated with
 * plain `string` ids rather than DSH's branded ones so a test fixture is an
 * object literal instead of a pile of casts. {@link HostShapeIsNarrowerThanDsh}
 * proves the real type still fits, so the narrowing cannot drift into a lie.
 */
export interface HostSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly cwd?: string
  /**
   * Cached projection values, present only for the keys the deployment
   * actually composes — hence every read of them is a guarded one.
   */
  readonly projections?: {
    readonly asOfSeq: number
    readonly values: Readonly<Record<string, unknown>>
  }
}

/** One workspace as the registry's entity exposes it (`packages/workspace/workspace/src/entity.ts:79`, `:89`, `:101`). */
export interface HostWorkspace {
  readonly id: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/**
 * The slice of the host context the control plane reads. Narrowed to two
 * services so the tests can hand over a literal; a real cordis `Context`
 * satisfies it by {@link HostShapeIsNarrowerThanDsh}.
 */
export interface WorkbenchFactsHost {
  readonly sessionController: {
    list(
      request: { readonly cursor?: string },
      signal: AbortSignal,
    ): Promise<{ readonly items: readonly HostSessionSummary[] }>
  }
  readonly workspaceRegistry: {
    list(): readonly HostWorkspace[]
    readonly archivedSessionIds: readonly string[]
  }
}

/**
 * The organization document, as the control plane reads it. The layout service
 * is captured by the sub-plugin rather than injected, so this is the only
 * surface of it the control plane depends on.
 */
export interface WorkbenchOrgSource {
  snapshot(): Promise<{ readonly state: MatouOrgState }>
}

/** Everything one tool call needs to address, read and report on the workbench. */
export interface WorkbenchFacts {
  /** Every addressable card, in the order the user sees. */
  readonly targets: readonly ControlTarget[]
  /**
   * Sessions DSH marks as subagent children. They are NOT cards — no relative
   * selector can reach one — and this set exists only so a caller who guesses
   * a bare subagent id is told what it actually hit (`resolve.ts`).
   */
  readonly subagentSessionIds: ReadonlySet<string>
  /**
   * The raw summary behind a card, for readers that need more than the
   * projection carries — `matou_read_recent` takes its turn outline from
   * `projections.values.turnOutline`. Exposed here so that this module stays
   * the only place that calls `sessionController.list()`; a second call from
   * the tool layer would both double the read and let the two answers disagree
   * within one tool call.
   */
  readonly summaryOf: (sessionId: string) => HostSessionSummary | undefined
}

/** Errors if `Actual` is not assignable to `Expected`; the alias itself is erased. */
type AssertAssignable<Actual extends Expected, Expected> = Actual

/**
 * Compile-time proof that the narrowed shapes above still describe the real
 * host. Exported (rather than a local alias) so `noUnusedLocals` keeps it, and
 * so a DSH change to `SessionSummary`, `WorkspaceRegistry` or the layout
 * service breaks the build here instead of at runtime.
 */
export type HostShapeIsNarrowerThanDsh = AssertAssignable<Context, WorkbenchFactsHost>

/** The same proof for the plugin's own service. */
export type LayoutServiceIsAnOrgSource = AssertAssignable<MatouLayoutService, WorkbenchOrgSource>

/**
 * The session's display title, or the empty string.
 *
 * The only source is the `title` projection, whose value is `string | null` —
 * `null` until the first title lands (`packages/session/session-title/src/types.ts:86-96`)
 * — and which is simply absent in a deployment that does not compose
 * `session-title` at all. `values` is an open JSON record
 * (`session-controller/src/types.ts:79-81`), so the type is checked at runtime
 * rather than trusted; an unexpected value degrades to "untitled", never to a
 * thrown error inside a read-only tool.
 * @param summary - one session list row.
 * @returns the title, or `''` when there is none.
 */
function titleOf(summary: HostSessionSummary): string {
  const title = summary.projections?.values['title']
  if (typeof title === 'string') return title
  // 二、三级回落，逐字对齐 DSH 客户端的 `displayTitleOf`
  // （`api/session-controller/src/client/sessions/service.ts:148-155`）：
  // 持久标题 → 工作目录末段名 → 会话 id。
  //
  // 少了后两级不是「功能坏了」，是**模型认不出用户说的是哪张卡**：两张还没
  // 生成标题的卡，用户屏幕上写着 `dsh-plug` 和 `deepseek-harness`（目录名），
  // 而控制面报回去两行空标题。这不只发生在标题生成前的一瞬间——标题模型不
  // 可用、或部署没挂标题生成组合时，它是永久的。
  //
  // 末段名直接用 DSH 自己那份 `workspaceTitleOf` 而不是重写：两份实现必然
  // 漂移，而这里的漂移没有任何症状会提醒人（S7 审查 E13）。
  if (summary.cwd !== undefined && summary.cwd !== '') {
    const base = workspaceTitleOf(summary.cwd)
    if (base !== '') return base
  }
  return summary.sessionId
}

/**
 * Narrow one session list row to the facts the projection sorts and labels by.
 * @param summary - one session list row.
 * @returns the projection's view of that session.
 */
function controlFactsOf(summary: HostSessionSummary): ControlSessionFacts {
  return {
    // DSH's own parent link. A placement's `parentSessionId` outranks it, and
    // an explicit-root placement suppresses it — both decided in `nodes.ts`.
    parentId: summary.parentSessionId,
    origin: summary.origin,
    updatedAt: summary.updatedAt,
    blank: summary.blank,
    running: summary.running,
    // Left `undefined` when the header has none; `topology.ts` drops the key
    // rather than emitting an `undefined` into a tool payload.
    cwd: summary.cwd,
    title: titleOf(summary),
  }
}

/**
 * Read the organization document, translating a not-yet-open storage domain.
 *
 * The control plane is a child plugin of the layout service, so a tool can be
 * invoked in the window before `Service.init` has opened the durable domain —
 * `snapshot()` throws there. That is a "not ready yet", not a caller mistake,
 * and the model gets a sentence saying so; the original is kept as `cause` for
 * the host log and never reaches the model.
 * @param service - the layout service.
 * @returns the organization state.
 */
async function readOrgState(service: WorkbenchOrgSource): Promise<MatouOrgState> {
  try {
    return (await service.snapshot()).state
  } catch (cause) {
    const error = controlError('WORKBENCH_NOT_READY')
    error.cause = cause
    throw error
  }
}

/**
 * Read the whole workbench from the host, once.
 * @param ctx - the host context, for the session list and the workspace registry.
 * @param service - the layout service holding the organization document.
 * @param signal - the calling tool's cancellation signal; nothing is read once it is aborted.
 * @returns the addressable cards, the subagent set, and the raw summaries behind them.
 */
export async function readWorkbenchFacts(
  ctx: WorkbenchFactsHost,
  service: WorkbenchOrgSource,
  signal: AbortSignal,
): Promise<WorkbenchFacts> {
  signal.throwIfAborted()
  const org = await readOrgState(service)
  const { items } = await ctx.sessionController.list({}, signal)

  const summaries = new Map<string, HostSessionSummary>()
  const facts = new Map<string, ControlSessionFacts>()
  const subagentSessionIds = new Set<string>()
  for (const summary of items) {
    summaries.set(summary.sessionId, summary)
    facts.set(summary.sessionId, controlFactsOf(summary))
    // Collected from the WHOLE list rather than from the workspace rosters: a
    // subagent child need not belong to any workspace, and one that does not
    // would otherwise be reported as "not in this workbench" — true, but not
    // the fact the caller needs (结构性空洞, plan §「子代理会话怎么处理」).
    if (summary.origin === 'subagent') subagentSessionIds.add(summary.sessionId)
  }

  // Read last, and synchronously, so the workspace order and the archive set
  // are as close in time to the session list as the host can make them.
  const workspaces: readonly ControlWorkspaceFacts[] = ctx.workspaceRegistry.list().map(
    (workspace): ControlWorkspaceFacts => ({
      workspaceId: workspace.id,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
    }),
  )
  const archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds

  const targets = projectControlTargets({
    workspaces,
    summaryOf: (sessionId: string) => facts.get(sessionId),
    archivedSessionIds,
    org,
  })
  return { targets, subagentSessionIds, summaryOf: (sessionId: string) => summaries.get(sessionId) }
}
