/**
 * The one place a control-plane message body is assembled. Pure string work —
 * no cordis, no IO, no DSH runtime import.
 *
 * Why a prefix at all: `SessionController.prompt` hard-codes the message source
 * as `{ kind: 'user' }` (`packages/api/session-controller/src/commands.ts:308-312`),
 * so a message this plugin sends on one Agent's behalf lands in the target's log
 * indistinguishable from something the human typed. Since the source field
 * cannot carry the truth, the body must: every control-plane message says who
 * sent it, in-band, on its first line.
 *
 * The prefix is assembled here by the host and is NOT a tool parameter — a model
 * can neither drop it nor forge a different sender.
 * @module dsh-plugin-matou-layout/src/control/compose
 */

/**
 * Prefix one message body with its sending card's identity.
 *
 * Shape: `[from session:<id> (<title>)] <body>`, degrading to
 * `[from session:<id>] <body>` when the sender has no title yet (a brand-new
 * card has `''` until DSH names it). The title's own whitespace is collapsed so
 * the prefix always stays on one line; the body is passed through verbatim —
 * no escaping, no trimming, no wrapping — because it is the message.
 * @param fromRef - the sending session's control-plane ref, already in `session:<id>` form.
 * @param fromTitle - the sending session's title; `''` or whitespace degrades the prefix.
 * @param body - the message text to deliver, used exactly as given.
 * @returns the prefixed message body.
 */
export function composeControlMessage(fromRef: string, fromTitle: string, body: string): string {
  const title = fromTitle.replace(/\s+/gu, ' ').trim()
  const prefix = title === '' ? `[from ${fromRef}]` : `[from ${fromRef} (${title})]`
  return `${prefix} ${body}`
}
