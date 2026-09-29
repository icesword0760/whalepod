/**
 * Selector resolution: which session a parsed {@link ControlSelector} actually
 * names, given the projection and who is asking. Pure — no cordis, no IO, no
 * DSH import; the host layer fetches the facts, this decides.
 *
 * **The addressable sets are exactly two.** `left` / `right` / `sibling:N` read
 * {@link levelOf} (the caller's own layer, INCLUDING the caller), `child:N`
 * reads {@link childrenOf}. Both come from `topology.ts`, which is the same
 * ordering the carousel renders — the product promise being that 「AI 说『第 3
 * 个会话』必须与用户看到的第 3 个一致」. `parent` and `session:<id>` address by
 * identity and so are not indexed at all.
 *
 * **`sibling:N` counts the caller.** 码头 does the same: its sibling group is
 * every target sharing a canvas and a `parentRef`, the caller included, indexed
 * `siblings[ordinal - 1]` (`apps/runtime/src/control/host-topology-projector.ts:89-94`).
 * So `sibling:2` for the middle card of three IS the caller. That is what the
 * user sees when they count cards on screen, and counting differently would put
 * the model's numbering half a step out of phase with the user's.
 *
 * **Order of judgement**, and why each step comes where it does:
 *
 * 1. **Is the caller a card at all?** 码头 asks this first too, before looking
 *    at the selector (`host-topology-projector.ts:71-74`). A subagent caller
 *    stops here — it has no position, so no relative selector means anything
 *    for it (the 结构性空洞 section of the plan).
 * 2. **Is the revision current?** Only for position-bearing selectors
 *    ({@link selectorNeedsRevision} — `left`, `right`, `sibling:N`, `child:N`),
 *    and BEFORE the position is used — 码头 likewise gates in the server ahead
 *    of resolution (`host-control-server.ts:361-365`). A missing revision and a
 *    wrong one are the same failure with the same sentence: in both cases the
 *    caller is addressing by a position it cannot prove is still current. The
 *    reason `left`/`right` are in that set is the walkthrough recorded on
 *    `selectorNeedsRevision`: a caller's own message reorders the level under
 *    it, so 「我的右边」 silently becomes a different card mid-turn.
 * 3. **Then the selector.** By this point every failure left is a real absence:
 *    an edge of a level, a root with no parent, an ordinal past the end.
 *
 * The revision is recomputed here from the two sets rather than taken as an
 * argument, so the number the caller is checked against is by construction the
 * one this module would index — there is no way for a tool to hand out one
 * revision and resolve against another.
 * @module dsh-plugin-matou-layout/src/control/resolve
 */

import { controlError } from './errors.ts'
import { topologyRevision } from './revision.ts'
import { selectorNeedsRevision } from './selector.ts'
import type { ControlSelector } from './selector.ts'
import { childrenOf, levelOf } from './topology.ts'
import type { ControlTarget } from './topology.ts'

export interface ResolveTargetInput {
  /** The session making the call; DSH infers it from `exec.agent.session.id`, it is never self-reported. */
  readonly callerSessionId: string
  /** The parsed selector. Parse failures are `INVALID_TARGET` and never reach here. */
  readonly selector: ControlSelector
  /** The projection, from `projectControlTargets`. */
  readonly targets: readonly ControlTarget[]
  /** The `topology_revision` the caller sent back, if any; required for ordinal selectors only. */
  readonly revision?: string | undefined
  /**
   * Sessions known to be subagent children. Deliberately a SEPARATE input
   * rather than entries in `targets`: subagents are not workbench cards and
   * must stay unaddressable by every relative selector. This set exists only so
   * that a caller who guesses a bare subagent id gets told what it hit instead
   * of the generic "not in this workbench".
   */
  readonly subagentSessionIds?: ReadonlySet<string> | undefined
}

/** What a successful resolution yields: an id the host layer can act on. */
export interface ResolvedTarget {
  readonly sessionId: string
}

/**
 * English count of cards, for the sentences below.
 * @param count - how many.
 * @returns e.g. `1 card` / `3 cards`.
 */
function cards(count: number): string {
  return count === 1 ? '1 card' : `${count} cards`
}

/**
 * English count of child sessions.
 * @param count - how many.
 * @returns e.g. `1 child session` / `2 child sessions`.
 */
function childSessions(count: number): string {
  return count === 1 ? '1 child session' : `${count} child sessions`
}

const CALLER_NOT_A_CARD =
  'you are not a card in this workbench, so there is nothing to your left, to your right, above or below you;'
  + ' only sessions that appear as workbench cards can address one another.'

/**
 * Resolve one selector against the projection.
 * @param input - who is asking, what they asked for, and the facts to answer from.
 * @returns the session the selector names.
 * @throws a `controlError` — `NOT_IN_WORKBENCH`, `NO_SUCH_NEIGHBOUR`, `STALE_TOPOLOGY` or `TARGET_IS_SUBAGENT` — carrying a sentence the model can act on.
 */
export function resolveTarget(input: ResolveTargetInput): ResolvedTarget {
  const { callerSessionId, selector, targets } = input
  const self = targets.find(target => target.sessionId === callerSessionId)
  if (self === undefined) throw controlError('NOT_IN_WORKBENCH', CALLER_NOT_A_CARD)

  const level = levelOf(targets, callerSessionId)
  const children = childrenOf(targets, callerSessionId)
  if (selectorNeedsRevision(selector)) {
    const current = topologyRevision(level.map(target => target.ref), children.map(target => target.ref))
    if (input.revision !== current) throw controlError('STALE_TOPOLOGY')
  }

  if (selector.kind === 'self') return { sessionId: self.sessionId }

  if (selector.kind === 'session') {
    const hit = targets.find(target => target.sessionId === selector.sessionId)
    if (hit !== undefined) return { sessionId: hit.sessionId }
    // A real card wins over the subagent set: the two can only overlap if the
    // host facts disagree with themselves, and in that case the card the user
    // can see is the truth.
    if (input.subagentSessionIds?.has(selector.sessionId) === true) throw controlError('TARGET_IS_SUBAGENT')
    throw controlError(
      'NOT_IN_WORKBENCH',
      `session ${selector.sessionId} is not a card in this workbench;`
      + ' call matou_list_sessions to see the cards you can reach.',
    )
  }

  if (selector.kind === 'relative') {
    // The caller is always in its own level, so the index is never -1.
    const index = level.findIndex(target => target.sessionId === callerSessionId)
    const neighbour = level[index + (selector.direction === 'left' ? -1 : 1)]
    if (neighbour !== undefined) return { sessionId: neighbour.sessionId }
    const edge = selector.direction === 'left' ? 'leftmost' : 'rightmost'
    throw controlError(
      'NO_SUCH_NEIGHBOUR',
      `there is no session to your ${selector.direction}: you are the ${edge} of ${cards(level.length)}`
      + ' in this level; call matou_list_sessions to see the level you are in.',
    )
  }

  if (selector.kind === 'sibling') {
    const hit = level[selector.ordinal - 1]
    if (hit !== undefined) return { sessionId: hit.sessionId }
    throw controlError(
      'NO_SUCH_NEIGHBOUR',
      `there is no session number ${selector.ordinal} in your level: the level holds ${cards(level.length)},`
      + ' numbered from 1 and including you; call matou_list_sessions to see them.',
    )
  }

  if (selector.relation === 'parent') {
    if (self.parentRef === undefined) {
      throw controlError(
        'NO_SUCH_NEIGHBOUR',
        'you have no parent session: you are already on the top level of this scene;'
        + ' call matou_list_sessions to see the level you are in.',
      )
    }
    const parent = targets.find(target => target.ref === self.parentRef)
    if (parent !== undefined) return { sessionId: parent.sessionId }
    // Unreachable from a coherent projection — a target only carries a
    // `parentRef` because the walk descended through that parent — but the
    // projection is an argument here, so the branch stays rather than being an
    // assertion that would surface as a stack trace.
    throw controlError(
      'NOT_IN_WORKBENCH',
      `your parent ${self.parentRef} is no longer a card in this workbench;`
      + ' call matou_list_sessions to see where you are now.',
    )
  }

  const child = children[selector.ordinal - 1]
  if (child !== undefined) return { sessionId: child.sessionId }
  throw controlError(
    'NO_SUCH_NEIGHBOUR',
    `you have no child number ${selector.ordinal}: ${children.length === 0
      ? 'you have no child sessions at all'
      : `you have ${childSessions(children.length)}`};`
    + ' call matou_list_sessions to see them.',
  )
}
