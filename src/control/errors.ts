/**
 * The seven ways a session-control call can fail, and the English sentence
 * each one says. Pure data plus one factory — no cordis, no IO, no DSH import.
 *
 * **Why sentences rather than codes.** The only consumer of these failures is
 * a language model that has to correct itself and then tell the user what
 * happened, in the same turn, without a second round trip. A bare
 * `NO_SUCH_NEIGHBOUR` gives it nothing to act on; "there is no session to your
 * left: you are the leftmost of 3 cards in this level" tells it both what is
 * true and what to say. So every sentence here names **what went wrong** and
 * **what to do next** — the next step is usually a tool to call
 * ({@link CONTROL_ERROR_SENTENCE.STALE_TOPOLOGY} is the archetype). The code is
 * kept as a machine-readable prefix so `tools.ts` can branch and tests can
 * assert without matching prose.
 *
 * **Shape.** `message` is `<CODE>: <sentence>`; `code` is the same string as a
 * property. That mirrors 码头's `ControlFault`, which carries `code` next to a
 * free-text `message` (`apps/runtime/src/control/host-control-server.ts:171-183`)
 * and re-detects it on the way out by checking that property against a frozen
 * list (`:605-609`) — {@link isControlError} is the same check.
 *
 * **Why these seven and not 码头's nineteen.** 码头's list
 * (`host-control-server.ts:627-632`) covers a whole UNIX-socket RPC surface:
 * transport (`INVALID_REQUEST`, `TIMEOUT`, `INTERNAL_ERROR`), capability tokens
 * (`CAPABILITY_DENIED`), a confirmation dialog (`CONFIRMATION_*`), and
 * structural operations this plugin deliberately does not offer (`PATH_CONFLICT`,
 * `BRANCH_CONFLICT`). Here the transport is DSH's own tool call, permission is
 * DSH's native approval, and there is no confirmation step by design — so what
 * is left is addressing (four codes), the two subagent/idle facts a caller
 * cannot see for itself, and startup. Two 码头 codes have no counterpart on
 * purpose: `AMBIGUOUS_TARGET` cannot arise because a DSH `ref` *is*
 * `session:<id>` (see `selector.ts`), and `TARGET_NOT_READY` cannot either
 * because a cold DSH session answers reads without being woken.
 * @module dsh-plugin-matou-layout/src/control/errors
 */

import { SELECTOR_SYNTAX_HINT } from './selector.ts'

/** Every way a session-control call can fail. */
export type ControlErrorCode =
  /** The `target` string was not a selector this plugin understands. */
  | 'INVALID_TARGET'
  /** The caller, or the session it named, is not a card in the workbench. */
  | 'NOT_IN_WORKBENCH'
  /** The position exists as a selector but holds no session (edge of a level, no parent, ordinal past the end). */
  | 'NO_SUCH_NEIGHBOUR'
  /** An ordinal was used with a missing or outdated topology revision. */
  | 'STALE_TOPOLOGY'
  /** The named session is a subagent child, which this control surface does not cover. */
  | 'TARGET_IS_SUBAGENT'
  /** Nothing to interrupt: the target has no live turn. */
  | 'TARGET_NOT_RUNNING'
  /** The plugin's own organization document is not readable yet. */
  | 'WORKBENCH_NOT_READY'

/** The codes, in the order they are documented. Frozen so it can be exported to tests as-is. */
export const CONTROL_ERROR_CODES: readonly ControlErrorCode[] = Object.freeze([
  'INVALID_TARGET',
  'NOT_IN_WORKBENCH',
  'NO_SUCH_NEIGHBOUR',
  'STALE_TOPOLOGY',
  'TARGET_IS_SUBAGENT',
  'TARGET_NOT_RUNNING',
  'WORKBENCH_NOT_READY',
])

/**
 * The sentence each code says when the caller has nothing more specific to add.
 *
 * A caller that DOES know more — which direction was empty, how many cards the
 * level actually holds — passes a `detail` to {@link controlError} instead, and
 * that detail must itself be a whole sentence carrying both halves (what went
 * wrong, what to do next), because it replaces the one below rather than
 * extending it. `resolve.ts` builds those; nothing else may.
 */
export const CONTROL_ERROR_SENTENCE: Readonly<Record<ControlErrorCode, string>> = Object.freeze({
  INVALID_TARGET: `that target does not name anything in this workbench; ${SELECTOR_SYNTAX_HINT}.`,
  NOT_IN_WORKBENCH:
    'that session is not a card in this workbench, so it cannot be addressed from here;'
    + ' call matou_list_sessions to see the cards you can reach.',
  NO_SUCH_NEIGHBOUR:
    'there is no session in that position; call matou_list_sessions to see which cards are actually around you.',
  // From the plan (D-S7-3): a missing revision and a stale one say the same
  // thing on purpose, because the fix is the same and the caller cannot tell
  // the two apart anyway. The second sentence is the 2026-09-06 walkthrough's
  // (see `selectorNeedsRevision`): re-listing alone gets the caller a correct
  // address, but it does NOT get them back the card they were just talking to,
  // because the reorder is usually their own message's doing. Naming the id is
  // the only way to stay on one card across a turn, and every receipt and every
  // relayed reply already carries it.
  STALE_TOPOLOGY:
    'the card order changed, so a position (left, right, sibling:N, child:N) may no longer mean the same session;'
    + ' call matou_list_sessions again for the current order and topology_revision.'
    + ' To keep acting on the SAME card across several calls, address it as session:<id>'
    + ' — every reply and delivery receipt names the id it came from.',
  // Verbatim from 设计稿 §S7「子代理拥有的会话直接拒绝并提示改用子代理工具」.
  // The two tool names are the OFFICIAL agent-scoped ones, which is precisely
  // why this plugin's own tools carry a `matou_` prefix instead of reusing them.
  TARGET_IS_SUBAGENT:
    'that session is a subagent child; use your own `send_message` / `interrupt_agent` tools for it'
    + ' — this workbench control surface only covers workbench cards.',
  // Verbatim from the plan (D-S7-6). `cancel` is a no-op on an idle agent
  // (`packages/core/agent-loop/src/agent.ts:143-149`), so saying this is the
  // only honest answer — reporting success would be a lie.
  TARGET_NOT_RUNNING: 'the target has no running turn; nothing to interrupt.',
  WORKBENCH_NOT_READY:
    'the workbench layout is not readable yet; wait a moment and call matou_identify_self again.',
})

/** An {@link Error} carrying one of the seven codes. */
export interface ControlError extends Error {
  readonly code: ControlErrorCode
}

/**
 * Build a control-plane failure.
 * @param code - which failure this is; becomes both the `code` property and the message prefix.
 * @param detail - a complete replacement sentence naming what went wrong and what to do next; omit to use {@link CONTROL_ERROR_SENTENCE}.
 * @returns the error, ready to throw.
 */
export function controlError(code: ControlErrorCode, detail?: string): ControlError {
  const error = new Error(`${code}: ${detail ?? CONTROL_ERROR_SENTENCE[code]}`) as Error & { code: ControlErrorCode }
  error.name = 'ControlError'
  error.code = code
  return error
}

/**
 * Whether a caught value is one of this module's failures.
 *
 * `tools.ts` needs this to tell "already a sentence the model can read" from
 * "a DSH `RemoteError` that must be translated before it reaches the model".
 * The check is 码头's (`host-control-server.ts:605-609`): an `Error` whose
 * `code` is in the frozen list — never a bare duck-typed object, so a tool
 * result that happens to carry a `code` field cannot impersonate one.
 * @param value - a caught value.
 * @returns `true` when it is a control error.
 */
export function isControlError(value: unknown): value is ControlError {
  return value instanceof Error
    && CONTROL_ERROR_CODES.includes((value as Error & { code?: unknown }).code as ControlErrorCode)
}
