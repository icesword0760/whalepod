/**
 * The **model-facing** text of the four reporting control tools.
 *
 * ## Why this module exists
 *
 * In DSH's `defineTool`, `output.schema` and `output.render` are not two views
 * of the same thing. The schema-shaped value goes to the log, the UI card and
 * `presentationMeta`; **`render` is what the model actually reads** — DSH says
 * so twice, at `packages/core/tools/src/schema.ts:494` ("Pure Native/model
 * rendering of one validated canonical value") and `index.ts:284` ("The final
 * model-facing content"). Four of this plugin's six tools originally rendered a
 * one-line summary of a payload the model never saw:
 *
 * | tool | what the model got | what it needed |
 * |---|---|---|
 * | `matou_list_sessions` | `6 session(s) in scope "level"` | the cards, their ordinals, and `topology_revision` |
 * | `matou_read_recent` | `3 of 8 turn(s) from session:x` | the turns |
 * | `matou_read_history` | `20 message(s) from session:x` | the messages |
 * | `matou_identify_self` | a correct sentence, but no `topology_revision` | the revision too |
 *
 * The third live walkthrough (2026-09-07) caught it: asked to message the card
 * on its right and then stop it, the model called `matou_list_sessions` three
 * times in a row, each time reasoning "the output doesn't show details about
 * sessions or the topology_revision", and never got out of the loop. With
 * `left`/`right` newly gated on the revision (see `selectorNeedsRevision`), a
 * tool that cannot hand the revision over makes positional addressing
 * unusable — and `read_recent` / `read_history` returning only counts means
 * 「看看右边那张在干什么」, the whole point of the read tools, could never work.
 *
 * The 35 tool tests all passed throughout: `control-tools.spec.ts`'s harness
 * asserted only that `render(...)` returned a NON-EMPTY array, and every
 * content assertion was made against the `execute()` value — the object the
 * model does not see. `control-render.spec.ts` exists to test the other half.
 *
 * ## House style
 *
 * DSH's own first-party tools render the full payload as readable text rather
 * than a summary (`packages/web/tool-web/src/search.ts`'s `formatSearchOutput`
 * is the reference). These follow that: one framing line, then the rows, then
 * whatever the model must send back on its next call. Every line names a
 * `session:<id>`, because that is the address that survives a reorder — the
 * lesson of the same walkthrough's earlier finding.
 *
 * Sizes are already bounded upstream by `read.ts`'s per-message and total
 * character budgets, so these functions never truncate on their own; doing it
 * here as well would cut text the budget deliberately kept.
 * @module dsh-plugin-matou-layout/src/control/render
 */

/** A place (workspace / task / scene) as the tools report it. */
interface RenderedPlace {
  readonly title: string
}

/** One card of the caller's own level, as `matou_identify_self` reports it. */
interface RenderedLevelCard {
  readonly ordinal: number
  readonly ref: string
  readonly title: string
  readonly cwd?: string | undefined
  readonly running: boolean
  readonly blank: boolean
  readonly is_self: boolean
}

/** The `matou_identify_self` payload. */
export interface RenderedIdentity {
  readonly ref: string
  readonly title: string
  readonly cwd?: string | undefined
  readonly workspace: RenderedPlace
  readonly task: RenderedPlace
  readonly scene: RenderedPlace
  readonly level_ordinal: number
  readonly level_size: number
  readonly parent_ref?: string | undefined
  readonly child_refs: readonly string[]
  readonly level: readonly RenderedLevelCard[]
  readonly topology_revision: string
  readonly selector_syntax: string
}

/** One card as `matou_list_sessions` reports it; `ordinal` only in the level scope. */
interface RenderedListedCard {
  readonly ordinal?: number | undefined
  readonly ref: string
  readonly title: string
  readonly path: string
  readonly depth: number
  readonly cwd?: string | undefined
  readonly running: boolean
  readonly blank: boolean
  readonly is_self: boolean
}

/** The `matou_list_sessions` payload. */
export interface RenderedSessionList {
  readonly scope: 'all' | 'level'
  readonly sessions: readonly RenderedListedCard[]
  readonly topology_revision: string
}

/** The `matou_read_recent` payload. */
export interface RenderedRecentTurns {
  readonly target: { readonly ref: string; readonly title: string }
  readonly turns: readonly {
    readonly turn: number
    readonly seq: number
    readonly prompt: string
    readonly response: string
  }[]
  readonly total_turns: number
  readonly as_of_seq?: number | undefined
  readonly note?: string | undefined
}

/** The `matou_read_history` payload. */
export interface RenderedHistory {
  readonly target: { readonly ref: string; readonly title: string }
  readonly messages: readonly {
    readonly seq: number
    readonly role: 'assistant' | 'tool' | 'user'
    readonly text: string
    readonly truncated?: boolean | undefined
  }[]
  readonly has_more: boolean
  readonly next_before_seq?: number | undefined
  readonly truncated: boolean
  readonly as_of_seq: number
}

/**
 * A display label for a title the user never set.
 * @param name - the stored title.
 * @returns the name, or a neutral placeholder when it is blank.
 */
function labelOf(name: string): string {
  return name.trim() === '' ? '(untitled)' : name
}

/**
 * The trailing state flags a card line carries, as ` [running, empty]`.
 * @param card - the card.
 * @returns a bracketed list, or the empty string when neither flag is set.
 */
function flagsOf(card: { readonly running: boolean; readonly blank: boolean }): string {
  const flags: string[] = []
  if (card.running) flags.push('running')
  if (card.blank) flags.push('no messages yet')
  return flags.length === 0 ? '' : ` [${flags.join(', ')}]`
}

/**
 * One row of a card listing. The `session:<id>` comes first on every row
 * because it is the address that survives a reorder.
 * @param prefix - the ordinal selector for this row, or `''` when the scope has no ordinals.
 * @param card - the card.
 * @returns the row, without a trailing newline.
 */
function cardRow(prefix: string, card: RenderedLevelCard | RenderedListedCard): string {
  const head = prefix === '' ? `  ${card.ref}` : `  ${prefix}  ${card.ref}`
  const cwd = card.cwd === undefined || card.cwd === '' ? '' : `  in ${card.cwd}`
  return `${head}  ${labelOf(card.title)}${card.is_self ? '  <- you' : ''}${flagsOf(card)}${cwd}`
}

/**
 * Render `matou_identify_self` for the model.
 * @param value - the payload.
 * @returns the text the model reads.
 */
export function renderIdentity(value: RenderedIdentity): string {
  const lines = [
    `you are ${value.ref} (${labelOf(value.title)}), card ${value.level_ordinal} of ${value.level_size}`
    + ` in ${labelOf(value.workspace.title)} / ${labelOf(value.task.title)} / ${labelOf(value.scene.title)}.`,
  ]
  if (value.cwd !== undefined && value.cwd !== '') lines.push(`your working directory: ${value.cwd}`)
  lines.push(
    value.parent_ref === undefined
      ? 'parent: none — you are on the top level of this scene.'
      : `parent: ${value.parent_ref}`,
  )
  lines.push(
    value.child_refs.length === 0
      ? 'children: none'
      : `children (${value.child_refs.length}): ${value.child_refs.map((ref, i) => `child:${i + 1} ${ref}`).join(', ')}`,
  )
  lines.push('your level, left to right:')
  for (const card of value.level) lines.push(cardRow(`sibling:${card.ordinal}`, card))
  lines.push(`topology_revision: ${value.topology_revision}`)
  lines.push(value.selector_syntax)
  return lines.join('\n')
}

/**
 * Render `matou_list_sessions` for the model.
 * @param value - the payload.
 * @returns the text the model reads.
 */
export function renderSessionList(value: RenderedSessionList): string {
  const count = value.sessions.length
  const lines: string[] = []
  if (value.scope === 'level') {
    lines.push(count === 0
      ? 'no cards in your level — you are not currently placed in the workbench.'
      : count === 1
        ? '1 card in your level (only you):'
        : `${count} cards in your level, left to right:`)
    for (const card of value.sessions) {
      lines.push(cardRow(card.ordinal === undefined ? '' : `sibling:${card.ordinal}`, card))
    }
    lines.push(`topology_revision: ${value.topology_revision}`)
    lines.push(
      'Send that revision back with left, right, sibling:N and child:N.'
      + ' To keep acting on one card across several calls, address it as session:<id> instead —'
      + ' cards reorder as they are used, including because of a message you just sent.',
    )
    return lines.join('\n')
  }
  lines.push(count === 0
    ? 'no cards in this workbench.'
    : `${count} card(s) in this workbench. Ordinals have no meaning outside your own level,`
      + ' so address these by session:<id>; call this again with scope "level" for the cards beside you.')
  for (const card of value.sessions) lines.push(`${cardRow('', card)}  — ${card.path}, depth ${card.depth}`)
  return lines.join('\n')
}

/**
 * Render `matou_read_recent` for the model.
 * @param value - the payload.
 * @returns the text the model reads.
 */
export function renderRecentTurns(value: RenderedRecentTurns): string {
  const who = `${value.target.ref} (${labelOf(value.target.title)})`
  if (value.note !== undefined) return `${who}: ${value.note}`
  if (value.turns.length === 0) return `${who} has no turns yet.`
  const lines = [`the newest ${value.turns.length} of ${value.total_turns} turn(s) from ${who}:`]
  for (const turn of value.turns) {
    lines.push(`turn ${turn.turn} (seq ${turn.seq}):`)
    lines.push(`  asked: ${turn.prompt}`)
    lines.push(`  replied: ${turn.response}`)
  }
  return lines.join('\n')
}

/**
 * Render `matou_read_history` for the model.
 * @param value - the payload.
 * @returns the text the model reads.
 */
export function renderHistory(value: RenderedHistory): string {
  const who = `${value.target.ref} (${labelOf(value.target.title)})`
  if (value.messages.length === 0) return `${who} has no messages in this window.`
  const more = value.has_more && value.next_before_seq !== undefined
    ? ` More history exists before this window — call again with before_seq=${value.next_before_seq}.`
    : ''
  const lines = [`${value.messages.length} message(s) from ${who}, oldest first.${more}`]
  for (const message of value.messages) {
    lines.push(`#${message.seq} ${message.role}: ${message.text}${message.truncated === true ? ' […truncated]' : ''}`)
  }
  return lines.join('\n')
}
