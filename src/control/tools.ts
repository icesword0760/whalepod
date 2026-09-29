/**
 * The six `matou_*` session-control tools: the model-facing face of everything
 * the rest of `src/control/` computes.
 *
 * **Why every name carries a `matou_` prefix.** DSH already ships globally
 * named `send_message` and `interrupt_agent`
 * (`packages/subagent/tool-subagent-control/src/index.ts:29`, `:77`), and the
 * web bundle disables that host row (`packages/bundle/web-app/cordis.patch.yml:403-406`)
 * so the pair lives only inside each preset's AGENT scope
 * (`packages/preset/agent-presets/presets/standard/agent.cordis.yml:174-178`).
 * A cross-layer duplicate is not an error: the scope's own registration simply
 * wins by `Map.set` (`packages/core/tools/src/index.ts:1143-1184`, regression
 * `packages/core/tools/tests/scoped.spec.ts:87-97`), while only a SAME-layer
 * duplicate throws (`:718-722`). So a host-row `send_message` from this plugin
 * would be shadowed with no error and no log — a far worse failure than a name
 * clash. The prefix removes the possibility.
 *
 * **What this surface deliberately does not do.** No create, no fork, no close,
 * no focus. 码头's protocol has all of them and grants them to hosted sessions
 * (`apps/runtime/src/control/host-control-types.ts:6-18`,
 * `host-action-types.ts:5-12`); this plugin cuts them on purpose — the control
 * plane observes and nudges the workbench, it never reshapes it, so it creates
 * no session and no lineage.
 *
 * **Capability discovery is description-only.** No system prompt is injected
 * and no `systemPrompt` section is registered, so every fact a caller needs —
 * the selector syntax, when a `topology_revision` is required, what the two
 * delivery timings actually mean, and what this surface cannot do — has to be
 * in the tool descriptions below. They are load-bearing text, not documentation.
 *
 * **Shape of every `execute`.** Take the calling session from `exec.agent`
 * (absent → an honest failure, never a silent no-op) → read the workbench once
 * → parse the selector → resolve it against the freshly recomputed revision →
 * do the one thing → shape the answer. Anything DSH throws crosses one
 * translation layer first: a `RemoteError` never reaches the model verbatim.
 * @module dsh-plugin-matou-layout/src/control/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-query'
import { composeControlMessage } from './compose.ts'
import { controlError } from './errors.ts'
import type { ControlErrorCode } from './errors.ts'
import { readWorkbenchFacts } from './facts.ts'
import type { HostSessionSummary, WorkbenchFacts, WorkbenchFactsHost, WorkbenchOrgSource } from './facts.ts'
import { shapeHistory, shapeRecentTurns } from './read.ts'
import type { HistoryEvent, TurnOutlineEntryLike } from './read.ts'
import { resolveTarget } from './resolve.ts'
import { renderHistory, renderIdentity, renderRecentTurns, renderSessionList } from './render.ts'
import { topologyRevision } from './revision.ts'
import { SELECTOR_SYNTAX_HINT, isSelectorParseFailure, parseSelector } from './selector.ts'
import { childrenOf, levelOf } from './topology.ts'
import type { ControlTarget } from './topology.ts'

/** The six tool names, in registration order. Every one carries the plugin prefix; see the module doc. */
export const CONTROL_TOOL_NAMES = Object.freeze([
  'matou_identify_self',
  'matou_list_sessions',
  'matou_read_recent',
  'matou_read_history',
  'matou_send_message',
  'matou_interrupt_session',
] as const)

/**
 * The two tools with an effect on another session. They are the only ones the
 * approval policy has anything to say about; the other four are pure reads.
 */
export const CONTROL_SIDE_EFFECT_TOOL_NAMES = Object.freeze([
  'matou_send_message',
  'matou_interrupt_session',
] as const)

/**
 * One part of a prompt body — **exactly the text branch, which is the only one
 * this plugin ever builds** (`compose.ts` produces one text part and nothing
 * else).
 *
 * It used to be widened to `type: 'text' | 'image'` with an optional `text`,
 * on the reasoning that DSH's own union had to "fit" this narrowed host type.
 * That reasoning had the direction backwards: `prompt` takes this as a
 * PARAMETER, so the check runs contravariantly — OUR type has to be assignable
 * to DSH's, not the other way round. The old shape only ever type-checked
 * because method-syntax parameters are bivariant; DSH 0.1.5 adding a third
 * (`file`) branch and requiring `mediaType`/`data` on the image branch made the
 * loose form stop passing, which is what surfaced the mistake.
 *
 * Narrow is also the honest shape: a control-plane message is text. If this
 * plugin ever needs to send an image or a file, add that branch then — with
 * the fields DSH actually requires.
 */
export interface ControlPromptContentPart {
  readonly type: 'text'
  readonly text: string
}

/** One prompt admission, narrowed to the fields this plugin sets (`packages/api/session-controller/src/types.ts:302-309`). */
export interface ControlPromptRequest {
  /**
   * DSH brands this id (`SessionRequestId = Branded<'session-request-id'>`,
   * `packages/api/session-controller/src/types.ts:375`) rather than taking a
   * bare string. It was a plain `string` here while the plugin targeted
   * 0.1.2-alpha.4, where the field was unbranded; 0.1.5 brands it, and the
   * compile-time proof {@link ControlHostIsNarrowerThanDsh} caught the drift
   * the moment the plugin was pointed at the newer tree — which is what that
   * proof exists for.
   *
   * Narrowing DSH types to plain strings elsewhere in this file is so a TEST
   * can hand over an object literal; that reason does not apply here, because
   * this plugin only ever PRODUCES this id (see `mintRequestId` below) and the
   * tests only read it back.
   */
  readonly requestId: SessionRequestId
  /** Branded by DSH since 0.1.5, same story as `requestId` above. */
  readonly sessionId: SessionId
  /** `'steer'` cuts into the target's nearest step boundary; `'queue'` becomes its next turn. */
  readonly mode: 'queue' | 'steer'
  readonly content: readonly ControlPromptContentPart[]
}

/** Cancellation and projection selection for one observation (`packages/session-query/session-query/src/observation.ts:45-50`). */
export interface ControlObservationOptions {
  readonly signal?: AbortSignal
  readonly projectionMode?: 'all' | 'none'
}

/**
 * One retained session cut, narrowed to what the history reader needs.
 *
 * The real `SessionObservation` is `Disposable`
 * (`packages/session-query/session-query/src/observation.ts:22-41`), but this
 * package compiles against `lib: ES2024`, where neither `Disposable` nor
 * `Symbol.dispose` exists yet — widening the lib is a packaging-face decision,
 * not a tool-layer one. So the lease is released through
 * {@link releaseObservation}, which looks the well-known symbol up at runtime.
 */
export interface ControlObservation {
  readonly events: readonly HistoryEvent[]
  /** Last observed event seq, or `-1` for an empty log. */
  readonly cursor: number
}

/** The live agent registry, narrowed to the residency question this plugin asks (`packages/core/agent/src/index.ts:577-579`). */
export interface ControlAgentRegistry {
  get(sessionId: SessionId): unknown
}

/**
 * The host slice these tools read and write. Narrowed the same way
 * `facts.ts` narrows its own — plain `string` ids instead of DSH's branded
 * ones, so a test can hand over an object literal — with
 * {@link ControlHostIsNarrowerThanDsh} proving a real `Context` still fits.
 */
export interface ControlToolsHost extends WorkbenchFactsHost {
  readonly tools: {
    register(definition: ToolDefinition): () => void
  }
  readonly sessionController: WorkbenchFactsHost['sessionController'] & {
    prompt(request: ControlPromptRequest, signal: AbortSignal): Promise<{ readonly accepted: true }>
    cancel(request: { readonly sessionId: SessionId }): { readonly accepted: true }
  }
  readonly sessionQuery: {
    observeSession(sessionId: SessionId, options: ControlObservationOptions): Promise<ControlObservation>
  }
  /**
   * Optional service lookup. `agents` is NOT injected: a deployment may compose
   * the session plane without a live agent registry, and the honest answer
   * there is "nothing to interrupt", not a pending plugin.
   */
  get(name: 'agents'): ControlAgentRegistry | undefined
}

/** Errors if `Actual` is not assignable to `Expected`; the alias itself is erased. */
type AssertAssignable<Actual extends Expected, Expected> = Actual

/**
 * Compile-time proof that the narrowed host above still describes the real
 * one. Exported so `noUnusedLocals` keeps it, and so a DSH signature change
 * breaks the build here rather than at runtime.
 */
export type ControlHostIsNarrowerThanDsh = AssertAssignable<Context, ControlToolsHost>

/**
 * `Symbol.dispose`, read at runtime rather than through the type system.
 *
 * Node has defined it since v20.5 (as its own well-known symbol on newer V8),
 * so the fallback below is only there so a missing symbol degrades to "nothing
 * to call" instead of a `TypeError` inside a read-only tool.
 */
const DISPOSE_SYMBOL: symbol = (Symbol as unknown as { readonly dispose?: symbol }).dispose
  ?? Symbol.for('nodejs.dispose')

/**
 * Hand one observation lease back.
 *
 * A leaked lease pins the target session's prepared source for the lifetime of
 * the process, so this runs in a `finally` — including when shaping the window
 * throws.
 * @param observation - the lease returned by `observeSession`.
 */
function releaseObservation(observation: ControlObservation): void {
  const dispose = (observation as unknown as Record<symbol, unknown>)[DISPOSE_SYMBOL]
  if (typeof dispose === 'function') (dispose as (this: ControlObservation) => void).call(observation)
}

/** Said to a caller that DSH marks as a subagent child (plan §「子代理会话怎么处理」, branch 2). */
const CALLER_IS_SUBAGENT =
  'you are a subagent child, not a workbench card; you have no position in the workbench.'
  + ' Your own `send_message` / `interrupt_agent` tools address the agents you started.'

/** Appended to every description: the one thing a caller cannot discover by trying. */
const SURFACE_NOTE =
  'This surface reaches only the session cards of your own workbench: it cannot create, close, focus or fork a session,'
  + ' and it cannot reach subagent children — use your own subagent tools for those.'

/** Appended to every description: capability discovery is description-only, so the syntax has nowhere else to live. */
const SELECTOR_NOTE =
  `Targets are addressed by selector — ${SELECTOR_SYNTAX_HINT}.`
  + ' The positional forms (left, right, sibling:N, child:N) also need the topology_revision from'
  + ' matou_list_sessions or matou_identify_self, because cards reorder as they are used —'
  + ' including because of a message you just sent. To act on the same card more than once,'
  + ' take its session:<id> from the first result and address it by id; self, parent and'
  + ' session:<id> need no revision.'

/**
 * Assemble one tool description.
 * @param body - what this tool does, in its own words.
 * @returns the body plus the two notes every description carries.
 */
function describeTool(body: string): string {
  return `${body} ${SELECTOR_NOTE} ${SURFACE_NOTE}`
}

const TARGET_DESCRIPTION =
  `Which session to act on. ${SELECTOR_SYNTAX_HINT}.`

const REVISION_DESCRIPTION =
  'The topology_revision last returned by matou_list_sessions or matou_identify_self.'
  + ' Required for the positional targets left, right, sibling:N and child:N;'
  + ' ignored for self, parent and session:<id>.'

/** One card as `matou_identify_self` reports its neighbours: position only, no content. */
interface LevelCardValue {
  ordinal: number
  ref: string
  session_id: string
  title: string
  /** 与 `ListedCardValue.cwd` 同源；见 `levelCardOf` 的说明。 */
  cwd?: string
  running: boolean
  blank: boolean
  is_self: boolean
}

/** One card as `matou_list_sessions` reports it. `ordinal` is present only inside the caller's own level. */
interface ListedCardValue {
  ordinal?: number
  ref: string
  session_id: string
  title: string
  path: string
  depth: number
  running: boolean
  blank: boolean
  cwd?: string
  is_self: boolean
}

const LEVEL_CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ordinal: { type: 'integer', required: true, description: '1-based position in this level; the number sibling:N indexes.' },
    ref: { type: 'string', required: true },
    session_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    cwd: { type: 'string', description: 'Absent when the session has no working directory.' },
    running: { type: 'boolean', required: true },
    blank: { type: 'boolean', required: true },
    is_self: { type: 'boolean', required: true },
  },
} as const

const LISTED_CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ordinal: { type: 'integer', description: 'Present only in the level scope; sibling:N has no meaning outside your own level.' },
    ref: { type: 'string', required: true },
    session_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    path: { type: 'string', required: true, description: 'workspace / task / scene, as the user sees them named.' },
    depth: { type: 'integer', required: true, description: '0 for a top-level card, 1 for its children, and so on.' },
    running: { type: 'boolean', required: true },
    blank: { type: 'boolean', required: true },
    cwd: { type: 'string', description: 'Absent when the session has no working directory.' },
    is_self: { type: 'boolean', required: true },
  },
} as const

const PLACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    ordinal: { type: 'integer', required: true },
  },
} as const

const TARGET_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true },
    title: { type: 'string', required: true },
  },
} as const

/**
 * A display label for a container whose title the user never set.
 * @param name - the stored title or scene name.
 * @returns the name, or a neutral placeholder when it is blank.
 */
function labelOf(name: string): string {
  return name.trim() === '' ? '(untitled)' : name
}

/**
 * The human path of one card: the three containers the user navigates by.
 * @param target - a projected card.
 * @returns `workspace / task / scene`.
 */
function pathOf(target: ControlTarget): string {
  return `${labelOf(target.workspace.title)} / ${labelOf(target.task.title)} / ${labelOf(target.scene.name)}`
}

/**
 * Project one card for `matou_identify_self`'s level listing.
 * @param target - the card.
 * @param selfSessionId - the calling session, so the caller can find itself.
 * @returns the position-only card value.
 */
/**
 * 邻居卡也报 `cwd`（S7 审查 E13）：标题的第二级回落就是目录末段名，所以
 * 一个没起过名字的会话，它的 `title` 与它的 `cwd` 末段是同一个字。只给
 * `title` 不给 `cwd`，模型就分不清这个标题是用户起的名字还是目录名，用户
 * 说出完整路径时也对不上号。`matou_list_sessions` 的 `listedCardOf` 一直
 * 带着它，这里此前漏了。
 * @param target - 该层里的一张卡。
 * @param selfSessionId - 调用方会话。
 * @returns identify_self 的 `level` 数组里的一项。
 */
function levelCardOf(target: ControlTarget, selfSessionId: string): LevelCardValue {
  return {
    ordinal: target.levelOrdinal,
    ref: target.ref,
    session_id: target.sessionId,
    title: target.title,
    ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
    running: target.running,
    blank: target.blank,
    is_self: target.sessionId === selfSessionId,
  }
}

/**
 * Project one card for `matou_list_sessions`.
 * @param target - the card.
 * @param selfSessionId - the calling session.
 * @param withOrdinal - whether this listing is index-addressable (the caller's own level only).
 * @returns the listed card value, with absent fields omitted rather than nulled.
 */
function listedCardOf(target: ControlTarget, selfSessionId: string, withOrdinal: boolean): ListedCardValue {
  return {
    ...(withOrdinal ? { ordinal: target.levelOrdinal } : {}),
    ref: target.ref,
    session_id: target.sessionId,
    title: target.title,
    path: pathOf(target),
    depth: target.depth,
    running: target.running,
    blank: target.blank,
    ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
    is_self: target.sessionId === selfSessionId,
  }
}

/**
 * A card's identity, as every acting tool echoes it back.
 * @param target - the resolved card.
 * @returns its ref and title.
 */
function targetRefOf(target: ControlTarget): { ref: string; title: string } {
  return { ref: target.ref, title: target.title }
}

/** Everything one tool call resolved before it does its own work. */
interface ControlCall {
  readonly facts: WorkbenchFacts
  /** The calling session's own card; proven to exist before this is built. */
  readonly self: ControlTarget
  /** The revision covering the caller's level and children — the same number `resolve.ts` checks against. */
  readonly revision: string
  /** The caller's own level, in the order the user sees. */
  readonly level: readonly ControlTarget[]
}

/**
 * The calling session id, or an honest failure.
 *
 * `exec.agent` is optional on the type (`packages/core/tools/src/index.ts:318`)
 * because a tool can be dispatched outside an agent loop. Identity is the whole
 * basis of this surface — every selector is relative to the caller — so an
 * agentless call cannot be answered, and saying so is the only correct
 * behaviour. Same shape as the official tools'
 * (`packages/subagent/tool-subagent-control/src/index.ts:62-65`,
 * `packages/session-query/tool-session-query/src/workspace-access.ts:56-63`).
 * @param exec - the tool execution context.
 * @param toolName - the tool being run, so the message names it.
 * @returns the calling session's id.
 */
function callerSessionIdOf(exec: ToolRunContext, toolName: string): string {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
  }
  return agent.session.id
}

/**
 * The calling session's working directory, when it has one.
 *
 * `SessionHeader.cwd` is optional (`packages/core/session/src/types.ts:92-130`),
 * and the list row simply omits the key when the header has none
 * (`packages/api/session-controller/src/list.ts:384`) — so the missing case is
 * a missing key here too, never an explicit `undefined`.
 * @param exec - the tool execution context.
 * @returns the caller's cwd, or `undefined`.
 */
function callerCwdOf(exec: ToolRunContext): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * The caller's own card, or the sentence explaining why it has none.
 * @param facts - the workbench as read for this call.
 * @param callerSessionId - the calling session.
 * @returns the caller's card.
 */
function callerCard(facts: WorkbenchFacts, callerSessionId: string): ControlTarget {
  // Checked before the projection because a subagent is never IN the projection
  // (`nodes.ts:91` filters it), so the generic "not a card" sentence would be
  // true but useless: it would not tell the caller which tools DO reach its
  // own agents.
  if (facts.subagentSessionIds.has(callerSessionId)) throw controlError('NOT_IN_WORKBENCH', CALLER_IS_SUBAGENT)
  const self = facts.targets.find(target => target.sessionId === callerSessionId)
  if (self !== undefined) return self
  // Delegated so the "caller is not a card" sentence lives in exactly one place
  // (`resolve.ts`); this call cannot return, and the throw below only exists so
  // the function is total.
  resolveTarget({ callerSessionId, selector: { kind: 'self' }, targets: facts.targets })
  throw controlError('NOT_IN_WORKBENCH')
}

/**
 * Read the workbench and locate the caller in it.
 *
 * Every tool call re-reads all three host sources: the topology moves under the
 * caller constantly, and a cache would let an ordinal resolve against a layer
 * the user already changed — which is exactly what `topology_revision` exists
 * to prevent.
 * @param ctx - the host services.
 * @param service - the layout service holding the organization document.
 * @param exec - the tool execution context.
 * @param toolName - the tool being run.
 * @returns the facts, the caller's card, its level, and the current revision.
 */
async function openCall(
  ctx: ControlToolsHost,
  service: WorkbenchOrgSource,
  exec: ToolRunContext,
  toolName: string,
): Promise<ControlCall> {
  const callerSessionId = callerSessionIdOf(exec, toolName)
  const facts = await readWorkbenchFacts(ctx, service, exec.signal)
  const self = callerCard(facts, callerSessionId)
  const level = levelOf(facts.targets, self.sessionId)
  const children = childrenOf(facts.targets, self.sessionId)
  const revision = topologyRevision(level.map(card => card.ref), children.map(card => card.ref))
  return { facts, self, revision, level }
}

/** The `target` / `topology_revision` pair every acting tool accepts. */
interface TargetArgs {
  readonly target: string
  readonly topology_revision?: string
}

/**
 * Resolve one call's `target` argument to a card.
 * @param call - the open call.
 * @param args - the model's target arguments.
 * @returns the addressed card.
 */
function resolveArgTarget(call: ControlCall, args: TargetArgs): ControlTarget {
  const selector = parseSelector(args.target)
  if (isSelectorParseFailure(selector)) throw controlError('INVALID_TARGET', selector.reason)
  const { sessionId } = resolveTarget({
    callerSessionId: call.self.sessionId,
    selector,
    targets: call.facts.targets,
    revision: args.topology_revision,
    subagentSessionIds: call.facts.subagentSessionIds,
  })
  const target = call.facts.targets.find(card => card.sessionId === sessionId)
  // Unreachable from a coherent projection: `resolveTarget` only ever returns
  // an id it found in `targets`. Kept so this function is total.
  if (target === undefined) throw controlError('NOT_IN_WORKBENCH')
  return target
}

/** How one host call's failures should read to the model. */
interface TranslateOptions {
  /** A clause naming what did not happen, e.g. `the message could not be delivered`. */
  readonly action: string
  /** Which control error a `session/not-found` becomes; the default is the addressing one. */
  readonly notFoundAs?: ControlErrorCode
}

/**
 * Translate whatever DSH threw into something a model can act on.
 *
 * A `RemoteError` is a wire failure: a code, a diagnostic written for a host
 * log, and a details bag. Handing one to a model is the failure mode 设计稿 §S7
 * calls out — it has to be a sentence saying what happened and what to do next.
 * Two codes carry real meaning here and get the matching control error; every
 * other one still becomes a sentence rather than crossing over verbatim.
 * Non-remote errors (a bug in this plugin, an abort) pass through untouched:
 * dressing those up would hide them.
 * @param error - whatever was caught.
 * @param options - how this particular failure should read.
 * @returns the error to throw instead.
 */
function translateHostFailure(error: unknown, options: TranslateOptions): unknown {
  const remote = remoteErrorOf(error)
  if (remote === undefined) return error
  // The backstop for the structural hole: `sessionController` refuses every
  // subagent-owned session with this exact code
  // (`packages/api/session-controller/src/agent.ts:80-90`, `:97-103`,
  // `commands.ts:443-445`), so even a call that slipped past the projection and
  // the subagent set lands on the same honest sentence.
  if (remote.code === 'session/agent-busy') return controlError('TARGET_IS_SUBAGENT')
  if (remote.code === 'session/not-found') {
    return options.notFoundAs === undefined
      ? controlError(
        'NOT_IN_WORKBENCH',
        'that session is no longer attached to this workbench;'
        + ' call matou_list_sessions to see the cards you can reach.',
      )
      : controlError(options.notFoundAs)
  }
  return new Error(`${options.action}: ${remote.message} (${remote.code})`, { cause: error })
}

/**
 * Read one card's `turnOutline` projection, if the deployment has one.
 *
 * `projections.values` is an open JSON record
 * (`packages/api/session-controller/src/types.ts:79-81`) whose `turnOutline`
 * key exists only where `session-turn-outline` is composed
 * (`packages/session/session-turn-outline/src/types.ts:44-47`;
 * `packages/bundle/web-app/cordis.patch.yml:77-78` mounts it in the web
 * bundle). Absent, or shaped unexpectedly, both degrade to `undefined` so
 * `shapeRecentTurns` can answer with a note instead of a thrown error.
 * @param summary - the card's session list row.
 * @returns the outline entries, or `undefined` when there is nothing usable.
 */
function turnOutlineOf(summary: HostSessionSummary | undefined): readonly TurnOutlineEntryLike[] | undefined {
  const value = summary?.projections?.values['turnOutline']
  if (!Array.isArray(value)) return undefined
  const entries: TurnOutlineEntryLike[] = []
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined
    const entry = item as Record<string, unknown>
    const { turn, seq, prompt, response } = entry
    if (typeof turn !== 'number' || typeof seq !== 'number'
      || typeof prompt !== 'string' || typeof response !== 'string') {
      return undefined
    }
    entries.push({ turn, seq, prompt, response })
  }
  return entries
}

/**
 * Build the six tool definitions bound to one host and one organization document.
 * @param ctx - the host services these tools read and write.
 * @param service - the layout service holding the organization document.
 * @returns the definitions, in {@link CONTROL_TOOL_NAMES} order.
 */
export function createControlTools(ctx: ControlToolsHost, service: WorkbenchOrgSource): readonly ToolDefinition[] {
  const identifySelf = defineTool({
    name: 'matou_identify_self',
    description: describeTool(
      'Report where you sit in the user\'s workbench: your own card, the workspace / task / scene containing it,'
      + ' your position in your level, your parent and children, and the topology_revision that the ordinal'
      + ' selectors are indexed by. Call this first when the user refers to another card by position'
      + ' ("the one on the right", "the third session").',
    ),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          session_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          cwd: { type: 'string', description: 'Absent when your session has no working directory.' },
          workspace: { ...PLACE_SCHEMA, required: true },
          task: { ...PLACE_SCHEMA, required: true },
          scene: { ...PLACE_SCHEMA, required: true },
          depth: { type: 'integer', required: true },
          level_ordinal: { type: 'integer', required: true },
          level_size: { type: 'integer', required: true },
          parent_ref: { type: 'string', description: 'Absent when you are on the top level of your scene.' },
          child_refs: { type: 'array', items: { type: 'string' }, required: true },
          level: { type: 'array', items: LEVEL_CARD_SCHEMA, required: true },
          topology_revision: { type: 'string', required: true },
          selector_syntax: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderIdentity(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const call = await openCall(ctx, service, exec, 'matou_identify_self')
      const { self } = call
      const cwd = callerCwdOf(exec)
      return {
        ref: self.ref,
        session_id: self.sessionId,
        title: self.title,
        ...(cwd === undefined ? {} : { cwd }),
        workspace: { id: self.workspace.id, title: self.workspace.title, ordinal: self.workspace.ordinal },
        task: { id: self.task.id, title: self.task.title, ordinal: self.task.ordinal },
        scene: { id: self.scene.id, title: self.scene.name, ordinal: self.scene.ordinal },
        depth: self.depth,
        level_ordinal: self.levelOrdinal,
        level_size: call.level.length,
        ...(self.parentRef === undefined ? {} : { parent_ref: self.parentRef }),
        child_refs: [...self.childRefs],
        level: call.level.map(card => levelCardOf(card, self.sessionId)),
        topology_revision: call.revision,
        selector_syntax: SELECTOR_SYNTAX_HINT,
      }
    },
  })

  const listSessions = defineTool({
    name: 'matou_list_sessions',
    description: describeTool(
      'List the workbench cards you can address. Scope "level" (the default) returns the cards beside you,'
      + ' each with the ordinal that sibling:N indexes, plus the topology_revision to send back with it.'
      + ' Scope "all" returns every card in the workbench with its path, but no ordinals — outside your own'
      + ' level, address a card by session:<id>.',
    ),
    parameters: {
      scope: {
        type: 'string',
        enum: ['level', 'all'],
        description: 'level: the cards beside you, numbered. all: every card in the workbench, addressable by session:<id> only.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['level', 'all'], required: true },
          sessions: { type: 'array', items: LISTED_CARD_SCHEMA, required: true },
          topology_revision: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSessionList(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const call = await openCall(ctx, service, exec, 'matou_list_sessions')
      const scope = args.scope ?? 'level'
      const cards = scope === 'all' ? call.facts.targets : call.level
      return {
        scope,
        sessions: cards.map(card => listedCardOf(card, call.self.sessionId, scope === 'level')),
        topology_revision: call.revision,
      }
    },
  })

  const readRecent = defineTool({
    name: 'matou_read_recent',
    description: describeTool(
      'Read what another card has been doing lately: the newest turns of its outline, each a one-line prompt'
      + ' preview and a short response preview. This never wakes the target and never writes to it, so a card'
      + ' that has been idle for days answers the same as a running one. Use matou_read_history when you need'
      + ' the actual messages. Call matou_list_sessions first if you mean to address a card by ordinal.',
    ),
    parameters: {
      target: { type: 'string', required: true, description: TARGET_DESCRIPTION },
      turns: { type: 'integer', description: 'How many of the newest turns to return. Default 3, maximum 20.' },
      topology_revision: { type: 'string', description: REVISION_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { ...TARGET_REF_SCHEMA, required: true },
          turns: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn: { type: 'integer', required: true },
                seq: { type: 'integer', required: true },
                prompt: { type: 'string', required: true },
                response: { type: 'string', required: true },
              },
            },
          },
          total_turns: { type: 'integer', required: true },
          as_of_seq: { type: 'integer', description: 'The event cursor these previews were folded at.' },
          note: { type: 'string', description: 'Present only when this deployment cannot answer at all.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRecentTurns(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const call = await openCall(ctx, service, exec, 'matou_read_recent')
      const target = resolveArgTarget(call, args)
      const summary = call.facts.summaryOf(target.sessionId)
      const shaped = shapeRecentTurns(turnOutlineOf(summary), args.turns)
      const asOfSeq = summary?.projections?.asOfSeq
      return {
        target: targetRefOf(target),
        turns: [...shaped.turns],
        total_turns: shaped.total_turns,
        ...(asOfSeq === undefined ? {} : { as_of_seq: asOfSeq }),
        ...(shaped.note === undefined ? {} : { note: shaped.note }),
      }
    },
  })

  const readHistory = defineTool({
    name: 'matou_read_history',
    description: describeTool(
      'Read the actual messages of another card — what the user said, what it answered, and what its tools'
      + ' returned — newest last. Reading is side-effect free: it neither wakes the target nor changes its'
      + ' position in the workbench. Long results are trimmed and flagged; page further back with before_seq.',
    ),
    parameters: {
      target: { type: 'string', required: true, description: TARGET_DESCRIPTION },
      max_messages: { type: 'integer', description: 'How many of the newest messages to return. Default 50, maximum 100.' },
      before_seq: { type: 'integer', description: 'Return only messages before this event seq (exclusive), to page backwards.' },
      topology_revision: { type: 'string', description: REVISION_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { ...TARGET_REF_SCHEMA, required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                role: { type: 'string', enum: ['user', 'assistant', 'tool'], required: true },
                text: { type: 'string', required: true },
                truncated: { type: 'boolean', description: 'Present only when this message\'s own text was cut.' },
              },
            },
          },
          has_more: { type: 'boolean', required: true },
          next_before_seq: { type: 'integer', description: 'Pass back as before_seq to read the page before this one.' },
          truncated: { type: 'boolean', required: true },
          as_of_seq: { type: 'integer', required: true, description: 'Last event seq in the cut that was read; -1 for an empty log.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderHistory(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const call = await openCall(ctx, service, exec, 'matou_read_history')
      const target = resolveArgTarget(call, args)
      let observation: ControlObservation
      try {
        observation = await ctx.sessionQuery.observeSession(target.sessionId as SessionId, {
          signal: exec.signal,
          // Reading another card must not make the host fold projections for
          // it; the window is computed from raw events here.
          projectionMode: 'none',
        })
      } catch (error) {
        throw translateHostFailure(error, { action: 'that session could not be read' })
      }
      try {
        const shaped = shapeHistory(observation.events, {
          ...(args.max_messages === undefined ? {} : { maxMessages: args.max_messages }),
          ...(args.before_seq === undefined ? {} : { beforeSeq: args.before_seq }),
        })
        return {
          target: targetRefOf(target),
          messages: shaped.messages.map(message => ({ ...message })),
          has_more: shaped.has_more,
          ...(shaped.next_before_seq === undefined ? {} : { next_before_seq: shaped.next_before_seq }),
          truncated: shaped.truncated,
          as_of_seq: observation.cursor,
        }
      } finally {
        releaseObservation(observation)
      }
    },
  })

  const sendMessage = defineTool({
    name: 'matou_send_message',
    description: describeTool(
      'Send a message to another card as a real user message, prefixed with your own card\'s identity so the'
      + ' target can tell it came from you and not from the person. deliver "now" (the default) cuts into the'
      + ' target\'s current turn, or starts one if it is idle; deliver "after_current_turn" waits and becomes'
      + ' its next turn. There is no way to place text without sending it. Sending counts as user activity, so'
      + ' the target card moves to the front of its level and any ordinal you were holding goes stale.'
      + ' This call confirms delivery only — the answer arrives in the target session, not here.',
    ),
    parameters: {
      target: { type: 'string', required: true, description: TARGET_DESCRIPTION },
      message: { type: 'string', required: true, description: 'The message to deliver. Your identity is prefixed for you.' },
      deliver: {
        type: 'string',
        enum: ['now', 'after_current_turn'],
        description: 'now: steer into the target\'s current turn (default). after_current_turn: queue it as the next turn.',
      },
      topology_revision: { type: 'string', description: REVISION_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          target: { ...TARGET_REF_SCHEMA, required: true },
          deliver: { type: 'string', enum: ['now', 'after_current_turn'], required: true },
          mode: { type: 'string', enum: ['steer', 'queue'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `message delivered to ${value.target.ref} (${labelOf(value.target.title)}), ${value.deliver}`,
      }],
    },
    async execute(args, exec) {
      const call = await openCall(ctx, service, exec, 'matou_send_message')
      const target = resolveArgTarget(call, args)
      const deliver: 'now' | 'after_current_turn' = args.deliver ?? 'now'
      // D-S7-4: 码头's `submit:false` (text parked in the target's input box) has
      // no host-side equivalent in DSH — a draft is browser-local state with no
      // Remote writer — so the pair that DOES exist is the delivery timing
      // (`packages/api/session-controller/src/commands.ts:329-330`).
      const mode: 'queue' | 'steer' = deliver === 'after_current_turn' ? 'queue' : 'steer'
      const text = composeControlMessage(call.self.ref, call.self.title, args.message)
      try {
        await ctx.sessionController.prompt({
          // Minted per call: DSH persists it on the exact accepted user message
          // (`packages/api/session-controller/src/types.ts:302-304`), so reusing
          // one would make two deliveries indistinguishable in the target's log.
          // The WebCrypto global rather than `node:crypto`, so this module needs
          // no Node type dependency; it is present in every runtime a DSH host
          // plugin loads in.
          requestId: globalThis.crypto.randomUUID() as SessionRequestId,
          sessionId: target.sessionId as SessionId,
          mode,
          content: [{ type: 'text', text }],
        }, exec.signal)
      } catch (error) {
        throw translateHostFailure(error, { action: 'the message could not be delivered' })
      }
      return { delivered: true, target: targetRefOf(target), deliver, mode }
    },
  })

  const interruptSession = defineTool({
    name: 'matou_interrupt_session',
    description: describeTool(
      'Stop another card\'s current turn — the same action as the user pressing stop on that card. Anything'
      + ' already queued for it stays queued and the card remains usable. A card that is not running is not'
      + ' interrupted and says so, rather than reporting a success that did nothing.',
    ),
    parameters: {
      target: { type: 'string', required: true, description: TARGET_DESCRIPTION },
      topology_revision: { type: 'string', description: REVISION_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interrupted: { type: 'boolean', required: true },
          target: { ...TARGET_REF_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `interrupt requested for ${value.target.ref} (${labelOf(value.target.title)})`,
      }],
    },
    async execute(args, exec) {
      const call = await openCall(ctx, service, exec, 'matou_interrupt_session')
      const target = resolveArgTarget(call, args)
      // `cancel` never wakes a cold session and is a no-op on an idle agent
      // (`packages/api/session-controller/src/commands.ts:435-442`,
      // `packages/core/agent-loop/src/agent.ts:143-149`), so residency is
      // checked first: reporting success for a card that was not running would
      // be a lie the user cannot see through.
      if (ctx.get('agents')?.get(target.sessionId as SessionId) === undefined) throw controlError('TARGET_NOT_RUNNING')
      try {
        // Byte-for-byte the stop button's path (`packages/api/session-controller/src/index.ts:357-360`
        // → `commands.ts:446`, `agent.cancel({kind:'user'}, {keepInbox:true})`).
        // Going through `ctx.agents` directly would skip the subagent gate and
        // hand out authority §6 never granted.
        ctx.sessionController.cancel({ sessionId: target.sessionId as SessionId })
      } catch (error) {
        throw translateHostFailure(error, {
          action: 'the interrupt could not be requested',
          notFoundAs: 'TARGET_NOT_RUNNING',
        })
      }
      return { interrupted: true, target: targetRefOf(target) }
    },
  })

  return [identifySelf, listSessions, readRecent, readHistory, sendMessage, interruptSession]
}

/**
 * Register the six tools on the host tool registry.
 *
 * Registration is a cordis effect owned by the calling context
 * (`packages/core/tools/src/index.ts:1048-1052`), so unloading the control
 * plugin removes all six; no disposer is kept here, matching how DSH's own
 * tool plugins register (`packages/subagent/tool-subagent-control/src/index.ts:27`).
 * @param ctx - the host services.
 * @param service - the layout service holding the organization document.
 */
export function registerControlTools(ctx: ControlToolsHost, service: WorkbenchOrgSource): void {
  for (const definition of createControlTools(ctx, service)) ctx.tools.register(definition)
}
