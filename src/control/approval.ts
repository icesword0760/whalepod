/**
 * The approval gate in front of the two session-control tools that change
 * something. One `tools/pre-execute` listener, and nothing else — D-1.
 *
 * **Why a listener at all.** In DSH a tool is gated only here: `ToolDefinition`
 * carries no declarative "needs approval" field
 * (`packages/core/tools/src/index.ts:214-280`), so a plugin that registers no
 * listener has silently declared its tools free. For `matou_send_message` and
 * `matou_interrupt_session` — which put words into another session's log and
 * stop another session's turn — that default is wrong. This module contributes
 * exactly one fact ("these two have an effect") and nothing more: no dialog of
 * its own, no rate limit, no hop counter, no "you are being controlled" marker.
 * Whether the user is asked, what the card looks like, and the durable
 * `approval/asked` + `approval/decided` audit pair
 * (`packages/interaction/user-approval/src/index.ts:207-226`) are all DSH's.
 *
 * **The rule, and why it is not symmetric (D-1).** The default permission
 * preset asks; the FULL-ACCESS preset is let through. That is a product
 * decision — "the more permission you grant, the smoother it gets" — and it is
 * also the only rule that functions, because DSH's `'never'` policy means
 * *decided: no*, not *unattended: yes*. `ApprovalService.decide` returns
 * `'rejected'` for a `'never'` session BEFORE dispatching to any answerer or
 * listener (`packages/interaction/user-approval/src/index.ts:258-266`), and the
 * registry turns that into `{kind:'deny'}`
 * (`packages/core/tools/src/index.ts:1705-1708`). So returning `ask` under
 * `danger-full-access` (`sandbox: 'danger-full-access', approval: 'never'` —
 * `packages/interaction/permission-presets/src/index.ts:175-178`) would not
 * raise a prompt; it would make both tools fail 100% of the time in the very
 * preset the user chose to remove friction. `tests/control-approval.spec.ts`
 * pins this; do not "restore symmetry" between the two branches.
 *
 * **Why the policy is read from `ctx.approval` and not `ctx.permissionPresets`.**
 * The expression below is `permission-presets`' own
 * (`packages/interaction/permission-presets/src/index.ts:315`), but the service
 * around it is not usable here: `current(session)` folds in
 * `ctx.shell.sandboxMode` (`:314`) and throws outright when the permissions
 * session projection is not registered (`:295-299`). D-1 is written about the
 * *effective approval policy*, which is the same knob the execution path reads
 * — so this reads that knob directly, through the two public members
 * `overrideOf` (`packages/interaction/user-approval/src/index.ts:244-250`, a
 * reverse scan for the session's last `approval/policy` event) and `config`
 * (`:147`).
 *
 * **Composition notes.** The listener is registered without `{prepend: true}`:
 * there is nothing to observe ahead of other gates, and a waterfall wraps
 * outer-around-inner, so the default registration order is right. Returning
 * `ask` does not call `next()`, which vetoes the rest of the chain — the same
 * shape DSH's own hook bridge uses
 * (`packages/hooks/hooks-claude-code/src/index.ts:239-244`). Registration is an
 * effect of the calling fiber, so it unbinds when the control plugin unloads,
 * exactly like the tool registrations it guards. The decision is synchronous;
 * if it ever grows an await, that await must observe `exec.signal`
 * (`packages/core/tools/src/index.ts:136-139`).
 * @module dsh-plugin-matou-layout/src/control/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { CONTROL_SIDE_EFFECT_TOOL_NAMES } from './tools.ts'

/** One of the two tools this gate covers. */
export type ControlSideEffectToolName = (typeof CONTROL_SIDE_EFFECT_TOOL_NAMES)[number]

/** DSH's two approval policies (`packages/interaction/user-approval/src/index.ts:59`). */
export type ControlApprovalPolicy = 'ask' | 'never'

/**
 * What the approval card says for each tool, and the only text this module
 * contributes to a human decision.
 *
 * Written for the person looking at the prompt, so each one names the effect
 * rather than the mechanism, and the two are deliberately different sentences:
 * "deliver a message" and "stop a turn" are different acts and the card has to
 * tell them apart. The caller's own `target` argument is NOT interpolated —
 * DSH already shows the arguments next to this text, and model-authored text
 * has no business inside the sentence the user is deciding on.
 *
 * This table doubles as the gate's membership test: a tool with no entry is
 * not this gate's business.
 */
export const CONTROL_APPROVAL_REASON: Readonly<Record<ControlSideEffectToolName, string>> = Object.freeze({
  matou_send_message:
    'This delivers a message into another session card in this workbench, as a real user turn in that session.',
  matou_interrupt_session:
    'This stops the turn another session card in this workbench is currently running.',
})

/**
 * The approval service, narrowed to the two members D-1 reads.
 * {@link ControlApprovalServiceIsNarrowerThanDsh} proves the real one fits.
 */
export interface ControlApprovalService {
  /** The session's last logged `approval/policy` override, without the deployment default applied. */
  overrideOf(session: unknown): ControlApprovalPolicy | undefined
  /** The deployment default, absent when the service was composed without one. */
  readonly config: { readonly policy?: ControlApprovalPolicy }
}

/**
 * The host slice this gate touches: one listener registration and one
 * opportunistic service lookup.
 *
 * `approval` is looked up with `get` rather than injected on purpose — a
 * deployment may compose no approval service at all, and the right behaviour
 * there is to let the call through, not to leave the whole control plane
 * pending on a service it can live without.
 */
export interface ControlApprovalHost {
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): () => boolean
  get(name: 'approval'): ControlApprovalService | undefined
}

/** Errors if `Actual` is not assignable to `Expected`; the alias itself is erased. */
type AssertAssignable<Actual extends Expected, Expected> = Actual

/**
 * Compile-time proof that a real cordis context satisfies {@link ControlApprovalHost}.
 * Exported so `noUnusedLocals` keeps it and a DSH signature change breaks the
 * build here rather than at runtime.
 */
export type ControlApprovalHostIsNarrowerThanDsh = AssertAssignable<Context, ControlApprovalHost>

/**
 * The same proof for the service itself, which the host proof cannot give:
 * `ctx.get()` is typed `any`, so without this line a rename of `overrideOf` or
 * `config` would compile here and fail as a silently ungated tool at runtime.
 */
export type ControlApprovalServiceIsNarrowerThanDsh = AssertAssignable<ApprovalService, ControlApprovalService>

/**
 * The reason this gate has for one tool name, or `undefined` when the name is
 * not one of the two.
 *
 * `Object.hasOwn` rather than a plain lookup: tool names are arbitrary strings,
 * and `CONTROL_APPROVAL_REASON['toString']` would otherwise hand back an
 * inherited function — gating a foreign tool with a reason that is not a string.
 * @param name - the tool being called.
 * @returns the approval-card sentence, or `undefined` for every other tool.
 */
function approvalReasonOf(name: string): string | undefined {
  if (!Object.hasOwn(CONTROL_APPROVAL_REASON, name)) return undefined
  return CONTROL_APPROVAL_REASON[name as ControlSideEffectToolName]
}

/**
 * Decide one pending call. See the module doc for why each branch delegates.
 * @param ctx - the host, for the opportunistic approval lookup.
 * @param exec - the pending call.
 * @param next - the rest of the waterfall, ending in the registry's own allow.
 * @returns the decision, `ask` only under an asking policy.
 */
function decideControlApproval(
  ctx: ControlApprovalHost,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  // First, and by exact name. This listener sits on the host plane, so it sees
  // every tool call in the process; anything looser than an exact match on the
  // two names would put this plugin in front of bash and every first-party
  // tool. The four read-only tools fall out here too — reading a card is not
  // an effect, and a prompt per read would make the surface unusable.
  const reason = approvalReasonOf(exec.name)
  if (reason === undefined) return next()
  // No calling session means no policy to read, and an `ask` would degrade to
  // a deny about message routing (`packages/core/tools/src/index.ts:1690-1695`)
  // — which tells the model nothing. The tool body raises the honest error.
  const session = exec.agent?.session
  if (session === undefined) return next()
  // A deployment with no approval service turns every `ask` into a deny
  // (`packages/core/tools/src/index.ts:1674-1680`), so asking there would
  // break these two tools instead of protecting anything.
  const approval = ctx.get('approval')
  if (approval === undefined) return next()
  const policy = approval.overrideOf(session) ?? approval.config.policy ?? 'ask'
  // D-1, the asymmetric half: `'never'` is a decided rejection, not an absent
  // user. See the module doc — asking here fails the call, every time.
  if (policy === 'never') return next()
  return Promise.resolve<PreToolDecision>({ kind: 'ask', reason })
}

/**
 * Attach the gate to one context.
 *
 * The disposer `ctx.on` returns is deliberately dropped: the listener is a
 * cordis effect of the calling fiber and unwinds with it, which is how DSH's
 * own gate registers (`packages/hooks/hooks-claude-code/src/index.ts:239`) and
 * how this plugin registers its tools.
 * @param ctx - the control plugin's context.
 */
export function registerControlApprovalPolicy(ctx: ControlApprovalHost): void {
  ctx.on('tools/pre-execute', (exec, next) => decideControlApproval(ctx, exec, next))
}
