/**
 * Selector syntax for the session-control tools: the one place that turns the
 * free-text `target` string a model writes into a discriminated union. Pure
 * string handling — no topology, no IO, no DSH imports. Resolving a parsed
 * selector against the workbench is `resolve.ts`'s job, and the sentence a
 * failure turns into is `errors.ts`'s (`INVALID_TARGET`), which is why parse
 * failures are returned as values rather than thrown.
 *
 * The eight accepted spellings, and where each comes from in 码头:
 *
 * | spelling | selector | 码头 |
 * |---|---|---|
 * | `self` | `{kind:'self'}` | `mt-cli.ts:626` |
 * | `left` / `right` | `{kind:'relative'}` | `mt-cli.ts:627` |
 * | `parent` | `{kind:'relation', relation:'parent'}` | `mt-cli.ts:628` |
 * | `child:N` | `{kind:'relation', relation:'child', ordinal:N}` | `mt-cli.ts:629-630` |
 * | `child` | same, `ordinal` 1 | `host-topology-projector.ts:110` (`selector.ordinal ?? 1`) |
 * | `sibling:N` | `{kind:'sibling', ordinal:N}` | `mt-cli.ts:631-636` |
 * | `session:<id>` | `{kind:'session'}` | wire-only in 码头 (`host-control-types.ts:35`) |
 * | `<session id>` | `{kind:'session'}` | 码头's bare form is `ref`; see below |
 *
 * 码头 has no *string* spelling for a session target at all — its CLI turns a
 * bare token into `{kind:'ref'}` (`mt-cli.ts:640-643`) and only its JSON wire
 * format carries `{kind:'session', sessionId}` (`host-control-server.ts:452-453`).
 * Both of spec §6's last two spellings (稳定引用 / 会话 id) land on the same
 * branch here because in DSH a `ref` *is* `session:<id>`.
 *
 * Three deliberate divergences from 码头, all in the same direction — 码头
 * parses argv, this parses whatever a model typed:
 *
 * - **A bare token is a session id, not a `ref`.** 码头 resolves a bare token
 *   as `{kind:'ref'}` and needs `AMBIGUOUS_TARGET` for it (`mt-cli.ts:640-643`,
 *   `host-control-server.ts:444-446`). Here `ref` *is* `session:<id>` (see
 *   `topology.ts`), so there is no ambiguity left to report.
 * - **Keywords are case-sensitive.** `Left` parses as the session id `Left`
 *   rather than as `left`. Case-folding would let a keyword swallow a real id;
 *   a wrong-case keyword instead fails later with `NOT_IN_WORKBENCH`, which
 *   names the thing that was actually looked up.
 * - **A token with inner whitespace, an empty token, or one over
 *   {@link SELECTOR_MAX_LENGTH} characters is rejected up front** instead of
 *   becoming a nonsense session id. 码头 can't receive those through argv;
 *   a tool argument can. The 160 cap is 码头's own bound on this field
 *   (`host-control-server.ts:453`, `text(target.sessionId, …, 160)`), applied
 *   to characters rather than bytes since this module stays free of `Buffer`.
 *
 * Once a token starts with a `child:` or `sibling:` prefix it is committed to
 * that branch: a malformed ordinal fails loudly instead of falling through to
 * "well, maybe it's a session id called `sibling:abc`".
 * @module dsh-plugin-matou-layout/src/control/selector
 */

/** Which session a control tool call is aimed at, once parsed. */
export type ControlSelector =
  | { readonly kind: 'self' }
  | { readonly kind: 'relative'; readonly direction: 'left' | 'right' }
  | { readonly kind: 'relation'; readonly relation: 'parent' }
  | { readonly kind: 'relation'; readonly relation: 'child'; readonly ordinal: number }
  | { readonly kind: 'sibling'; readonly ordinal: number }
  | { readonly kind: 'session'; readonly sessionId: string }

/**
 * A selector that could not be parsed. `reason` is a full English sentence
 * meant to be read by the calling model — `errors.ts` prefixes it with
 * `INVALID_TARGET` rather than rewording it.
 */
export interface SelectorParseFailure {
  readonly kind: 'invalid'
  readonly reason: string
}

/** Smallest accepted ordinal: selectors are 1-based, like 码头's. */
export const SELECTOR_ORDINAL_MIN = 1
/** Largest accepted ordinal (码头 `host-control-server.ts:471`/`:477`, `boundedInteger(…, 1, 10_000)`). */
export const SELECTOR_ORDINAL_MAX = 10_000
/** Longest accepted selector string (码头 `host-control-server.ts:453`, `text(…, 160)`). */
export const SELECTOR_MAX_LENGTH = 160
/** Ordinal `child` falls back to when written bare (码头 `host-topology-projector.ts:110`). */
export const DEFAULT_CHILD_ORDINAL = 1

/**
 * The syntax summary shown to models — in tool descriptions, in
 * `matou_identify_self`'s reply, and inside every parse failure below.
 * Capability discovery is description-only (no system-prompt injection), so
 * this string is load-bearing rather than documentation.
 */
export const SELECTOR_SYNTAX_HINT =
  'a target is one of: self, left, right, parent, child (or child:N), sibling:N, session:<id>, or a bare session id'

const CHILD_PREFIX = 'child:'
const SIBLING_PREFIX = 'sibling:'
const SESSION_PREFIX = 'session:'
const DECIMAL_ORDINAL = /^\d+$/

function invalid(reason: string): SelectorParseFailure {
  return { kind: 'invalid', reason }
}

/**
 * Parse a decimal ordinal in `[SELECTOR_ORDINAL_MIN, SELECTOR_ORDINAL_MAX]`.
 * Mirrors 码头's `/^…:(\d+)$/` + `Number()` + `Number.isSafeInteger` pair
 * (`mt-cli.ts:629-632`, `:916-919`), so leading zeros read as decimal while
 * signs, decimal points and exponents are rejected outright.
 * @param raw - the text after the `child:` / `sibling:` prefix.
 * @returns the ordinal, or `undefined` when it is not a valid one.
 */
function parseOrdinal(raw: string): number | undefined {
  if (!DECIMAL_ORDINAL.test(raw)) return undefined
  const ordinal = Number(raw)
  if (!Number.isSafeInteger(ordinal)) return undefined
  if (ordinal < SELECTOR_ORDINAL_MIN || ordinal > SELECTOR_ORDINAL_MAX) return undefined
  return ordinal
}

function badOrdinal(keyword: 'child' | 'sibling', raw: string): SelectorParseFailure {
  return invalid(
    `${keyword} needs an ordinal between ${SELECTOR_ORDINAL_MIN} and ${SELECTOR_ORDINAL_MAX}, got ${JSON.stringify(raw)}; ${SELECTOR_SYNTAX_HINT}`,
  )
}

/**
 * Parse one `target` string into a {@link ControlSelector}.
 * @param raw - the target as written by the caller; outer whitespace is trimmed.
 * @returns the parsed selector, or a {@link SelectorParseFailure} carrying a
 *   sentence the caller can hand straight to the model.
 */
export function parseSelector(raw: string): ControlSelector | SelectorParseFailure {
  const token = raw.trim()
  if (token === '') return invalid(`a target is required; ${SELECTOR_SYNTAX_HINT}`)
  if (token.length > SELECTOR_MAX_LENGTH) {
    return invalid(`a target must be at most ${SELECTOR_MAX_LENGTH} characters; ${SELECTOR_SYNTAX_HINT}`)
  }
  if (/\s/.test(token)) {
    return invalid(`${JSON.stringify(token)} is not a target: a target is a single token, not a phrase; ${SELECTOR_SYNTAX_HINT}`)
  }

  if (token === 'self') return { kind: 'self' }
  if (token === 'left' || token === 'right') return { kind: 'relative', direction: token }
  if (token === 'parent') return { kind: 'relation', relation: 'parent' }

  // Bare `child` means the first child (码头 host-topology-projector.ts:110);
  // bare `sibling` has no such default there — its ordinal is required
  // (码头 host-control-server.ts:474-479) — and inventing one would silently
  // aim at whoever currently sorts first in the level.
  if (token === 'child') return { kind: 'relation', relation: 'child', ordinal: DEFAULT_CHILD_ORDINAL }
  if (token === 'sibling') {
    return invalid(`sibling needs an ordinal: write sibling:1 for the first session in this level; ${SELECTOR_SYNTAX_HINT}`)
  }

  if (token.startsWith(CHILD_PREFIX)) {
    const rest = token.slice(CHILD_PREFIX.length)
    const ordinal = parseOrdinal(rest)
    return ordinal === undefined ? badOrdinal('child', rest) : { kind: 'relation', relation: 'child', ordinal }
  }
  if (token.startsWith(SIBLING_PREFIX)) {
    const rest = token.slice(SIBLING_PREFIX.length)
    const ordinal = parseOrdinal(rest)
    return ordinal === undefined ? badOrdinal('sibling', rest) : { kind: 'sibling', ordinal }
  }

  // Strip the prefix exactly once: DSH session ids are `session-<uuid>`
  // (`packages/api/session-controller/src/commands.ts:77`) and never collide
  // with it, but an id that itself contains a colon must survive intact.
  if (token.startsWith(SESSION_PREFIX)) {
    const sessionId = token.slice(SESSION_PREFIX.length)
    return sessionId === ''
      ? invalid(`session: needs a session id after the prefix; ${SELECTOR_SYNTAX_HINT}`)
      : { kind: 'session', sessionId }
  }
  return { kind: 'session', sessionId: token }
}

/**
 * Narrow a {@link parseSelector} result to its failure branch.
 * @param value - whatever `parseSelector` returned.
 * @returns `true` when the target could not be parsed.
 */
export function isSelectorParseFailure(
  value: ControlSelector | SelectorParseFailure,
): value is SelectorParseFailure {
  return value.kind === 'invalid'
}

/**
 * Whether this selector must be accompanied by a topology revision (D-S7-3).
 *
 * The revision exists for exactly one failure mode: **an address computed from
 * a layout that has since changed, silently pointing at somebody else.** Every
 * selector that reads a *position* is exposed to it — `sibling:N` and
 * `child:N` by ordinal, `left` and `right` by offset from the caller's own
 * slot. Identity selectors are not: `self` is me, `parent` is an edge, and
 * `session:<id>` names a session outright, so no reorder can move them.
 *
 * **`left`/`right` were added by the second live walkthrough (2026-09-06), and
 * this is the single most user-visible thing S7 got wrong.** The model was
 * asked to make the right-hand card write a long piece and then to stop it. It
 * sent to `right`, then interrupted `right` — and the two landed on **different
 * cards**. Nothing was buggy in isolation: delivering the message moved the
 * target's 「最近交互」 forward, the level is ordered most-recent-first (spec §3,
 * shared with the carousel so the model's 「第 3 张」 is the user's 「第 3 张」),
 * so the target rose to the front, the caller slid back one slot, and 「我的右
 * 边」 became a different session. The model noticed the two ids disagreed and
 * said so; a less attentive one would have interrupted an innocent card.
 * The plugin's own S7 ledger had recorded 「码头的控制面发消息不计入用户交互，我
 * 们这边计入」 as a known difference without noticing it breaks relative
 * addressing inside a single turn.
 *
 * Gating them costs one `matou_list_sessions` call before the first relative
 * address, and turns the silent mis-hit into {@link CONTROL_ERROR_SENTENCE.STALE_TOPOLOGY},
 * which tells the caller both to re-list and that every receipt already carries
 * the target's `session:<id>` — the stable way to keep talking to the *same*
 * card across a turn.
 *
 * This is stricter than 码头, whose terminal path checks only `ref`/`sibling`
 * (`host-control-types.ts:29-35`) and whose newer structure-action path adds
 * `relation` (`host-action-types.ts:35`) — neither revisions `left`/`right`.
 * 码头 can afford that: its control-plane sends do not count as user
 * interaction, so its layers do not reorder underneath a caller. DSH's do
 * (`updatedAt` advances on any change), so this plugin has to gate what 码头
 * could leave open.
 * @param selector - a parsed selector.
 * @returns `true` for position-addressed selectors.
 */
export function selectorNeedsRevision(selector: ControlSelector): boolean {
  return selector.kind === 'sibling'
    || selector.kind === 'relative'
    || (selector.kind === 'relation' && selector.relation === 'child')
}
